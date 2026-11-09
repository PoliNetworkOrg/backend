import { schema as commonSchema } from "./common"
import { schema as esignSchema } from "./esign"
import { schema as peopleSchema } from "./people"
import { schema as sociSchema } from "./soci"
import { schema as tgSchema } from "./tg"
import { views } from "./views"
import { schema as waSchema } from "./wa"
import { schema as webSchema } from "./web"

export const schema = {
  ...commonSchema,
  ...esignSchema,
  ...peopleSchema,
  ...sociSchema,
  ...tgSchema,
  ...waSchema,
  ...webSchema,
  ...views,
}
