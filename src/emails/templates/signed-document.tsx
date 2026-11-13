import { Link } from "@react-email/components"
import { EmailLayout, linkStyle, MailText } from "../components/email-layout"
import { Multiline } from "../components/multiline"
import type { EmailTemplate } from "../types"

export type SignedDocumentProps = {
  title: string
  signers: { name: string; role: string | null }[]
  message: string | null
  link: string | null
  sentBy: { name: string; email: string | null } | null
}
const SignedDocumentEmail: EmailTemplate<SignedDocumentProps> = ({ title, signers, message, link, sentBy }) => {
  const lead = link ? (
    <>
      Il documento firmato è troppo grande per essere allegato:{" "}
      <Link href={link} style={linkStyle}>
        aprilo su OneDrive
      </Link>
      .{" "}
    </>
  ) : message ? null : (
    "Il documento firmato è in allegato. "
  )
  return (
    <EmailLayout
      kind="signed-document"
      preview={`Documento firmato: ${title}`}
      footer={
        <>
          {sentBy ? `Inviato da ${sentBy.name} tramite PoliNetwork.` : "Inviato tramite PoliNetwork."}{" "}
          {sentBy?.email ? `Rispondi a questa email per scrivere a ${sentBy.name}.` : "Non rispondere a questa email."}
        </>
      }
    >
      <MailText>
        <strong>{title}</strong>
      </MailText>
      {message && (
        <MailText>
          <Multiline>{message}</Multiline>
        </MailText>
      )}
      <MailText>
        {lead}
        {lead ? "È stato firmato" : "Il documento è stato firmato"} elettronicamente con la Carta d’Identità Elettronica
        (CIE) da:
      </MailText>
      {signers.map((signer) => (
        <MailText key={signer.name} style={{ margin: "8px 0" }}>
          • {signer.name}
          {signer.role ? `, ${signer.role}` : ""}
        </MailText>
      ))}
    </EmailLayout>
  )
}
SignedDocumentEmail.PreviewProps = {
  title: "Verbale del Consiglio Direttivo del 10 ottobre 2026",
  signers: [
    { name: "Mario Rossi", role: "Segretario" },
    { name: "Anna Bianchi", role: "Presidente" },
  ],
  message: "Buongiorno,\nvi inoltro il verbale firmato del Consiglio Direttivo.",
  link: null,
  sentBy: { name: "Luca Verdi", email: "luca.verdi@polinetwork.org" },
}
export default SignedDocumentEmail
