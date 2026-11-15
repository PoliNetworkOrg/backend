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
  releaseUrl: string
  /** The dashboard's web view of the changes. */
  webUrl: string | null
  categories: { title: string; summary: string }[]
  /** `DD/MM/YYYY`, or null for a rettifica without an opposition window. */
  oppositionDeadline: string | null
}

/** To the Soci, in Italian. Replies go to the Direttivo. */
const RegulationEmanatedEmail: EmailTemplate<RegulationEmanatedProps> = (p) => (
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
              È stata emanata una nuova versione. Il testo ufficiale è nella{" "}
              <Link href={p.releaseUrl}>pagina della versione</Link>
              {p.webUrl ? (
                <>
                  ; le modifiche si possono consultare anche <Link href={p.webUrl}>nella dashboard</Link>
                </>
              ) : null}
              . In allegato il documento delle differenze, che non ha valore ufficiale.
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
          </Section>
        </Container>
        <Footer>
          Notifica del Consiglio Direttivo di PoliNetwork. Rispondi a questa email per scrivere al Direttivo.
        </Footer>
      </Body>
    </Tailwind>
  </Html>
)

RegulationEmanatedEmail.PreviewProps = {
  documentTitle: "Raccolta dei Regolamenti Interni",
  deliberaLine: "Approvato dal Consiglio Direttivo il 08/10/2026",
  tag: "rri-v2026.10.08",
  releaseUrl: "https://github.com/PoliNetworkOrg/legal/releases/tag/rri-v2026.10.08",
  webUrl: "https://admin.polinetwork.org/dashboard/regolamenti",
  categories: [{ title: "Team e Team Lead", summary: "Il mandato dei Team Lead passa da uno a due anni." }],
  oppositionDeadline: "18/10/2026",
}

export default RegulationEmanatedEmail
