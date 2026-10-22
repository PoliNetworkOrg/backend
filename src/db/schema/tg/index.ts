import * as auditLog from "./audit-log"
import * as grants from "./grants"
import * as groups from "./groups"
import * as messages from "./messages"
import * as test from "./test"
import * as users from "./users"

export const schema = {
  ...groups,
  ...test,
  ...messages,
  ...auditLog,
  ...users,
  ...grants,
}
