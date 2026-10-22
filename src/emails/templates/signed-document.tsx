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

export type SignedDocumentProps = {
  title: string
  signers: { name: string; role: string | null }[]
  /** The requester's own words, written for these recipients. */
  message: string | null
  /** Link to the file when it is too large to attach. */
  link: string | null
  /** Whoever sent the request; replies go to their email. */
  sentBy: { name: string; email: string | null } | null
}

/** Sent to people outside PoliNetwork, so in Italian. */
const SignedDocumentEmail: EmailTemplate<SignedDocumentProps> = ({ title, signers, message, link, sentBy }) => {
  // The requester's message usually says what is attached: the fixed line says it only when there is none.
  const lead = link ? (
    <>
      Il documento firmato è troppo grande per essere allegato: <Link href={link}>aprilo su OneDrive</Link>.{" "}
    </>
  ) : message ? null : (
    "Il documento firmato è in allegato. "
  )
  return (
    <Html lang="it">
      <Tailwind config={{ presets: [pixelBasedPreset] }}>
        <Head />
        <Preview>Documento firmato: {title}</Preview>
        <Body className="m-0 bg-white p-0 font-sans text-base leading-normal">
          <Logo />
          <Container className="mx-auto bg-white px-5 max-w-[460px]">
            <Heading className="m-0 text-center text-2xl font-bold leading-8">{title}</Heading>
            <Section className="py-8">
              {message && <Text className="my-2 whitespace-pre-line text-base leading-normal">{message}</Text>}
              <Text className="my-2 text-base leading-normal">
                {lead}
                {lead ? "È stato firmato" : "Il documento è stato firmato"} elettronicamente con la Carta d’Identità
                Elettronica (CIE) da:
              </Text>
              {signers.map((s) => (
                <Text key={s.name} className="my-1 text-base leading-normal">
                  • {s.name}
                  {s.role ? `, ${s.role}` : ""}
                </Text>
              ))}
            </Section>
          </Container>
          <Footer>
            {sentBy ? `Inviato da ${sentBy.name} tramite PoliNetwork.` : "Inviato tramite PoliNetwork."}{" "}
            {sentBy?.email
              ? `Rispondi a questa email per scrivere a ${sentBy.name}.`
              : "Non rispondere a questa email."}
          </Footer>
        </Body>
      </Tailwind>
    </Html>
  )
}

SignedDocumentEmail.PreviewProps = {
  title: "Verbale del Consiglio Direttivo del 10 ottobre 2026",
  signers: [
    { name: "Mario Rossi", role: "Segretario" },
    { name: "Anna Bianchi", role: "Presidente" },
  ],
  message: "Buongiorno,\nvi inoltro il verbale firmato del Consiglio Direttivo.",
  link: null,
  sentBy: { name: "Luca Verdi", email: "luca.verdi@polinetwork.org" },
}

export default SignedDocumentEmail
