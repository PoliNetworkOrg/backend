import * as auditLog from "./audit-log"
import * as grants from "./grants"
import * as groupLabels from "./group-label"
import * as groups from "./groups"
import * as link from "./link"
import * as messages from "./messages"
import * as permissions from "./permissions"
import * as test from "./test"
import * as users from "./users"

export const schema = {
  ...groups,
  ...groupLabels,
  ...test,
  ...permissions,
  ...link,
  ...messages,
  ...auditLog,
  ...users,
  ...grants,
}
