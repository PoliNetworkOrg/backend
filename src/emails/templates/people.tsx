import {
  Body,
  Button,
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

export type PeopleEmailProps = {
  subject: string
  /** The recipient's first name, for the greeting. */
  firstName: string | null
  /** Paragraphs separated by blank lines. */
  text: string
  action: { label: string; url: string } | null
}

/** Every People email: members and volunteers read them in Italian. */
const PeopleEmail: EmailTemplate<PeopleEmailProps> = ({ subject, firstName, text, action }) => {
  const paragraphs = text.split(/\n\s*\n/)
  const title = subject.replace(/^PoliNetwork · | · PoliNetwork$/g, "")
  return (
    <Html lang="it">
      <Tailwind config={{ presets: [pixelBasedPreset] }}>
        <Head />
        <Preview>{paragraphs[0]}</Preview>
        <Body className="m-0 bg-white p-0 font-sans text-base leading-normal">
          <Logo />
          <Container className="mx-auto bg-white px-5 max-w-[460px]">
            <Heading className="m-0 text-center text-2xl font-bold leading-8">
              {title.charAt(0).toUpperCase() + title.slice(1)}
            </Heading>
            <Section className="py-8">
              <Text className="my-2 text-base leading-normal">{firstName ? `Ciao ${firstName},` : "Ciao,"}</Text>
              {paragraphs.map((p) => (
                <Text key={p} className="my-2 whitespace-pre-line text-base leading-normal">
                  {p}
                </Text>
              ))}
              {action && (
                <>
                  <Section className="my-6 text-center">
                    <Button
                      href={action.url}
                      className="rounded-md bg-[#1156AE] px-5 py-3 text-base font-semibold text-white"
                    >
                      {action.label}
                    </Button>
                  </Section>
                  <Text className="my-4 text-sm leading-normal text-gray-700">
                    Se il pulsante non funziona, copia questo indirizzo nel browser:{" "}
                    <Link href={action.url} className="break-all text-[#1156AE] underline">
                      {action.url}
                    </Link>
                  </Text>
                </>
              )}
              <Text className="my-2 text-base leading-normal">A presto,</Text>
              <Text className="my-2 text-base leading-normal">PoliNetwork</Text>
            </Section>
          </Container>
          <Footer>Messaggio automatico di PoliNetwork APS: non rispondere a questa email.</Footer>
        </Body>
      </Tailwind>
    </Html>
  )
}

PeopleEmail.PreviewProps = {
  subject: "PoliNetwork · collega il tuo account",
  firstName: "Mario",
  text: "Ti abbiamo invitato a collegare il tuo account PoliNetwork alla tua scheda nell'associazione.\n\nScadenza dell'invito: 11 novembre 2026.",
  action: {
    label: "Collega il tuo account",
    url: "https://admin.polinetwork.org/dashboard/account/me?peopleInvite=abc",
  },
}

export default PeopleEmail
