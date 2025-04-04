import { schema as tgSchema } from "./tg";
import { schema as webSchema } from "./web";

export const schema = { ...tgSchema, ...webSchema };
