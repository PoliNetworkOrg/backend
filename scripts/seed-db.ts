import { argv } from "bun"
import { like, sql } from "drizzle-orm"
import type { PgInsertValue, PgTable } from "drizzle-orm/pg-core"
import { DB, SCHEMA } from "@/db"
import { ARRAY_AUDIT_TYPE, AUDIT_BASIS, AUDIT_REVIEW, AUDIT_TYPE } from "@/db/schema/tg/audit-log"
import { tgMessagesCipher } from "@/routers/tg/messages"
import { defaultFreshmanCards } from "@/routers/web/freshman/seed"
import { encryptUser } from "@/utils/users"

const USERS_COUNT = 2000
const GROUPS_COUNT = 1000
const MESSAGES_PER_USER = 30
const CHUNK_SIZE = 1000

const FIRST_NAMES = [
  "Marco",
  "Luca",
  "Giulia",
  "Sara",
  "Andrea",
  "Francesca",
  "Alessandro",
  "Chiara",
  "Matteo",
  "Elena",
  "Davide",
  "Sofia",
  "Simone",
  "Martina",
  "Riccardo",
  "Giorgia",
  "Federico",
  "Valentina",
  "Lorenzo",
  "Beatrice",
]
const LAST_NAMES = [
  "Rossi",
  "Bianchi",
  "Ferrari",
  "Russo",
  "Colombo",
  "Ricci",
  "Marino",
  "Greco",
  "Bruno",
  "Gallo",
  "Conti",
  "De Luca",
  "Costa",
  "Giordano",
  "Mancini",
  "Rizzo",
  "Lombardi",
  "Moretti",
  "Barbieri",
  "Fontana",
]
const LANG_CODES = ["it", "en", "es", "fr", "de"]
const GROUP_TOPICS = [
  "Ingegneria",
  "Informatica",
  "Matematica",
  "Fisica",
  "Design",
  "Architettura",
  "Chimica",
  "Economia",
  "Biologia",
  "Medicina",
]
const GROUP_TAGS = ["ing", "info", "mat", "fis", "design"]
const MESSAGE_TEMPLATES = [
  "Ciao a tutti!",
  "Qualcuno ha gli appunti della lezione di oggi?",
  "Grazie mille per l'aiuto",
  "A che ora è l'esame?",
  "Ottimo lavoro ragazzi",
  "Non ho capito questo esercizio, mi aiutate?",
  "Perfetto, ci vediamo domani",
  "Qualcuno sa dove trovare il materiale del corso?",
  "Buona fortuna a tutti per l'esame",
  "Ci sono aggiornamenti sull'orario delle lezioni?",
]

const randomInt = (min: number, max: number) => min + Math.floor(Math.random() * (max - min + 1))
const randomItem = <T>(arr: T[]): T => arr[randomInt(0, arr.length - 1)] as T
const daysAgo = (maxDays: number) => new Date(Date.now() - randomInt(0, maxDays * 24 * 60 * 60 * 1000))

const chunk = <T>(items: T[], size: number): T[][] => {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size))
  return chunks
}

const force = argv.includes("--force")

const seededUserId = (i: number) => 100_000_000 + i + 1

const existing = await Promise.all([
  DB.select().from(SCHEMA.TG.users).limit(1),
  DB.select().from(SCHEMA.TG.groups).limit(1),
  DB.select().from(SCHEMA.TG.messages).limit(1),
])
const tgHasData = existing.some((rows) => rows.length > 0)
if (tgHasData && force) {
  console.warn("SEED: wiping tg_messages, tg_groups, tg_users for reseeding (--force)")
  await DB.execute(sql`TRUNCATE TABLE tg_messages, tg_groups, tg_users CASCADE`)
}

const { userIds, groupIds, createdUserIds } = await seedTelegramActivity()

/** Seeds each empty activity table, using retained users and groups for new messages. */
async function seedTelegramActivity() {
  const createdUserIds = new Set<number>()
  const [firstUser] = await DB.select().from(SCHEMA.TG.users).limit(1)
  if (!firstUser) {
    console.log(`SEED: generating ${USERS_COUNT} users`)
    const users = await Promise.all(
      Array.from({ length: USERS_COUNT }, async (_, i) => {
        const userId = seededUserId(i)
        const user = await encryptUser({
          id: userId,
          firstName: randomItem(FIRST_NAMES),
          lastName: Math.random() < 0.9 ? randomItem(LAST_NAMES) : undefined,
          username: Math.random() < 0.7 ? `user_${userId}_${Math.random().toString(36).slice(2, 6)}` : undefined,
          isBot: Math.random() < 0.02,
          langCode: randomItem(LANG_CODES),
        })
        return { ...user, createdAt: daysAgo(365) }
      })
    )
    for (const batch of chunk(users, CHUNK_SIZE)) {
      await DB.insert(SCHEMA.TG.users).values(batch)
      for (const user of batch) createdUserIds.add(user.userId)
    }
  } else {
    console.log("SEED: tg_users already contains data, skipping")
  }
  const userIds = (await DB.select({ id: SCHEMA.TG.users.userId }).from(SCHEMA.TG.users).limit(USERS_COUNT)).map(
    (user) => user.id
  )

  const [firstGroup] = await DB.select().from(SCHEMA.TG.groups).limit(1)
  if (!firstGroup) {
    console.log(`SEED: generating ${GROUPS_COUNT} groups`)
    const groups = Array.from({ length: GROUPS_COUNT }, (_, i) => ({
      telegramId: -1_000_000_000_000 - i - 1,
      title: `Gruppo ${randomItem(GROUP_TOPICS)} ${i + 1}`,
      tag: Math.random() < 0.5 ? `#${randomItem(GROUP_TAGS)}` : null,
      link: Math.random() < 0.6 ? `https://t.me/joinchat/${Math.random().toString(36).slice(2, 18)}` : null,
      hide: Math.random() < 0.05,
      createdAt: daysAgo(365),
    }))
    for (const batch of chunk(groups, CHUNK_SIZE)) {
      await DB.insert(SCHEMA.TG.groups).values(batch)
    }
  } else {
    console.log("SEED: tg_groups already contains data, skipping")
  }
  const groupIds = (
    await DB.select({ id: SCHEMA.TG.groups.telegramId }).from(SCHEMA.TG.groups).limit(GROUPS_COUNT)
  ).map((group) => group.id)

  const [firstMessage] = await DB.select().from(SCHEMA.TG.messages).limit(1)
  if (!firstMessage) {
    console.log(`SEED: generating ${userIds.length * MESSAGES_PER_USER} messages (${MESSAGES_PER_USER} per user)`)
    const chatMessageCounters = new Map<number, number>()
    const nextMessageId = (chatId: number) => {
      const next = (chatMessageCounters.get(chatId) ?? 0) + 1
      chatMessageCounters.set(chatId, next)
      return next
    }

    const messages = userIds.flatMap((authorId) =>
      Array.from({ length: MESSAGES_PER_USER }, () => {
        const chatId = randomItem(groupIds)
        return {
          chatId,
          messageId: nextMessageId(chatId),
          authorId,
          timestamp: daysAgo(180),
          message: tgMessagesCipher.encrypt(randomItem(MESSAGE_TEMPLATES)),
        }
      })
    )
    for (const batch of chunk(messages, CHUNK_SIZE)) {
      await DB.insert(SCHEMA.TG.messages).values(batch)
    }
    console.log(`SEED: tg_messages → ${messages.length} rows`)
  } else {
    console.log("SEED: tg_messages already contains data, skipping")
  }

  return { userIds, groupIds, createdUserIds }
}

const CATEGORY_ROOT = "didattica"
const FACET_LABELS = ["ita", "eng", "online", "campus-nord", "campus-sud"]
/** IdP subject recorded as the author of seeded rows. */
const SEED_SUB = "seed-owner"
const WA_SEED_LINK_PATTERN = "https://chat.whatsapp.com/SEEDFAKE%"

type CourseEntry = {
  course: string
  title: string
  school: string[]
  level: string
  campus: string | null
  languages: string[]
  waLink: string | null
  tgLink: string | null
  cohort: string
}

const COURSE_ENTRIES: CourseEntry[] = [
  {
    course: "corso-alpha-nord",
    title: "Corso Alpha",
    school: ["scuola-ingegneria"],
    level: "triennale",
    campus: "campus-nord",
    languages: ["ita"],
    waLink: "https://chat.whatsapp.com/SEEDFAKE0000001",
    tgLink: "https://t.me/+seedfake0000001",
    cohort: "26-27",
  },
  {
    course: "corso-alpha-sud",
    title: "Corso Alpha",
    school: ["scuola-ingegneria"],
    level: "triennale",
    campus: "campus-sud",
    languages: ["eng"],
    waLink: "https://chat.whatsapp.com/SEEDFAKE0000002",
    tgLink: "https://t.me/+seedfake0000002",
    cohort: "26-27",
  },
  {
    course: "corso-beta",
    title: "Corso Beta (ITA)",
    school: ["scuola-ingegneria"],
    level: "triennale",
    campus: "campus-nord",
    languages: ["ita"],
    waLink: "https://chat.whatsapp.com/SEEDFAKE0000003",
    tgLink: "https://t.me/+seedfake0000004",
    cohort: "26-27",
  },
  {
    course: "corso-beta",
    title: "Corso Beta (ENG)",
    school: ["scuola-ingegneria"],
    level: "triennale",
    campus: "campus-nord",
    languages: ["eng"],
    waLink: "https://chat.whatsapp.com/SEEDFAKE0000005",
    tgLink: "https://t.me/+seedfake0000004",
    cohort: "26-27",
  },
  {
    course: "corso-gamma",
    title: "Corso Gamma",
    school: ["scuola-ingegneria", "scuola-design"],
    level: "magistrale",
    campus: "campus-nord",
    languages: ["eng"],
    waLink: "https://chat.whatsapp.com/SEEDFAKE0000006",
    tgLink: "https://t.me/+seedfake0000006",
    cohort: "26-27",
  },
  {
    course: "corso-delta",
    title: "Corso Delta",
    school: ["scuola-design"],
    level: "triennale",
    campus: "online",
    languages: ["ita"],
    waLink: null,
    tgLink: "https://t.me/+seedfake0000007",
    cohort: "26-27",
  },
  {
    course: "corso-epsilon",
    title: "Corso Epsilon",
    school: ["scuola-design"],
    level: "triennale",
    campus: null,
    languages: [],
    waLink: null,
    tgLink: "https://t.me/+seedfake0000007",
    cohort: "26-27",
  },
  {
    course: "corso-zeta",
    title: "Corso Zeta",
    school: ["scuola-design"],
    level: "magistrale",
    campus: "campus-sud",
    languages: ["ita", "eng"],
    waLink: "https://chat.whatsapp.com/SEEDFAKE0000008",
    tgLink: null,
    cohort: "26-27",
  },
]

const SITE_GROUPS: { title: string; tgLink: string }[] = [
  { title: "General group", tgLink: "https://t.me/+seedfake0000009" },
]

function courseLabel(school: string, level: string, course: string) {
  return `${CATEGORY_ROOT}.${school}.${level}.${course}`
}
function courseKey(e: CourseEntry) {
  return `${e.level}::${e.course}`
}

type LinkTarget = { link: string; entries: CourseEntry[] }

function collectTargets(pick: (e: CourseEntry) => string | null): Map<string, LinkTarget> {
  const map = new Map<string, LinkTarget>()
  for (const entry of COURSE_ENTRIES) {
    const link = pick(entry)
    if (!link) continue
    const target = map.get(link) ?? { link, entries: [] }
    target.entries.push(entry)
    map.set(link, target)
  }
  return map
}

function labelsFor(target: LinkTarget): { categories: string[]; facets: string[]; title: string } {
  const distinctCourses = new Set(target.entries.map(courseKey))
  const shared = distinctCourses.size > 1
  const title = [...new Set(target.entries.map((e) => e.title))].join(" / ")

  const categories = new Set<string>()
  const facets = new Set<string>()
  for (const entry of target.entries) {
    for (const school of entry.school) {
      const base = courseLabel(school, entry.level, entry.course)
      categories.add(shared ? base : `${base}.${entry.cohort}`)
    }
    if (!shared) {
      for (const lang of entry.languages) facets.add(lang)
      if (entry.campus) facets.add(entry.campus)
    }
  }
  return { categories: [...categories], facets: [...facets], title }
}

console.log("SEED: creating didattica category + facet labels")
const categoryLabelNames = new Set<string>([CATEGORY_ROOT])
for (const entry of COURSE_ENTRIES) {
  for (const school of entry.school) {
    const base = courseLabel(school, entry.level, entry.course)
    categoryLabelNames.add(base)
    categoryLabelNames.add(`${base}.${entry.cohort}`)
  }
}
await DB.insert(SCHEMA.COMMON.groupLabels)
  .values([...categoryLabelNames].map((label) => ({ label, color: "#3b82f6", createdBySub: SEED_SUB })))
  .onConflictDoNothing()
await DB.insert(SCHEMA.COMMON.groupLabels)
  .values(FACET_LABELS.map((label) => ({ label, color: "#94a3b8", createdBySub: SEED_SUB })))
  .onConflictDoNothing()

const allLabels = await DB.select().from(SCHEMA.COMMON.groupLabels)
const labelIdByName = new Map(allLabels.map((l) => [l.label, l.id]))
function resolveLabelIds(names: string[]): number[] {
  return names.map((name) => {
    const id = labelIdByName.get(name)
    if (id == null) throw new Error(`SEED: label "${name}" was not created`)
    return id
  })
}

console.log("SEED: creating WhatsApp course groups")
const waTargets = collectTargets((e) => e.waLink)
const waGroupRows = [...waTargets.values()].map((target) => ({
  title: labelsFor(target).title,
  link: target.link,
  hide: false,
}))
await DB.transaction(async (tx) => {
  if (force) {
    await tx.delete(SCHEMA.WA.waGroups).where(like(SCHEMA.WA.waGroups.link, WA_SEED_LINK_PATTERN))
  }
  if (waGroupRows.length) {
    await tx.insert(SCHEMA.WA.waGroups).values(waGroupRows).onConflictDoNothing()
  }
  const waGroupIdByLink = new Map((await tx.select().from(SCHEMA.WA.waGroups)).map((g) => [g.link, g.id]))
  const waRelations = [...waTargets.values()].flatMap((target) => {
    const groupId = waGroupIdByLink.get(target.link)
    if (groupId == null) return []
    const { categories, facets } = labelsFor(target)
    return resolveLabelIds([...categories, ...facets]).map((labelId) => ({ groupId, labelId }))
  })
  if (waRelations.length) {
    await tx.insert(SCHEMA.WA.waGroupLabelRelations).values(waRelations).onConflictDoNothing()
  }
})

console.log("SEED: creating Telegram course groups (synthetic ids)")
const tgTargets = collectTargets((e) => e.tgLink)
const tgLinks = [...tgTargets.keys(), ...SITE_GROUPS.map((s) => s.tgLink)]
const tgCourseGroupRows = tgLinks.map((link, i) => {
  const target = tgTargets.get(link)
  const site = SITE_GROUPS.find((s) => s.tgLink === link)
  return {
    telegramId: -2_000_000_000_000 - i - 1,
    title: target ? labelsFor(target).title : (site?.title ?? link),
    link,
    hide: false,
  }
})
if (tgCourseGroupRows.length) {
  await DB.insert(SCHEMA.TG.groups).values(tgCourseGroupRows).onConflictDoNothing()
}
const tgGroupIdByLink = new Map(
  (await DB.select().from(SCHEMA.TG.groups))
    .filter((g) => g.link && tgLinks.includes(g.link))
    .map((g) => [g.link as string, g.telegramId])
)
const rootLabelId = resolveLabelIds([CATEGORY_ROOT])[0]
const tgRelations = [
  ...[...tgTargets.values()].flatMap((target) => {
    const groupId = tgGroupIdByLink.get(target.link)
    if (groupId == null) return []
    const { categories, facets } = labelsFor(target)
    return resolveLabelIds([...categories, ...facets]).map((labelId) => ({ groupId, labelId }))
  }),
  ...SITE_GROUPS.flatMap((site) => {
    const groupId = tgGroupIdByLink.get(site.tgLink)
    if (groupId == null) return []
    return [{ groupId, labelId: rootLabelId }]
  }),
]
if (tgRelations.length) {
  await DB.insert(SCHEMA.TG.tgGroupLabelRelations).values(tgRelations).onConflictDoNothing()
}

console.log("SEED: course groups done", {
  waGroups: waGroupRows.length,
  tgGroups: tgCourseGroupRows.length,
  labels: categoryLabelNames.size + FACET_LABELS.length,
})

/**
 * Inserts `rows` only into an empty table, so re-running the seed never duplicates content; with
 * `--force` the table is emptied first. Empty row sets are skipped.
 */
async function seedTable<T extends PgTable>(name: string, table: T, rows: () => PgInsertValue<T>[]) {
  const [first] = await DB.select()
    .from(table as PgTable)
    .limit(1)
  if (first && !force) {
    console.log(`SEED: ${name} already contains data, skipping`)
    return
  }
  const values = rows()
  if (!values.length) {
    console.log(`SEED: ${name} has no eligible sample rows, skipping`)
    return
  }
  if (first) await DB.delete(table)
  await DB.insert(table).values(values)
  console.log(`SEED: ${name} → ${values.length} rows`)
}

const seedAuthor = { createdBySub: SEED_SUB }
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

await seedTable("web_projects", SCHEMA.WEB.projects, () =>
  [
    {
      title: "PoliNetwork App",
      descriptionIt: "L'app ufficiale per trovare gruppi, guide e risorse del Politecnico.",
      descriptionEn: "The official app to find groups, guides and resources at Politecnico.",
      link: "https://polinetwork.org/app",
      category: "news" as const,
    },
    {
      title: "Guida Matricole",
      descriptionIt: "Tutto quello che serve sapere per iniziare al Politecnico.",
      descriptionEn: "Everything you need to know to get started at Politecnico.",
      link: "https://polinetwork.org/matricole",
      category: "news" as const,
    },
    {
      title: "Bot Telegram",
      descriptionIt: "Il bot che modera i gruppi e risponde alle domande più frequenti.",
      descriptionEn: "The bot that moderates groups and answers frequently asked questions.",
      link: "https://t.me/seedfake_bot",
      category: "general" as const,
    },
    {
      title: "Ricerca Gruppi",
      descriptionIt: "Cerca il gruppo del tuo corso tra migliaia di gruppi Telegram e WhatsApp.",
      descriptionEn: "Find your course group among thousands of Telegram and WhatsApp groups.",
      link: "https://polinetwork.org/groups",
      category: "general" as const,
    },
    {
      title: "Materiale Didattico",
      descriptionIt: "Archivio condiviso di appunti, esercizi e temi d'esame.",
      descriptionEn: "Shared archive of notes, exercises and past exams.",
      link: "https://polinetwork.org/materials",
      category: "general" as const,
    },
    {
      title: "Calendario Esami",
      descriptionIt: "Le date degli appelli sincronizzate con il tuo calendario.",
      descriptionEn: "Exam dates synced with your calendar.",
      link: null,
      category: "general" as const,
    },
    {
      title: "Forum PoliNetwork",
      descriptionIt: "Il vecchio forum dell'associazione, ora sostituito dai gruppi.",
      descriptionEn: "The association's old forum, now replaced by the groups.",
      link: "https://forum.example.com",
      category: "deprecated" as const,
    },
    {
      title: "Bot Orari",
      descriptionIt: "Bot per consultare gli orari delle lezioni, non più mantenuto.",
      descriptionEn: "Bot to check lecture timetables, no longer maintained.",
      link: null,
      category: "deprecated" as const,
    },
  ].map((p, order) => ({ ...p, order, logo: null, ...seedAuthor }))
)

await seedTable("web_associations", SCHEMA.WEB.associations, () =>
  [
    {
      name: "Associazione Alpha",
      descriptionIt: "Associazione studentesca di ingegneria che organizza workshop e hackathon.",
      descriptionEn: "Engineering student association organising workshops and hackathons.",
      email: "info@alpha.example.com",
      website: "https://alpha.example.com",
      instagram: "https://instagram.com/seedfake_alpha",
      linkedin: "https://linkedin.com/company/seedfake-alpha",
    },
    {
      name: "Team Beta Racing",
      descriptionIt: "Squadra corse che progetta e costruisce un'auto da competizione.",
      descriptionEn: "Racing team designing and building a competition car.",
      website: "https://beta.example.com",
      instagram: "https://instagram.com/seedfake_beta",
      youtube: "https://youtube.com/@seedfake_beta",
      tiktok: "https://tiktok.com/@seedfake_beta",
    },
    {
      name: "Gamma Design Collective",
      descriptionIt: "Collettivo di studenti di design che cura mostre e laboratori.",
      descriptionEn: "Design student collective curating exhibitions and labs.",
      email: "hello@gamma.example.com",
      instagram: "https://instagram.com/seedfake_gamma",
      facebook: "https://facebook.com/seedfake.gamma",
    },
    {
      name: "Radio Delta",
      descriptionIt: "La web radio degli studenti, con podcast e dirette dal campus.",
      descriptionEn: "The students' web radio, with podcasts and live shows from campus.",
      website: "https://delta.example.com",
      spotify: "https://open.spotify.com/show/seedfake",
      telegram: "https://t.me/seedfake_delta",
      x: "https://x.com/seedfake_delta",
    },
    {
      name: "Epsilon Volontariato",
      descriptionIt: "Studenti che organizzano attività di volontariato in città.",
      descriptionEn: "Students organising volunteering activities in the city.",
      email: "contatti@epsilon.example.com",
    },
  ].map((a) => ({ ...a, logo: null, ...seedAuthor }))
)

const FAQ_CONTENT: {
  titleIt: string
  titleEn: string
  icon: string
  faqs: [titleIt: string, titleEn: string, descriptionIt: string, descriptionEn: string][]
}[] = [
  {
    titleIt: "Gruppi",
    titleEn: "Groups",
    icon: "users",
    faqs: [
      [
        "Come trovo il gruppo del mio corso?",
        "How do I find my course group?",
        "Usa la ricerca gruppi sul sito o chiedi al bot.",
        "Use the group search on the website or ask the bot.",
      ],
      [
        "Il link di un gruppo non funziona",
        "A group link doesn't work",
        "Segnalalo dal sito, lo sistemeremo il prima possibile.",
        "Report it from the website and we'll fix it as soon as possible.",
      ],
      [
        "Posso creare un nuovo gruppo?",
        "Can I create a new group?",
        "Sì, contatta gli admin e lo aggiungeremo alla rete.",
        "Yes, contact the admins and we'll add it to the network.",
      ],
    ],
  },
  {
    titleIt: "Matricole",
    titleEn: "Freshmen",
    icon: "graduation-cap",
    faqs: [
      [
        "Dove trovo la guida matricole?",
        "Where can I find the freshman guide?",
        "Nella sezione Matricole del sito, sempre aggiornata.",
        "In the Freshmen section of the website, always up to date.",
      ],
      [
        "Come funziona il test d'ingresso?",
        "How does the admission test work?",
        "Trovi tutte le informazioni sul sito del Politecnico.",
        "You'll find all the details on Politecnico's website.",
      ],
    ],
  },
  {
    titleIt: "Account",
    titleEn: "Account",
    icon: "user",
    faqs: [
      [
        "Come collego il mio account Telegram?",
        "How do I link my Telegram account?",
        "Accedi alla dashboard e segui le istruzioni del bot.",
        "Log into the dashboard and follow the bot's instructions.",
      ],
      [
        "Sono stato bannato per errore",
        "I was banned by mistake",
        "Scrivi agli admin spiegando cosa è successo.",
        "Write to the admins explaining what happened.",
      ],
    ],
  },
  {
    titleIt: "Associazione",
    titleEn: "Association",
    icon: "info",
    faqs: [
      [
        "Come posso entrare in PoliNetwork?",
        "How can I join PoliNetwork?",
        "Candidati durante le sessioni di recruiting.",
        "Apply during the recruiting sessions.",
      ],
      [
        "PoliNetwork è ufficiale?",
        "Is PoliNetwork official?",
        "È un'associazione studentesca indipendente.",
        "It's an independent student association.",
      ],
    ],
  },
]

// Clear featured references first when explicitly replacing the development FAQ catalog.
if (force) await DB.delete(SCHEMA.WEB.freshmanFaqs)

await seedTable("web_faq_categories", SCHEMA.WEB.faqCategories, () =>
  FAQ_CONTENT.map(({ titleIt, titleEn, icon }) => ({ titleIt, titleEn, icon, ...seedAuthor }))
)
const faqCategoryIdByTitle = new Map((await DB.select().from(SCHEMA.WEB.faqCategories)).map((c) => [c.titleIt, c.id]))
const [firstFaq] = await DB.select().from(SCHEMA.WEB.faqs).limit(1)
if (!firstFaq || force) {
  const missingCategories = FAQ_CONTENT.filter((category) => !faqCategoryIdByTitle.has(category.titleIt))
  if (missingCategories.length) {
    const categories = await DB.insert(SCHEMA.WEB.faqCategories)
      .values(missingCategories.map(({ titleIt, titleEn, icon }) => ({ titleIt, titleEn, icon, ...seedAuthor })))
      .returning()
    for (const category of categories) faqCategoryIdByTitle.set(category.titleIt, category.id)
  }
}
await seedTable("web_faqs", SCHEMA.WEB.faqs, () =>
  FAQ_CONTENT.flatMap((category) => {
    const categoryId = faqCategoryIdByTitle.get(category.titleIt)
    if (categoryId == null) throw new Error(`SEED: FAQ category "${category.titleIt}" was not created`)
    return category.faqs.map(([titleIt, titleEn, descriptionIt, descriptionEn]) => ({
      titleIt,
      titleEn,
      descriptionIt,
      descriptionEn,
      categoryId,
      ...seedAuthor,
    }))
  })
)

await seedTable("web_freshman_cards", SCHEMA.WEB.freshmanCards, () =>
  defaultFreshmanCards.map((card) => ({ ...card, ...seedAuthor }))
)
const [featuredFaq] = await DB.select().from(SCHEMA.WEB.freshmanFaqs).limit(1)
if (!featuredFaq) {
  const catalog = await DB.select({ id: SCHEMA.WEB.faqs.id }).from(SCHEMA.WEB.faqs).orderBy(SCHEMA.WEB.faqs.id).limit(5)
  if (catalog.length === 5) {
    await DB.insert(SCHEMA.WEB.freshmanFaqs).values(
      catalog.map((faq, position) => ({ position, faqId: faq.id, ...seedAuthor }))
    )
  } else console.warn("SEED: at least five FAQs are needed to initialize the Freshman selections")
}

await seedTable("web_guides_matricole", SCHEMA.WEB.guidesMatricole, () =>
  [
    { version: "2024.1", date: "2024-07-15" },
    { version: "2025.1", date: "2025-07-10" },
    { version: "2026.1", date: "2026-07-08" },
  ].map((g) => ({ ...g, file: `https://example.com/seed/guida-matricole-${g.version}.pdf`, ...seedAuthor }))
)

const waGroupIds = (await DB.select({ id: SCHEMA.WA.waGroups.id }).from(SCHEMA.WA.waGroups)).map((g) => g.id)
const tgCourseGroupIds = [...tgGroupIdByLink.values()]
await seedTable("web_group_link_reports", SCHEMA.WEB.groupLinkReports, () => {
  const statuses = ["pending", "pending", "pending", "resolved", "dismissed"] as const
  const brokenTg = tgCourseGroupIds.slice(0, 5).map((groupId, i) => ({
    groupId,
    type: "tg" as const,
    reportType: "broken_link" as const,
    reportedLink: `https://t.me/+seedfake000000${i + 1}`,
    status: statuses[i % statuses.length],
    createdAt: new Date(Date.now() - i * 2 * DAY),
  }))
  const brokenWa = waGroupIds.slice(0, 3).map((groupId, i) => ({
    groupId,
    type: "wa" as const,
    reportType: "broken_link" as const,
    reportedLink: `https://chat.whatsapp.com/SEEDFAKE000000${i + 1}`,
    status: statuses[(i + 2) % statuses.length],
    createdAt: new Date(Date.now() - (i * 3 + 1) * DAY),
  }))
  const missing = [
    ["Corso Omega (magistrale)", "Non trovo il gruppo del corso di Omega del secondo anno."],
    ["Analisi 1 - sezione B", "Manca il gruppo della sezione B, c'è solo la A."],
    ["Erasmus 2026/27", "Esiste un gruppo per chi parte in Erasmus il prossimo anno?"],
    ["Campus Sud - alloggi", "Servirebbe un gruppo per chi cerca casa vicino al campus sud."],
  ].map(([label, details], i) => ({
    reportType: "missing" as const,
    label,
    details,
    status: i === 3 ? ("resolved" as const) : ("pending" as const),
    createdAt: new Date(Date.now() - (i + 1) * DAY),
  }))
  return [...brokenTg, ...brokenWa, ...missing]
})

await seedTable("tg_audit_log", SCHEMA.TG.auditLog, () => {
  const moderators = userIds.slice(0, 5)
  const bases = [AUDIT_BASIS.IDP_PERMISSION, AUDIT_BASIS.TELEGRAM_CHAT_ADMIN, AUDIT_BASIS.LEGACY] as const
  const reasons = ["Spam", "Linguaggio offensivo", "Pubblicità non autorizzata", "Flood", undefined]
  return Array.from({ length: 60 }, (_, i) => {
    const type = randomItem([...ARRAY_AUDIT_TYPE])
    const global = type === AUDIT_TYPE.BAN_ALL || type === AUDIT_TYPE.UNBAN_ALL
    const automatic = i % 10 === 0
    const actor = automatic ? null : randomItem(moderators)
    const basis = automatic ? AUDIT_BASIS.AUTOMATIC : randomItem([...bases])
    const createdAt = daysAgo(90)
    const timed = type === AUDIT_TYPE.MUTE || (type === AUDIT_TYPE.BAN && Math.random() < 0.5)
    return {
      adminId: actor,
      actorTgId: actor,
      actorSub: basis === AUDIT_BASIS.IDP_PERMISSION ? SEED_SUB : null,
      targetId: randomItem(userIds),
      groupId: global ? null : randomItem(groupIds),
      type,
      until: timed ? new Date(createdAt.getTime() + randomInt(1, 72) * HOUR) : null,
      reason: randomItem(reasons),
      client: basis === AUDIT_BASIS.LEGACY ? null : "telegram-bot",
      basis,
      review: basis === AUDIT_BASIS.IDP_PERMISSION && i % 7 === 0 ? AUDIT_REVIEW.PERMISSION_MISSING : null,
      createdAt,
    }
  })
})

await seedTable("tg_grants", SCHEMA.TG.grants, () => {
  const now = Date.now()
  const grant = (i: number, sinceOffset: number, durationHours: number, interrupted = false) => ({
    telegramUserId: seededUserId(20 + i),
    validSince: new Date(now + sinceOffset),
    validUntil: new Date(now + sinceOffset + durationHours * HOUR),
    reason: randomItem(["Evento in aula", "Supporto matricole", "Moderazione temporanea", null]),
    grantedBySub: SEED_SUB,
    grantedViaClient: "admin",
    interruptedAt: interrupted ? new Date(now + sinceOffset + HOUR) : null,
    interruptedBySub: interrupted ? SEED_SUB : null,
  })
  return [
    // active
    grant(0, -2 * HOUR, 24),
    grant(1, -1 * DAY, 72),
    grant(2, -30 * 60 * 1000, 6),
    grant(3, -3 * DAY, 24 * 7),
    // scheduled
    grant(4, 1 * DAY, 48),
    grant(5, 3 * DAY, 24),
    // expired
    grant(6, -10 * DAY, 24),
    grant(7, -20 * DAY, 48),
    grant(8, -40 * DAY, 72),
    // interrupted
    grant(9, -5 * DAY, 72, true),
    grant(10, -2 * DAY, 96, true),
  ].filter((row) => createdUserIds.has(row.telegramUserId))
})

process.exit(0)
