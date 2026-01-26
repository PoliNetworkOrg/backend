import {
  Body,
  CodeInline,
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
  otp: string
  expiresInMinutes?: number
  // type: "LOGIN" // use it to differentiate OTPs
}

const OtpEmail: EmailTemplate<Props> = ({ otp, expiresInMinutes }) => {
  return (
    <Html>
      <Tailwind config={{ presets: [pixelBasedPreset] }}>
        <Head>
          <meta name="format-detection" content="telephone=no" />
        </Head>
        <Preview>Your verification code is: {otp}</Preview>

        <Body className="m-0 bg-white p-0 font-sans text-base leading-normal">
          <Logo />

          {/* Main Content Container */}
          <Container className="mx-auto bg-white px-5 max-w-[460px]">
            <Heading className="m-0 text-center text-2xl font-bold leading-8">Verification Code</Heading>

            {/* Content Section */}
            <Section className="py-8">
              <Text className="my-2 text-center text-base leading-normal">
                Use the following code to verify your identity:
              </Text>

              <Section className="my-6 p-6 bg-blue-100 rounded-md text-center">
                <CodeInline className="text-3xl font-bold tracking-wide">{otp}</CodeInline>
              </Section>

              {expiresInMinutes && (
                <Text className="my-4 text-center text-sm leading-normal">
                  This code will expire in <strong>{expiresInMinutes} minutes</strong>.
                </Text>
              )}

              <Text className="my-4 text-center text-sm leading-normal text-gray-700">
                If you didn't request this code, you can safely ignore this email.
              </Text>
            </Section>
          </Container>

          <Footer />
        </Body>
      </Tailwind>
    </Html>
  )
}

OtpEmail.PreviewProps = {
  otp: "123456",
  expiresInMinutes: 10,
}

export default OtpEmail
