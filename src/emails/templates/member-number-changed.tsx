import {
  Body,
  CodeInline,
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
  firstName: string | null
  assocNum: number
  previousAssocNum: string | null
  email: string | null
}

const MemberNumberChangedEmail: EmailTemplate<Props> = (props) => {
  return (
    <Html>
      <Tailwind config={{ presets: [pixelBasedPreset] }}>
        <Head />
        <Preview>Your PoliNetwork member number is now {props.assocNum.toString()}</Preview>

        <Body className="m-0 bg-white p-0 font-sans text-base leading-normal">
          <Logo />

          {/* Main Content Container */}
          <Container className="mx-auto bg-white px-5">
            <Heading className="m-0 text-center text-2xl font-bold leading-8">Your member number has changed</Heading>

            {/* Content Section */}
            <Section className="py-8">
              <Text className="my-2 text-base leading-normal">
                {props.firstName ? (
                  <>
                    Hi <strong>{props.firstName}</strong>,
                  </>
                ) : (
                  "Hi,"
                )}
                <br /> your PoliNetwork member number is now <strong>{props.assocNum}</strong>
                {props.previousAssocNum ? <> (previously number {props.previousAssocNum})</> : null}.
              </Text>

              {props.email ? (
                <>
                  <Text className="my-4 text-base leading-normal">Microsoft 365 account</Text>

                  <Section className="p-4 bg-blue-100 rounded-md">
                    <CodeInline className="text-xs sm:text-sm">{props.email}</CodeInline>
                  </Section>
                </>
              ) : null}

              <Text className="my-4 text-base leading-normal">
                For help, contact IT on{" "}
                <Link href="https://t.me/lorenzocorallo" className="text-[#1156AE] underline">
                  Telegram
                </Link>{" "}
                or at{" "}
                <Link href="mailto:it@polinetwork.org" className="text-[#1156AE] underline">
                  it@polinetwork.org
                </Link>
              </Text>

              <Text className="my-2 text-sm leading-normal text-gray-700">~ Lorenzo Corallo, Team Lead IT</Text>
            </Section>
          </Container>

          <Footer />
        </Body>
      </Tailwind>
    </Html>
  )
}

MemberNumberChangedEmail.PreviewProps = {
  firstName: "Mario",
  assocNum: 456,
  previousAssocNum: "123",
  email: "mario.rossi@polinetwork.org",
}

export default MemberNumberChangedEmail
