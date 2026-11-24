import { z } from "zod"
import { httpUrl, linkSchema, publicContactSchema } from "./contract"
import type { EventStore } from "./events"
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

/**
 * Approved events that are not over yet, for the website's calendar. Only events of associations whose profile is
 * published, so every event links to a profile on the site; never drafts, notes or representatives.
 */
export async function publicEvents(store: Pick<Store, "published" | "catalogue">, events: Pick<EventStore, "events">) {
  const [records, catalogue, upcoming] = await Promise.all([
    store.published(),
    store.catalogue(),
    events.events({ status: "approved", upcoming: true }),
  ])
  const listed = new Map(records.filter((r) => r.status !== "archived" && r.legacyId !== null).map((r) => [r.id, r]))
  return upcoming.flatMap((e) => {
    const r = listed.get(e.associationId)
    const c = e.content
    if (!r?.published || !c.startsAt) return []
    const campus = c.campus ? catalogue.find((x) => x.kind === "campus" && x.slug === c.campus) : undefined
    return [
      {
        id: e.id,
        associationId: r.legacyId as number,
        associationName: r.published.name,
        title: c.title,
        descriptionIt: c.descriptionIt,
        descriptionEn: c.descriptionEn,
        startsAt: c.startsAt,
        endsAt: c.endsAt,
        online: c.online,
        venue: c.venue,
        campus: campus ? { slug: campus.slug, nameIt: campus.nameIt, nameEn: campus.nameEn } : null,
        link: c.link && httpUrl.safeParse(c.link).success ? c.link : null,
        poster: c.poster && httpUrl.safeParse(c.poster).success ? c.poster : null,
      },
    ]
  })
}
