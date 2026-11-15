import { index, text, timestamp } from "drizzle-orm/pg-core"
import { createTable } from "../create-table"

/**
 * Webhook deliveries already handled, by the sender's delivery id (GitHub's `X-GitHub-Delivery`): a delivery replayed
 * with a valid signature is acknowledged and ignored. A delivery whose handling failed is forgotten, so the sender's
 * own redelivery still works. Rows older than a week are deleted.
 */
export const webhookDeliveries = createTable.common(
  "webhook_deliveries",
  {
    id: text().primaryKey(),
    source: text().notNull(),
    event: text().notNull(),
    receivedAt: timestamp("received_at", { precision: 3, withTimezone: true }).notNull(),
  },
  (t) => [index("common_webhook_deliveries_received_idx").on(t.receivedAt)]
)
