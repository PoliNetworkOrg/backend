import { argv } from "bun"
import { sql } from "drizzle-orm"
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
  await DB.execute(sql`TRUNCATE TABLE tg_messages, tg_groups, tg_users`)
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

process.exit(0)
