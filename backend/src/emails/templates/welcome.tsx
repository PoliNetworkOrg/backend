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
  Row,
  Section,
  Tailwind,
  Text,
} from "@react-email/components"
import type React from "react"
import { Footer } from "../components/footer"
import { Logo } from "../components/logo"

type Props = {
  firstName: string
  assocNum: number
  email: string
  password: string
}

const WelcomeEmail: React.FC<Readonly<Props>> = (props) => {
  return (
    <Html>
      <Tailwind config={{ presets: [pixelBasedPreset] }}>
        <Head />
        <Preview>Congratulations! You joined PoliNetwork APS...</Preview>

        <Body className="m-0 bg-white p-0 font-sans text-base leading-normal">
          <Logo />

          {/* Main Content Container */}
          <Container className="mx-auto bg-white px-5">
            <Heading className="m-0 text-center text-2xl font-bold leading-8">
              Welcome to <span className="whitespace-nowrap">PoliNetwork APS</span>
            </Heading>

            {/* Content Section */}
            <Section className="py-8">
              <Text className="my-2 text-base leading-normal">
                Congratulations <strong>{props.firstName}</strong>! Thanks for joining our Association!
                <br /> You are officially associated with <strong>number {props.assocNum}</strong>.
              </Text>

              <Text className="my-4 text-base leading-normal">
                To activate your Office 365 account, using a PC open{" "}
                <Link href="https://outlook.office.com" className="text-[#1156AE] underline">
                  Microsoft Login
                </Link>
                , enter the following credentials and follow the onboarding.
              </Text>

              <Section className="p-4 bg-blue-100 rounded-md">
                <Row>
                  <EmailWithoutHref email={props.email} />
                </Row>
                <Row>
                  <CodeInline className="text-xs sm:text-sm">{props.password}</CodeInline>
                </Row>
              </Section>

              <Text className="my-4 text-base leading-normal">
                It will ask you to change the password and setup 2FA, please follow the instructions.
              </Text>

              <Text className="my-4 text-base leading-normal">
                <span className="font-bold text-red-700">Important!</span> Add this new email to your client (e.g.
                Outlook) as you'll receive <strong>official communications</strong>, such as meeting notices, renewals,
                receipts, and more.
              </Text>

              <Text className="my-4 text-base leading-normal">
                If you encounter any issue or have some questions, please contact me on{" "}
                <Link href="https://t.me/lorenzocorallo" className="text-[#1156AE] underline">
                  Telegram
                </Link>
              </Text>

              <Text className="my-2 text-sm leading-normal text-gray-700">~ Lorenzo Corallo</Text>
            </Section>
          </Container>

          <Footer />
        </Body>
      </Tailwind>
    </Html>
  )
}

const EmailWithoutHref = ({ email }: { email: string }) => {
  const [user, domain] = email.split("@")
  const [domainName, domainTld] = domain.split(".")
  if (!domain || !domainTld) return <CodeInline className="break-all text-xs sm:text-sm">{email}</CodeInline> // fallback if something goes wrong
  return (
    <CodeInline className="break-all text-xs sm:text-sm">
      {user}
      {"\u200C"}@{domainName}
      {"\u200C"}.{domainTld}
    </CodeInline>
  )
}

// @ts-expect-error idk how to make this work rn
WelcomeEmail.PreviewProps = {
  firstName: "Mario",
  email: "mario.rossi@polinetwork.org",
  password: "R@123456789012ab",
  assocNum: 12,
} satisfies Props

export default WelcomeEmail
