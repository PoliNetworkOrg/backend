/** Website-owned slots: only their contents may be changed by editors. */
export const freshmanSlots = [
  { id: "featured-1", section: "resources", group: "featured" },
  { id: "featured-2", section: "resources", group: "featured" },
  { id: "guides-1", section: "resources", group: "guides" },
  { id: "guides-2", section: "resources", group: "guides" },
  { id: "guides-3", section: "resources", group: "guides" },
  { id: "guides-4", section: "resources", group: "guides" },
  { id: "guides-5", section: "resources", group: "guides" },
  { id: "materials-1", section: "resources", group: "materials" },
  { id: "tools-1", section: "resources", group: "tools" },
  { id: "tools-2", section: "resources", group: "tools" },
  ...Array.from(
    { length: 8 },
    (_, index) => ({ id: `telegram-${index + 1}`, section: "telegram", group: "telegram" }) as const
  ),
] as const

export const freshmanIcons = [
  "chart",
  "monitor",
  "book",
  "map",
  "news",
  "money",
  "folder",
  "repeat",
  "refresh",
  "bell",
  "user",
  "users",
  "cart",
  "home",
] as const
export const freshmanFaqCount = 5
