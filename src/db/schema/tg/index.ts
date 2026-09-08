import * as banAllLog from "./ban-all-log"
import * as deletedLog from "./deleted-log"
import * as exceptionLog from "./exception-log"
import * as grants from "./grants"
import * as groupManagementLog from "./group-management-log"
import * as groups from "./groups"
import * as grantLog from "./grant-log"
import * as link from "./link"
import * as messages from "./messages"
import * as moderationLog from "./moderation-log"
import * as permissions from "./permissions"
import * as test from "./test"
import * as users from "./users"

export const schema = {
  ...groups,
  ...test,
  ...permissions,
  ...link,
  ...messages,
  ...banAllLog,
  ...deletedLog,
  ...exceptionLog,
  ...groupManagementLog,
  ...grantLog,
  ...moderationLog,
  ...users,
  ...grants,
}