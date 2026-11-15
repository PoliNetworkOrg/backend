import {
  Body,
  Container,
  Head,
  Heading,
  Html,
  Link,
  Preview,
  pixelBasedPreset,
  Section,
  Tailwind,
  Text,
} from "@react-email/components"
import { Footer } from "../components/footer"
import { Logo } from "../components/logo"
import type { EmailTemplate } from "../types"

export type RegulationEmanatedProps = {
  documentTitle: string
  /** "Approvato dal Consiglio Direttivo il 08/10/2026", "Rettificato dal Segretario il …". */
  deliberaLine: string
  tag: string
  /** File names of the PDFs attached to this email, or null when one is missing. */
  attached: { official: string | null; differences: string | null }
  categories: { title: string; summary: string }[]
  /** `DD/MM/YYYY`, or null for a rettifica without an opposition window. */
  oppositionDeadline: string | null
  /** The dashboard's view of the changes: only for people with dashboard access, so shown as an extra. */
  dashboardUrl: string | null
}

/** What is attached, in words: the Soci can't open the private repository, so the email carries the documents. */
export function attachedLine(attached: RegulationEmanatedProps["attached"]): string | null {
  if (attached.official && attached.differences)
    return `In allegato il testo ufficiale (${attached.official}) e il documento delle differenze (${attached.differences}), che non ha valore ufficiale.`
  if (attached.official) return `In allegato il testo ufficiale (${attached.official}).`
  if (attached.differences)
    return `In allegato il documento delle differenze (${attached.differences}), che non ha valore ufficiale.`
  return null
}

/** To the Soci, in Italian. Self-contained: the documents are attached, and no link needs an account. */
const RegulationEmanatedEmail: EmailTemplate<RegulationEmanatedProps> = (p) => {
  const attached = attachedLine(p.attached)
  return (
    <Html lang="it">
      <Tailwind config={{ presets: [pixelBasedPreset] }}>
        <Head />
        <Preview>
          Nuova versione: {p.documentTitle} ({p.tag})
        </Preview>
        <Body className="m-0 bg-white p-0 font-sans text-base leading-normal">
          <Logo />
          <Container className="mx-auto bg-white px-5 max-w-[520px]">
            <Heading className="m-0 text-center text-2xl font-bold leading-8">{p.documentTitle}</Heading>
            <Text className="text-center text-sm text-gray-600">
              {p.deliberaLine} · versione {p.tag}
            </Text>
            <Section className="py-6">
              <Text className="my-2">
                È stata emanata una nuova versione di «{p.documentTitle}».{attached ? ` ${attached}` : ""}
              </Text>
              {p.categories.length > 0 && <Text className="mb-1 mt-4 font-bold">Cosa cambia</Text>}
              {p.categories.map((c) => (
                <Text key={c.title} className="my-1">
                  <strong>{c.title}</strong>: {c.summary}
                </Text>
              ))}
              {p.oppositionDeadline && (
                <Text className="mt-4">
                  Entro il {p.oppositionDeadline} i Soci possono notificare il proprio parere contrario e proporre
                  modifiche; contro la nuova versione è ammesso ricorso motivato al Collegio dei Probiviri nello stesso
                  termine.
                </Text>
              )}
              {p.dashboardUrl && (
                <Text className="mt-6 text-sm text-gray-600">
                  Per chi ha accesso alla dashboard di PoliNetwork: le modifiche si possono consultare anche{" "}
                  <Link href={p.dashboardUrl}>nella dashboard</Link>.
                </Text>
              )}
            </Section>
          </Container>
          <Footer>
            Notifica del Consiglio Direttivo di PoliNetwork. Rispondi a questa email per scrivere al Direttivo.
          </Footer>
        </Body>
      </Tailwind>
    </Html>
  )
}

RegulationEmanatedEmail.PreviewProps = {
  documentTitle: "Raccolta dei Regolamenti Interni",
  deliberaLine: "Approvato dal Consiglio Direttivo il 08/10/2026",
  tag: "rri-v2026.10.08",
  attached: { official: "RaccoltaRegolamentiInterni.pdf", differences: "differenze-rri-v2026.10.08.pdf" },
  categories: [{ title: "Team e Team Lead", summary: "Il mandato dei Team Lead passa da uno a due anni." }],
  oppositionDeadline: "18/10/2026",
  dashboardUrl: "https://admin.polinetwork.org/dashboard/regulations/drafts/abc/diff",
}

export default RegulationEmanatedEmail
