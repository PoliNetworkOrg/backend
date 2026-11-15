import { Link } from "@react-email/components"
import { EmailLayout, linkStyle, MailAction, MailText, smallText } from "../components/email-layout"
import type { EmailTemplate } from "../types"

type Props = {
  signerName: string
  requestedBy: string
  title: string
  role: string | null
  ordered: boolean
  url: string
  setupUrl: string
}
export const signatureRequestSubject = (props: Props) => `È richiesta la tua firma: ${props.title}`
const SignatureRequestEmail: EmailTemplate<Props> = ({
  signerName,
  requestedBy,
  title,
  role,
  ordered,
  url,
  setupUrl,
}) => (
  <EmailLayout kind="signature-request" preview={`${requestedBy} ti ha chiesto di firmare “${title}”`}>
    <MailText>Ciao {signerName},</MailText>
    <MailText>
      {requestedBy} ti ha chiesto di firmare <strong>{title}</strong>
      {role ? ` in qualità di ${role}` : ""}. {ordered ? "Ora è il tuo turno." : "Puoi firmare ora."}
    </MailText>
    <MailAction href={url}>Apri nella tua area personale</MailAction>
    <MailText style={smallText}>
      Per firmare servono la tua Carta d’Identità Elettronica (CIE), il relativo PIN e un lettore NFC collegato a un
      computer con PoliNetwork eSign installato. Se è la prima volta che firmi da questo computer, segui prima la{" "}
      <Link href={setupUrl} style={linkStyle}>
        guida alla configurazione
      </Link>
      .
    </MailText>
  </EmailLayout>
)
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
