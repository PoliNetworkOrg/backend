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
import { Footer } from "@/emails/components/footer"
import { Logo } from "@/emails/components/logo"
import type { EmailTemplate } from "@/emails/types"

type Props = { firstName: string; subject: string; body: string }

const CustomMessageEmail: EmailTemplate<Props> = (props) => {
  const paragraphs = props.body.split(/\n{2,}/).filter((p) => p.trim())
  return (
    <Html>
      <Tailwind config={{ presets: [pixelBasedPreset] }}>
        <Head />
        <Preview>{props.subject}</Preview>
        <Body className="m-0 bg-white p-0 font-sans text-base leading-normal">
          <Logo />
          <Container className="mx-auto bg-white px-5">
            <Heading className="m-0 text-center text-2xl font-bold leading-8">{props.subject}</Heading>
            <Section className="py-8">
              <Text>
                Dear <strong>{props.firstName}</strong>,
              </Text>
              {paragraphs.map((p, i) => (
                <Text key={i} className="my-4 whitespace-pre-line">
                  {p}
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

CustomMessageEmail.PreviewProps = {
  firstName: "Mario",
  subject: "Renew your PoliNetwork membership",
  body: "Dear Mario,\n\n please renew your membership.",
}

export default CustomMessageEmail
