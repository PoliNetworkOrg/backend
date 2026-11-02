import type { PersonRef } from "./contract"

export type DirectoryEntry = { sub: string; name: string; email: string | null }

/**
 * IdP accounts (any account, not only Soci) with a short cache, for invites, deleghe and the names shown next to
 * actions. Without an IdP directory it knows nobody, and names fall back to the subject.
 */
export function createDirectory(fetchAll: (() => Promise<DirectoryEntry[]>) | null, ttlMs = 60_000) {
  let cache: { at: number; entries: DirectoryEntry[] } | null = null
  const all = async (): Promise<DirectoryEntry[]> => {
    if (!fetchAll) return []
    if (cache && Date.now() - cache.at < ttlMs) return cache.entries
    try {
      cache = { at: Date.now(), entries: await fetchAll() }
    } catch (error) {
      if (!cache) throw error
    }
    return cache.entries
  }
  const normalize = (s: string) =>
    s
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .toLowerCase()
  return {
    configured: fetchAll !== null,
    async find(sub: string): Promise<PersonRef | null> {
      const entry = (await all().catch(() => [])).find((e) => e.sub === sub)
      return entry ? { id: entry.sub, name: entry.name, email: entry.email } : null
    },
    /** The person, or a placeholder named after the subject. */
    async person(sub: string): Promise<PersonRef> {
      return (await this.find(sub)) ?? { id: sub, name: sub, email: null }
    },
    async search(q: string, limit = 20): Promise<PersonRef[]> {
      const terms = normalize(q).split(/\s+/).filter(Boolean)
      return (await all())
        .filter((e) => terms.every((t) => normalize(`${e.name} ${e.email ?? ""}`).includes(t)))
        .slice(0, limit)
        .map((e) => ({ id: e.sub, name: e.name, email: e.email }))
    },
  }
}
export type Directory = ReturnType<typeof createDirectory>
