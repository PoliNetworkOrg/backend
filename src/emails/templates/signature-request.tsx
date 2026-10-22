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

type Props = {
  signerName: string
  requestedBy: string
  title: string
  role: string | null
  /** Signers sign one after another: this signer's turn has come. Otherwise every signer may sign now. */
  ordered: boolean
  url: string
  setupUrl: string
}

const SignatureRequestEmail: EmailTemplate<Props> = ({
  signerName,
  requestedBy,
  title,
  role,
  ordered,
  url,
  setupUrl,
}) => {
  return (
    <Html>
      <Tailwind config={{ presets: [pixelBasedPreset] }}>
        <Head />
        <Preview>Your signature is needed on “{title}”</Preview>
        <Body className="m-0 bg-white p-0 font-sans text-base leading-normal">
          <Logo />
          <Container className="mx-auto bg-white px-5 max-w-[460px]">
            <Heading className="m-0 text-center text-2xl font-bold leading-8">Your signature is needed</Heading>
            <Section className="py-8">
              <Text className="my-2 text-base leading-normal">Hi {signerName},</Text>
              <Text className="my-2 text-base leading-normal">
                {requestedBy} asked you to sign <strong>{title}</strong>
                {role ? ` as ${role}` : ""}. {ordered ? "It is your turn now." : "You can sign it now."}
              </Text>
              <Section className="my-6 text-center">
                <Button href={url} className="rounded-md bg-[#1156AE] px-5 py-3 text-base font-semibold text-white">
                  Open in the dashboard
                </Button>
              </Section>
              <Text className="my-4 text-sm leading-normal text-gray-700">
                You will need your CIE, its PIN and an NFC card reader on a computer with PoliNetwork eSign installed.
                First time signing on this computer? Follow the{" "}
                <Link href={setupUrl} className="text-[#1156AE] underline">
                  setup guide
                </Link>{" "}
                first.
              </Text>
            </Section>
          </Container>
          <Footer />
        </Body>
      </Tailwind>
    </Html>
  )
}

SignatureRequestEmail.PreviewProps = {
  signerName: "Anna",
  requestedBy: "Mario Rossi",
  title: "Verbale del Consiglio Direttivo del 10 ottobre 2026",
  role: "Presidente",
  ordered: true,
  url: "https://admin.polinetwork.org/dashboard/esign/requests/1",
  setupUrl: "https://admin.polinetwork.org/dashboard/esign/setup",
}

export default SignatureRequestEmail
