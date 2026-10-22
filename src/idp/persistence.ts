import type { Persistence } from "@polinetwork/auth-kit"
import { eq } from "drizzle-orm"
import { DB, SCHEMA } from "@/db"

const STATE = SCHEMA.COMMON.idpState

/** auth-kit's last good keys and snapshot, in the backend's own Postgres (RFC v3 §5.4). */
export const dbPersistence: Persistence = {
  async load(key) {
    const [row] = await DB.select({ value: STATE.value }).from(STATE).where(eq(STATE.key, key)).limit(1)
    return row?.value ?? null
  },
  async save(key, value) {
    const updatedAt = new Date()
    await DB.insert(STATE)
      .values({ key, value, updatedAt })
      .onConflictDoUpdate({ target: STATE.key, set: { value, updatedAt } })
  },
}
