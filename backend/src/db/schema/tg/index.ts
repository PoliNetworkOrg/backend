import * as auditLog from "./audit-log"
import * as groups from "./groups"
import * as link from "./link"
import * as messages from "./messages"
import * as permissions from "./permissions"
import * as test from "./test"
import * as users from "./users"

export const schema = { ...groups, ...test, ...permissions, ...link, ...messages, ...auditLog, ...users }
