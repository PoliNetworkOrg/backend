import { randomUUID } from "node:crypto"
import type { CatalogueEntry, Command, Profile } from "@/associations/contract"
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
