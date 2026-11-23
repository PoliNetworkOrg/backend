import * as auditEvents from "./audit-events"
import * as groupLabels from "./group-labels"
import * as idpState from "./idp-state"
import * as webhookDeliveries from "./webhook-deliveries"

export const schema = {
  ...auditEvents,
  ...groupLabels,
  ...idpState,
  ...webhookDeliveries,
}
