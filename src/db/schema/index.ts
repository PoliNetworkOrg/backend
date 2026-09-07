import { schema as authSchema } from "./auth"
import { schema as commonSchema } from "./common"
import { schema as emailSchema } from "./email"
import { schema as tgSchema } from "./tg"
import { views } from "./views"
import { schema as waSchema } from "./wa"
import { schema as webSchema } from "./web"

export const schema = {
  ...authSchema,
  ...commonSchema,
  ...tgSchema,
  ...waSchema,
  ...webSchema,
  ...emailSchema,
  ...views,
}
