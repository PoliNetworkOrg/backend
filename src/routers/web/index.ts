import { createTRPCRouter } from "@/trpc"
import faqs from "./faqs"

export const webRouter = createTRPCRouter({ faqs })
