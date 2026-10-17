import {
  Body,
  Button,
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

type Props = {
  signerName: string
  requestedBy: string
  title: string
  role: string | null
  url: string
}

const SignatureRequestEmail: EmailTemplate<Props> = ({ signerName, requestedBy, title, role, url }) => {
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
                {role ? ` as ${role}` : ""}. It is your turn now.
              </Text>
              <Section className="my-6 text-center">
                <Button href={url} className="rounded-md bg-[#1156AE] px-5 py-3 text-base font-semibold text-white">
                  Open in the dashboard
                </Button>
              </Section>
              <Text className="my-4 text-sm leading-normal text-gray-700">
                You will need your CIE, its PIN and an NFC card reader on a computer with the PoliNetwork Sign Agent.
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
  url: "https://admin.polinetwork.org/dashboard/esign/requests/1",
}

export default SignatureRequestEmail
