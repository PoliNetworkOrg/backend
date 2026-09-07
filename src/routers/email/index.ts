import { createTRPCRouter } from "@/trpc"
import emailTemplates from "./email_templates"

export const emailRouter = createTRPCRouter({
  templates: emailTemplates,
})
