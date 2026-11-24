import { Body, Heading, Html, Preview } from "@react-email/components"
import { MailText } from "../components/email-layout"
import { Multiline } from "../components/multiline"
import type { ProblemReport } from "../problem-report-routes"

export default function ProblemReportEmail({ email, subject, description }: ProblemReport) {
  return (
    <Html lang="it">
      <Preview>{subject}</Preview>
      <Body style={{ padding: 24, fontFamily: "Arial, sans-serif" }}>
        <Heading>Segnalazione dal sito</Heading>
        <MailText>
          <strong>{subject}</strong>
        </MailText>
        <MailText>Email di ricontatto: {email}</MailText>
        <MailText>
          <Multiline>{description}</Multiline>
        </MailText>
        <MailText>
          Puoi rispondere direttamente a questa email per ricontattare chi ha inviato la segnalazione.
        </MailText>
      </Body>
    </Html>
  )
}
