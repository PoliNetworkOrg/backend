import z from "zod"
import { freshmanFaqCount, freshmanIcons, freshmanSlots } from "./constants"

const destination = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => {
    if (value === "") return true
    if (value.startsWith("/") && !value.startsWith("//") && !/[\\\s]/.test(value)) return true
    if (!URL.canParse(value)) return false
    const url = new URL(value)
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password
  }, "Use a site path or an HTTP/HTTPS URL without credentials.")

export const freshmanCardFields = z
  .object({
    title: z.string().trim().min(1).max(120),
    description: z.string().trim().max(1000),
    icon: z.enum(freshmanIcons),
    href: destination,
  })
  .strict()
export const freshmanSlotId = z
  .string()
  .refine((id) => freshmanSlots.some((slot) => slot.id === id), "Unknown website slot.")
export const updateFreshmanCardInput = freshmanCardFields
  .extend({
    id: freshmanSlotId,
  })
  .superRefine((input, ctx) => {
    if (input.id.startsWith("telegram-") && input.href === "")
      ctx.addIssue({ code: "custom", path: ["href"], message: "Enter a group link." })
  })
export const moveFreshmanCardInput = z
  .object({
    id: freshmanSlotId,
    direction: z.union([z.literal(-1), z.literal(1)]),
  })
  .strict()
export const selectFreshmanFaqInput = z
  .object({
    position: z
      .number()
      .int()
      .min(0)
      .max(freshmanFaqCount - 1),
    faqId: z.number().int().positive(),
  })
  .strict()

const publicCard = freshmanCardFields.extend({ id: z.string(), group: z.string() })
export const freshmanContentOutput = z.object({
  resources: z.array(publicCard).length(10),
  telegram: z.array(publicCard).length(8),
  faqs: z
    .array(
      z.object({
        faqId: z.number().int(),
        titleIt: z.string(),
        titleEn: z.string(),
        descriptionIt: z.string(),
        descriptionEn: z.string(),
      })
    )
    .length(freshmanFaqCount),
})
