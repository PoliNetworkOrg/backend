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
  .refine((input) => !input.id.startsWith("telegram-"), {
    path: ["id"],
    message: "A Telegram slot links a group: use updateTelegramCard.",
  })
export const telegramSlotId = z
  .string()
  .refine((id) => freshmanSlots.some((slot) => slot.id === id && slot.section === "telegram"), "Unknown Telegram slot.")
export const updateFreshmanTelegramCardInput = z
  .object({
    id: telegramSlotId,
    /** Shown instead of the group's title; empty shows the group's title. */
    title: z.string().trim().max(120),
    icon: z.enum(freshmanIcons),
    telegramGroupId: z.number().int(),
  })
  .strict()
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
const telegramCard = publicCard.extend({
  /** The editor's name for the group; empty when `title` is the group's own title. */
  customTitle: z.string(),
  /** The linked group, whose invite link is `href`; null while the slot shows a legacy link (or none). */
  telegramGroup: z
    .object({ telegramId: z.number().int(), title: z.string(), link: z.string().nullable(), hide: z.boolean() })
    .nullable(),
})
export const freshmanContentOutput = z.object({
  resources: z.array(publicCard).length(10),
  telegram: z.array(telegramCard).length(8),
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
