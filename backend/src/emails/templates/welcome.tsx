import React from "react"
import {
  Body,
  Container,
  Head,
  Heading,
  Html,
  Img,
  Link,
  Preview,
  pixelBasedPreset,
  Tailwind,
  Text,
} from "@react-email/components"

type Props = {
  firstName: string
  assocNum: number
  email: string
  password: string
}

const WelcomeEmail = (props: Props) => {
  return (
    <Html>
      <Tailwind
        config={{
          presets: [pixelBasedPreset],
        }}
      >
        <Head></Head>
        <Preview>Congratulations! You joined PoliNetwork APS...</Preview>

        <Body className="bg-white font-sans text-base">
          <Img
            src={`https://raw.githubusercontent.com/PoliNetworkOrg/Logo/a1e02bf150ac0b3c734a629901eada79fb4fd762/Logo.svg`}
            width="100"
            height="100"
            alt="PoliNetwork APS Logo"
            className="mx-auto my-10"
          />
          <Container className="bg-white">
            <Heading className="my-0 text-center leading-8">Welcome to PoliNetwork APS</Heading>

            <div className="flex flex-col gap-3 py-8">
              <Text className="text-base my-2">
                Congratulations <span className="font-bold">{props.firstName}</span>! Thanks for joining our
                Association!
                <br /> You are officially associated with number {props.assocNum}.
              </Text>

              <Text className="text-base my-2">
                To activate your Office 365 account, using a PC open{" "}
                <Link target="_blank" className="underline text-[#1156AE] cursor-pointer">
                  Microsoft Login
                </Link>{" "}
                insert the credentials and follow the onboarding. <br />
              </Text>

              <div className="grid grid-cols-1 grid-rows-4 min-[370px]:grid-cols-[auto_1fr] min-[370px]:grid-rows-2 gap-x-8 gap-y-2 items-center min-[370px]:pl-7">
                <Text className="text-sm my-0">email</Text>
                <Text className="text-xs my-0 rounded-lg border border-gray-300 bg-gray-200 px-2 py-1 font-mono text-gray-800 select-all w-min">
                  {props.email}
                </Text>
                <Text className="text-sm my-0">password</Text>
                <Text
                  className="text-xs my-0 rounded-lg border border-gray-300 bg-gray-200 px-2 py-1 font-mono text-gray-800 select-all w-min password-group"
                  tabIndex={0}
                >
                  {props.password}
                </Text>
              </div>

              <Text className="text-base my-2">
                It will ask you to change the password and setup 2FA, please follow the instructions.
              </Text>

              <Text className="text-base my-2">
                <span className="font-bold text-red-700">Important!</span> Add this new email to your client (e.g.
                Outlook) as you’ll receive <span className="font-bold">official communications</span>, such as meeting
                notices, renewals, receipts, and more.
              </Text>

              <Text className="text-base my-2">
                If you encounter any issue or have some questions, please contact me on{" "}
                <Link target="_blank" className="underline text-[#1156AE] cursor-pointer">
                  Telegram
                </Link>{" "}
              </Text>

              <Text className="text-sm text-gray-700 my-2">~ Lorenzo Corallo</Text>
            </div>
          </Container>

          <Container className="flex justify-center items-center">
            <Link
              target="_blank"
              href="https://polinetwork.org"
              className="mb-45 text-center text-xs text-gray-400 underline"
            >
              PoliNetwork APS
            </Link>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  )
}

WelcomeEmail.PreviewProps = {
  firstName: "Mario",
  email: "mario.rossi@polinetwork.org",
  password: "R@123456789012ab",
  assocNum: 12,
} satisfies Props

export default WelcomeEmail
