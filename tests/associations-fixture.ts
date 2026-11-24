import { randomUUID } from "node:crypto"
import type { CatalogueEntry, Command, Profile, PromotionCommand } from "@/associations/contract"
import { createPromotionService, type Promotion, type PromotionStore } from "@/associations/promotions"
import { createAssociationService, type Mail, type Record, type Store, type Viewer } from "@/associations/service"

export const owner: Viewer = { sub: "owner", name: "Owner", email: "owner@example.org", operator: false }
export const staff: Viewer = { sub: "staff", name: "Staff", operator: true }
export const outsider: Viewer = { sub: "outsider", name: "Outsider", operator: false }
export const profile: Profile = {
  name: "Association",
  acronym: "A",
  descriptionIt: "Descrizione",
  descriptionEn: "Description",
  email: "info@example.org",
  logo: null,
  links: [{ platform: "telegram", label: "Canale", url: "https://t.me/example" }],
  programmes: [],
  campuses: [],
  crossProgramme: false,
  contacts: [],
}
export const programme = "didattica.ingegneria-industriale-informazione.triennale.ingegneria-informatica"
export function seedCatalogue(): CatalogueEntry[] {
  return [
    {
      kind: "programme",
      slug: programme,
      nameIt: "Ingegneria Informatica",
      nameEn: "Computer Engineering",
      active: true,
    },
    {
      kind: "programme",
      slug: "didattica.design.triennale.design-della-moda",
      nameIt: "Design della Moda",
      nameEn: "Fashion Design",
      active: false,
    },
    { kind: "campus", slug: "leonardo", nameIt: "Milano Leonardo", nameEn: "Milan Leonardo", active: true },
    { kind: "campus", slug: "bovisa", nameIt: "Milano Bovisa", nameEn: "Milan Bovisa", active: true },
  ]
}
export function harness() {
  const rows = new Map<string, Record>()
  const creation = new Map<string, string>()
  const mails: Mail[] = []
  const catalogue = seedCatalogue()
  const store: Store = {
    catalogue: async () => structuredClone(catalogue),
    async saveCatalogue(entry) {
      const index = catalogue.findIndex((e) => e.kind === entry.kind && e.slug === entry.slug)
      if (index >= 0) catalogue[index] = entry
      else catalogue.push(entry)
    },
    list: async () => structuredClone([...rows.values()]),
    get: async (id) => structuredClone(rows.get(id) ?? null),
    byInvitation: async (hash) =>
      structuredClone([...rows.values()].find((r) => r.invitations.some((i) => i.hash === hash)) ?? null),
    published: async () => structuredClone([...rows.values()].filter((r) => r.registered && r.published)),
    recentAccessRequests: async (sub, since) =>
      [...rows.values()]
        .flatMap((r) => r.requests)
        .filter((q) => q.by === sub && q.kind === "access" && q.createdAt > since).length,
    async create(r, command, actor) {
      const key = `${actor}:${command}`
      if (creation.has(key)) return creation.get(key)!
      rows.set(r.id, structuredClone(r))
      creation.set(key, r.id)
      return r.id
    },
    async change(id, fn) {
      const r = structuredClone(rows.get(id)!)
      const mail: Mail[] = []
      const result = fn(r, mail)
      rows.set(id, r)
      mails.push(...mail)
      return result
    },
    async transfer(from, to, fn) {
      const a = structuredClone(rows.get(from)!)
      const b = structuredClone(rows.get(to)!)
      const result = fn(a, b)
      rows.set(from, a)
      rows.set(to, b)
      return result
    },
  }
  const service = createAssociationService(store, "https://admin.example.org")
  async function command(
    v: Viewer,
    id: string,
    action: Command extends infer T ? (T extends Command ? Omit<T, "id" | "revision" | "commandId"> : never) : never
  ) {
    return service.command(v, { ...action, id, revision: rows.get(id)!.revision, commandId: randomUUID() } as Command)
  }
  async function registered() {
    const { id } = await service.create(owner, {
      profile,
      explanation: "I represent this association",
      submit: true,
      commandId: randomUUID(),
    })
    const requestId = rows.get(id)!.requests[0].id
    await command(staff, id, { action: "review", requestId, decision: "approve", reason: "Verified official contact" })
    return id
  }
  return { service, rows, mails, command, registered, catalogue }
}

/** In-memory promotion store over a registry harness, with the same key and locking semantics as the SQL store. */
export function promotionHarness(h: ReturnType<typeof harness>) {
  const rows = new Map<string, Promotion>()
  const keys = new Map<string, string>()
  const mails: Mail[] = []
  const store: PromotionStore = {
    async promotions(filter) {
      const day = (p: Promotion) => p.scheduledAt?.slice(0, 10) ?? p.content.desiredDate ?? ""
      return structuredClone(
        [...rows.values()].filter(
          (p) =>
            (!filter.associationId || p.associationId === filter.associationId) &&
            (!filter.status || p.status === filter.status) &&
            (!filter.from || day(p) >= filter.from) &&
            (!filter.to || (day(p) && day(p) <= filter.to))
        )
      )
    },
    promotion: async (id) => structuredClone(rows.get(id) ?? null),
    async createPromotion(associationId, key, operation) {
      if (keys.has(key)) return keys.get(key) as string
      const record = h.rows.get(associationId)
      if (!record) throw new Error("missing association")
      const mail: Mail[] = []
      const p = operation(structuredClone(record), mail)
      rows.set(p.id, structuredClone(p))
      keys.set(key, p.id)
      mails.push(...mail)
      return p.id
    },
    async changePromotion(id, key, operation) {
      if (keys.has(key)) return keys.get(key) as string
      const stored = rows.get(id)
      if (!stored) throw new Error("missing promotion")
      const p = structuredClone(stored)
      const mail: Mail[] = []
      operation(p, structuredClone(h.rows.get(p.associationId) as Record), mail)
      rows.set(id, p)
      keys.set(key, id)
      mails.push(...mail)
      return id
    },
  }
  const service = createPromotionService(
    store,
    { get: async (id) => structuredClone(h.rows.get(id) ?? null), catalogue: async () => structuredClone(h.catalogue) },
    "https://admin.example.org"
  )
  async function command(
    v: Viewer,
    id: string,
    action: PromotionCommand extends infer T
      ? T extends PromotionCommand
        ? Omit<T, "id" | "revision" | "commandId">
        : never
      : never
  ) {
    const revision = rows.get(id)?.revision ?? 0
    return service.command(v, { ...action, id, revision, commandId: randomUUID() } as PromotionCommand)
  }
  return { service, rows, mails, command }
}
