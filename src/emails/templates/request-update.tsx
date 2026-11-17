import { Link } from "@react-email/components"
import type { RequestUpdate } from "@/esign/service"
import { EmailLayout, linkStyle, MailAction, MailText, smallText } from "../components/email-layout"
import { Multiline } from "../components/multiline"
import type { EmailTemplate } from "../types"

export const requestUpdateSubject = (props: RequestUpdate) =>
  `${{ declined: "Firma rifiutata", completed: "Tutte le firme sono state raccolte", delivery_failed: "Il PDF firmato non è stato consegnato" }[props.outcome]}: ${props.title}`
function Summary(props: RequestUpdate) {
  const title = <strong>{props.title}</strong>
  switch (props.outcome) {
    case "declined":
      return (
        <>
          <MailText>
            {props.by} ha rifiutato di firmare {title}.
          </MailText>
          {props.reason && (
            <MailText style={{ borderLeft: "4px solid #cbd5e1", paddingLeft: 12 }}>
              “<Multiline>{props.reason}</Multiline>”
            </MailText>
          )}
        </>
      )
    case "completed": {
      const { savedTo, emailedTo } = props
      const saved =
        savedTo &&
        (savedTo.url ? (
          <Link href={savedTo.url} style={linkStyle}>
            {savedTo.path}
          </Link>
        ) : (
          savedTo.path
        ))
      const emailed = emailedTo.length > 0 && emailedTo.join(", ")
      return (
        <MailText>
          Tutti hanno firmato {title}.
          {(saved || emailed) && (
            <>
              {" "}
              Il PDF firmato {saved && <>è salvato in {saved}</>}
              {saved && emailed && " ed "}
              {emailed && `è stato inviato via email a ${emailed}`}.
            </>
          )}
        </MailText>
      )
    }
    case "delivery_failed":
      return (
        <>
          <MailText>
            Non è stato possibile {props.failed.step === "save" ? "salvare in" : "inviare a"} {props.failed.target} il
            PDF firmato relativo alla richiesta{props.requestedBy ? ` di ${props.requestedBy}` : ""}, {title}.{" "}
            {props.canRetry
              ? "Puoi riprovare dalla pagina della richiesta."
              : "Un responsabile può riprovare dalla pagina della richiesta."}
          </MailText>
          <MailText style={smallText}>
            Errore: <Multiline>{props.error}</Multiline>
          </MailText>
        </>
      )
  }
}
const RequestUpdateEmail: EmailTemplate<RequestUpdate> = (props) => (
  <EmailLayout
    kind={
      (
        {
          declined: "request-update",
          completed: "request-completed",
          delivery_failed: "request-delivery-failed",
        } as const
      )[props.outcome]
    }
    preview={requestUpdateSubject(props)}
  >
    <MailText>Ciao {props.recipientName},</MailText>
    <Summary {...props} />
    <MailAction href={props.url}>Apri la richiesta</MailAction>
  </EmailLayout>
)
RequestUpdateEmail.PreviewProps = {
  recipientName: "Luca",
  title: "Verbale del Consiglio Direttivo del 10 ottobre 2026",
  url: "https://admin.polinetwork.org/dashboard/esign/requests/1",
  outcome: "declined",
  by: "Anna Bianchi",
  reason: "La data della riunione è sbagliata.",
}
export default RequestUpdateEmail
