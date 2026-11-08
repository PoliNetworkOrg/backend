import * as auditEvents from "./audit-events"
import * as groupLabels from "./group-labels"
import * as idpState from "./idp-state"

export const schema = {
  ...auditEvents,
  ...groupLabels,
  ...idpState,
}
