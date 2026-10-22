import { schema as commonSchema } from "./common"
import { schema as esignSchema } from "./esign"
import { schema as tgSchema } from "./tg"
import { views } from "./views"
import { schema as waSchema } from "./wa"
import { schema as webSchema } from "./web"

export const schema = {
  ...commonSchema,
  ...esignSchema,
  ...tgSchema,
  ...waSchema,
  ...webSchema,
  ...views,
}
