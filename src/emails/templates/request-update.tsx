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
import type { RequestUpdate } from "@/esign/service"
import { Footer } from "../components/footer"
import { Logo } from "../components/logo"
import type { EmailTemplate } from "../types"

export const requestUpdateSubject = (props: RequestUpdate) =>
  `${{ declined: "Declined", completed: "Signed by everyone", delivery_failed: "Not delivered" }[props.outcome]}: ${props.title}`

function Summary(props: RequestUpdate) {
  const title = <strong>{props.title}</strong>
  switch (props.outcome) {
    case "declined":
      return (
        <>
          <Text className="my-2 text-base leading-normal">
            {props.by} declined to sign {title}.
          </Text>
          {props.reason && (
            <Text className="my-4 whitespace-pre-line border-0 border-l-4 border-solid border-gray-300 pl-3 text-base leading-normal text-gray-700">
              “{props.reason}”
            </Text>
          )}
        </>
      )
    case "completed": {
      const { savedTo, emailedTo } = props
      const saved = savedTo && (savedTo.url ? <Link href={savedTo.url}>{savedTo.path}</Link> : savedTo.path)
      const emailed = emailedTo.length > 0 && emailedTo.join(", ")
      return (
        <Text className="my-2 text-base leading-normal">
          Everyone signed {title}.
          {(saved || emailed) && (
            <>
              {" "}
              The signed PDF {saved && <>is saved in {saved}</>}
              {saved && emailed && " and "}
              {emailed && `was emailed to ${emailed}`}.
            </>
          )}
        </Text>
      )
    }
    case "delivery_failed":
      return (
        <>
          <Text className="my-2 text-base leading-normal">
            Everyone signed {props.requestedBy ? <>{props.requestedBy}’s request </> : null}
            {title}, but the signed PDF couldn’t be {props.failed.step === "save" ? "saved to" : "emailed to"}{" "}
            {props.failed.target}. {props.canRetry ? "You can retry it from the request." : "A manager can retry it."}
          </Text>
          <Text className="my-2 text-sm leading-normal text-gray-700">Error: {props.error}</Text>
        </>
      )
  }
}

/** Tells a request's creator, and for a failed delivery its managers, how it ended. */
const RequestUpdateEmail: EmailTemplate<RequestUpdate> = (props) => {
  const heading = {
    declined: "Request declined",
    completed: "Everyone signed",
    delivery_failed: "The signed PDF wasn’t delivered",
  }[props.outcome]
  return (
    <Html>
      <Tailwind config={{ presets: [pixelBasedPreset] }}>
        <Head />
        <Preview>{requestUpdateSubject(props)}</Preview>
        <Body className="m-0 bg-white p-0 font-sans text-base leading-normal">
          <Logo />
          <Container className="mx-auto bg-white px-5 max-w-[460px]">
            <Heading className="m-0 text-center text-2xl font-bold leading-8">{heading}</Heading>
            <Section className="py-8">
              <Text className="my-2 text-base leading-normal">Hi {props.recipientName},</Text>
              <Summary {...props} />
              <Section className="my-6 text-center">
                <Button
                  href={props.url}
                  className="rounded-md bg-[#1156AE] px-5 py-3 text-base font-semibold text-white"
                >
                  Open the request
                </Button>
              </Section>
            </Section>
          </Container>
          <Footer />
        </Body>
      </Tailwind>
    </Html>
  )
}

RequestUpdateEmail.PreviewProps = {
  recipientName: "Luca",
  title: "Verbale del Consiglio Direttivo del 10 ottobre 2026",
  url: "https://admin.polinetwork.org/dashboard/esign/requests/1",
  outcome: "declined",
  by: "Anna Bianchi",
  reason: "La data della riunione è sbagliata.",
}

export default RequestUpdateEmail
