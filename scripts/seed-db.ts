import { argv } from "bun"
import { sql } from "drizzle-orm"
import { USER_ROLE } from "@/constants"
import { DB, SCHEMA } from "@/db"
import { tgMessagesCipher } from "@/routers/tg/messages"
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

const existing = await Promise.all([
  DB.select().from(SCHEMA.TG.users).limit(1),
  DB.select().from(SCHEMA.TG.groups).limit(1),
  DB.select().from(SCHEMA.TG.messages).limit(1),
])
if (existing.some((rows) => rows.length > 0)) {
  if (!force) {
    console.error("SEED: tg_users, tg_groups or tg_messages already contain data, use --force to wipe and reseed")
    process.exit(1)
  }
  console.warn("SEED: wiping tg_messages, tg_groups, tg_users for reseeding (--force)")
  await DB.execute(sql`TRUNCATE TABLE tg_messages, tg_groups, tg_users CASCADE`)
}

console.log(`SEED: generating ${USERS_COUNT} users`)
const users = await Promise.all(
  Array.from({ length: USERS_COUNT }, async (_, i) => {
    const userId = 100_000_000 + i + 1
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
}

console.log(`SEED: generating ${GROUPS_COUNT} groups`)
const groups = Array.from({ length: GROUPS_COUNT }, (_, i) => {
  const telegramId = -1_000_000_000_000 - i - 1
  return {
    telegramId,
    title: `Gruppo ${randomItem(GROUP_TOPICS)} ${i + 1}`,
    tag: Math.random() < 0.5 ? `#${randomItem(GROUP_TAGS)}` : null,
    link: Math.random() < 0.6 ? `https://t.me/joinchat/${Math.random().toString(36).slice(2, 18)}` : null,
    hide: Math.random() < 0.05,
    createdAt: daysAgo(365),
  }
})
for (const batch of chunk(groups, CHUNK_SIZE)) {
  await DB.insert(SCHEMA.TG.groups).values(batch)
}

console.log(`SEED: generating ${USERS_COUNT * MESSAGES_PER_USER} messages (${MESSAGES_PER_USER} per user)`)
const chatMessageCounters = new Map<number, number>()
const nextMessageId = (chatId: number) => {
  const next = (chatMessageCounters.get(chatId) ?? 0) + 1
  chatMessageCounters.set(chatId, next)
  return next
}

const messages = users.flatMap((user) =>
  Array.from({ length: MESSAGES_PER_USER }, () => {
    const chatId = randomItem(groups).telegramId
    return {
      chatId,
      messageId: nextMessageId(chatId),
      authorId: user.userId,
      timestamp: daysAgo(180),
      message: tgMessagesCipher.encrypt(randomItem(MESSAGE_TEMPLATES)),
    }
  })
)
for (const batch of chunk(messages, CHUNK_SIZE)) {
  await DB.insert(SCHEMA.TG.messages).values(batch)
}

console.log("SEED: done", {
  users: USERS_COUNT,
  groups: GROUPS_COUNT,
  messages: messages.length,
})

const CATEGORY_ROOT = "didattica"
const FACET_LABELS = ["ita", "eng", "online", "campus-nord", "campus-sud"]
const SEED_OWNER_ID = 1 // matches the admin app's AGENT_MODE synthetic session (telegramId: 1)

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

console.log("SEED: ensuring seed-owner permissions row (matches AGENT_MODE's synthetic session)")
await DB.insert(SCHEMA.TG.permissions)
  .values({ userId: SEED_OWNER_ID, roles: [USER_ROLE.ADMIN, USER_ROLE.WEB], addedBy: SEED_OWNER_ID })
  .onConflictDoNothing()

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
  .values([...categoryLabelNames].map((label) => ({ label, color: "#3b82f6", createdBy: SEED_OWNER_ID })))
  .onConflictDoNothing()
await DB.insert(SCHEMA.COMMON.groupLabels)
  .values(FACET_LABELS.map((label) => ({ label, color: "#94a3b8", createdBy: SEED_OWNER_ID })))
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
if (waGroupRows.length) {
  await DB.insert(SCHEMA.WA.waGroups).values(waGroupRows).onConflictDoNothing()
}
const waGroupIdByLink = new Map((await DB.select().from(SCHEMA.WA.waGroups)).map((g) => [g.link, g.id]))
const waRelations = [...waTargets.values()].flatMap((target) => {
  const groupId = waGroupIdByLink.get(target.link)
  if (groupId == null) return []
  const { categories, facets } = labelsFor(target)
  return resolveLabelIds([...categories, ...facets]).map((labelId) => ({ groupId, labelId }))
})
if (waRelations.length) {
  await DB.insert(SCHEMA.WA.waGroupLabelRelations).values(waRelations).onConflictDoNothing()
}

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
  (await DB.select().from(SCHEMA.TG.groups)).filter((g) => g.link && tgLinks.includes(g.link)).map((g) => [g.link as string, g.telegramId])
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

process.exit(0)
