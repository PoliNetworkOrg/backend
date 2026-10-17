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

type Props = {
  title: string
  signers: { name: string; role: string | null }[]
  message: string | null
  /** Link to the file when it is too large to attach. */
  link: string | null
}

const SignedDocumentEmail: EmailTemplate<Props> = ({ title, signers, message, link }) => {
  return (
    <Html>
      <Tailwind config={{ presets: [pixelBasedPreset] }}>
        <Head />
        <Preview>Signed document: {title}</Preview>
        <Body className="m-0 bg-white p-0 font-sans text-base leading-normal">
          <Logo />
          <Container className="mx-auto bg-white px-5 max-w-[460px]">
            <Heading className="m-0 text-center text-2xl font-bold leading-8">{title}</Heading>
            <Section className="py-8">
              {message && <Text className="my-2 whitespace-pre-line text-base leading-normal">{message}</Text>}
              <Text className="my-2 text-base leading-normal">
                {link ? (
                  <>
                    The signed document is available <Link href={link}>here</Link>.
                  </>
                ) : (
                  "The signed document is attached."
                )}{" "}
                It was signed electronically with the Italian identity card (CIE) by:
              </Text>
              {signers.map((s) => (
                <Text key={s.name} className="my-1 text-base leading-normal">
                  • {s.name}
                  {s.role ? `, ${s.role}` : ""}
                </Text>
              ))}
            </Section>
          </Container>
          <Footer />
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
  message: "In allegato il verbale firmato.",
  link: null,
}

export default SignedDocumentEmail
