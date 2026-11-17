import { randomUUID } from "node:crypto"
import type { Command, Profile } from "@/associations/contract"
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
}
export function harness() {
  const rows = new Map<string, Record>()
  const creation = new Map<string, string>()
  const mails: Mail[] = []
  const store: Store = {
    list: async () => structuredClone([...rows.values()]),
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
  return { service, rows, mails, command, registered }
}
