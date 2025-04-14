import { schema as tgSchema } from "./tg";
import { schema as webSchema } from "./web";
import { schema as authSchema } from "./auth";

export const schema = { ...tgSchema, ...webSchema, ...authSchema };
