import { z } from "zod"
import { httpUrl, linkSchema, publicContactSchema } from "./contract"
import type { Store } from "./service"

/** The website's view of the registry: approved, published snapshots only, never working drafts, notes or members. */
export async function publicAssociations(store: Pick<Store, "published" | "catalogue">) {
  const [records, catalogue] = await Promise.all([store.published(), store.catalogue()])
  const named = (kind: "programme" | "campus", slugs: string[]) =>
    slugs.flatMap((slug) => {
      const entry = catalogue.find((e) => e.kind === kind && e.slug === slug)
      return entry ? [{ slug, nameIt: entry.nameIt, nameEn: entry.nameEn }] : []
    })
  return records
    .filter((r) => r.status !== "archived" && r.legacyId !== null)
    .sort((a, b) => (a.legacyId ?? 0) - (b.legacyId ?? 0))
    .map((r) => {
      const p = r.published as NonNullable<typeof r.published>
      // Public output must never fail for the whole list because of one odd stored value.
      const links = p.links.filter((l) => linkSchema.safeParse(l).success)
      const first = (key: string) => links.find((l) => l.platform === key)?.url ?? null
      return {
        id: r.legacyId as number,
        name: p.name,
        descriptionIt: p.descriptionIt,
        descriptionEn: p.descriptionEn,
        logo: p.logo && httpUrl.safeParse(p.logo).success ? p.logo : null,
        links: {
          email: p.email && z.email().safeParse(p.email).success ? p.email : null,
          website: first("website"),
          facebook: first("facebook"),
          instagram: first("instagram"),
          tiktok: first("tiktok"),
          x: first("x"),
          youtube: first("youtube"),
          telegram: first("telegram"),
          linkedin: first("linkedin"),
          spotify: first("spotify"),
        },
        extraLinks: links,
        programmes: named("programme", p.programmes),
        campuses: named("campus", p.campuses),
        crossProgramme: p.crossProgramme,
        // Only approved public contacts; the holder link is internal.
        contacts: p.contacts
          .filter((c) => publicContactSchema.safeParse(c).success)
          .map(({ function: fn, label, email, name, phone }) => ({ function: fn, label, email, name, phone })),
      }
    })
}
