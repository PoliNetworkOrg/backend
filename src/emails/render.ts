import { readFile } from "node:fs/promises"
import { render, toPlainText } from "@react-email/components"
import type { JSX } from "react"
import { EMAIL_HEADERS, type EmailHeaderKind, headerCid } from "./headers"

export async function renderEmail(component: JSX.Element) {
  let html = await render(component)
  const kinds = (Object.keys(EMAIL_HEADERS) as EmailHeaderKind[]).filter((kind) =>
    html.includes(`src="cid:${headerCid(kind)}"`)
  )
  if (kinds.length) {
    html = html.replace(
      "</head>",
      "<!--[if mso]><style>.email-card{width:520px!important}table,td,p,a,h1{font-family:Arial,sans-serif!important}</style><![endif]--></head>"
    )
  }
  const inlineImages = await Promise.all(
    kinds.map(async (kind) => ({
      filename: `${kind}-testata.png`,
      content: await readFile(new URL(`./assets/headers/${kind}.png`, import.meta.url)),
      contentType: "image/png",
      contentDisposition: "inline" as const,
      cid: headerCid(kind),
    }))
  )
  const text = toPlainText(html, {
    selectors: [
      { selector: '*[style*="display:none"i]', format: "skip" },
      { selector: "h1", options: { uppercase: false } },
    ],
  })
  return { html, text: [...kinds.map((kind) => EMAIL_HEADERS[kind]), text].join("\n\n"), inlineImages }
}
