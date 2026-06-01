import "@/server"
import type { User } from "better-auth"
import { argv } from "bun"
import { eq } from "drizzle-orm"
import { auth } from "@/auth"
import { DB, SCHEMA } from "@/db"

const testUser = {
  email: "test@example.com",
  telegramId: 123456789,
  telegramUsername: "testuser",
  role: "owner",
  name: "Test User",
}

const force = argv.includes("--force")

const existing = await DB.select().from(SCHEMA.AUTH.user).where(eq(SCHEMA.AUTH.user.email, testUser.email)).limit(1)
if (existing.length === 1) {
  if (force) {
    await DB.delete(SCHEMA.AUTH.user).where(eq(SCHEMA.AUTH.user.email, testUser.email))
    console.warn("SEED: test user deleted for recreation by using --force flag")
  } else {
    console.error("SEED: test user already in the database", `id:${existing[0].id}`, testUser.email)
    process.exit(1)
  }
}

await auth.api.sendVerificationOTP({
  body: {
    type: "sign-in",
    email: testUser.email, // required
  },
})

console.log("SEED: open the email and insert the OTP")

let user: User
while (true) {
  const otp = prompt("Insert OTP:")
  if (!otp) continue

  const res = await auth.api
    .signInEmailOTP({ body: { email: testUser.email, otp, name: testUser.name } })
    .catch(() => null)

  if (res?.user.email === testUser.email) {
    user = res.user
    break
  }
}

await DB.update(SCHEMA.AUTH.user) // update the auth.user table
  .set({ telegramId: testUser.telegramId, telegramUsername: testUser.telegramUsername })
  .where(eq(SCHEMA.AUTH.user.id, user.id))

console.log("SEED: test user created", testUser.email)

await DB.insert(SCHEMA.TG.permissions)
  .values({
    userId: testUser.telegramId,
    addedBy: testUser.telegramId,
    roles: ["owner"],
  })
  .onConflictDoNothing()

console.log("SEED: given role 'owner' to test user")

process.exit(0)
