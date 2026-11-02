import {
  Body,
  Container,
  Head,
  Heading,
  Html,
  Preview,
  pixelBasedPreset,
  Section,
  Tailwind,
  Text,
} from "@react-email/components"
import { Footer } from "../components/footer"
import { Logo } from "../components/logo"
import type { EmailTemplate } from "../types"

export type RegulationDelegaProps = {
  /** - `created`/`revoked`: to the Direttivo (Statuto, art. "Direttivo", comma 9: every delega is notified);
   *  - `used`: to the Segretario who granted it, for each rettifica emanated under it. */
  change: "created" | "revoked" | "used"
  grantor: string
  grantee: string
  /** The document it covers, or null for every document. */
  scope: string | null
  expiresOn: string | null
  note: string | null
  actor: string
  /** For `used`. */
  rettifica?: { documentTitle: string; tag: string; releaseUrl: string } | null
}

export function delegaSubject(p: RegulationDelegaProps) {
  if (p.change === "used") return `Rettifica emanata su tua delega: ${p.rettifica?.documentTitle ?? ""}`
  return `${p.change === "created" ? "Nuova delega" : "Delega revocata"}: rettifica dei regolamenti a ${p.grantee}`
}

const RegulationDelegaEmail: EmailTemplate<RegulationDelegaProps> = (p) => (
  <Html lang="it">
    <Tailwind config={{ presets: [pixelBasedPreset] }}>
      <Head />
      <Preview>{delegaSubject(p)}</Preview>
      <Body className="m-0 bg-white p-0 font-sans text-base leading-normal">
        <Logo />
        <Container className="mx-auto bg-white px-5 max-w-[520px]">
          <Heading className="m-0 text-center text-2xl font-bold leading-8">{delegaSubject(p)}</Heading>
          <Section className="py-6">
            {p.change === "used" && p.rettifica ? (
              <Text>
                {p.grantee} ha emanato una rettifica di «{p.rettifica.documentTitle}» ({p.rettifica.tag}) su delega del
                Segretario: {p.rettifica.releaseUrl}. La responsabilità resta del Segretario delegante.
              </Text>
            ) : (
              <Text>
                {p.change === "created"
                  ? `${p.grantor} ha delegato a ${p.grantee} la rettifica dei regolamenti (errori ortografici, di battitura o grammaticali che non ne alterano il significato), mantenendone la responsabilità.`
                  : `${p.actor} ha revocato la delega a ${p.grantee} per la rettifica dei regolamenti, concessa da ${p.grantor}.`}
              </Text>
            )}
            {p.change !== "used" && (
              <>
                <Text className="my-1">Ambito: {p.scope ?? "tutti i regolamenti"}</Text>
                <Text className="my-1">Scadenza: {p.expiresOn ?? "nessuna (fino a revoca)"}</Text>
                {p.note && <Text className="my-1">Nota: {p.note}</Text>}
              </>
            )}
          </Section>
        </Container>
        <Footer>Notifica automatica della dashboard di PoliNetwork.</Footer>
      </Body>
    </Tailwind>
  </Html>
)

RegulationDelegaEmail.PreviewProps = {
  change: "created",
  grantor: "Sara Segretario",
  grantee: "Davide Delegato",
  scope: "Raccolta dei Regolamenti Interni",
  expiresOn: "31/12/2026",
  note: null,
  actor: "Sara Segretario",
}

export default RegulationDelegaEmail
