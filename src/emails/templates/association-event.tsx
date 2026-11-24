import { EmailLayout, MailAction, MailText, smallText } from "../components/email-layout"
import { Multiline } from "../components/multiline"
import type { EmailTemplate } from "../types"

/** A calendar event moved (submitted, changes requested, approved, rejected, withdrawn) or got a comment. */
export type AssociationEventProps = {
  associationName: string
  title: string
  status: string
  summary: string
  note: string | null
  actor: string
  url: string
}

const AssociationEventEmail: EmailTemplate<AssociationEventProps> = (props) => (
  <EmailLayout heading="Evento nel calendario" preview={`${props.status}: ${props.title}`}>
    <MailText>
      <strong>{props.title}</strong> · {props.associationName}
    </MailText>
    <MailText>{props.summary}</MailText>
    {props.note && (
      <MailText style={{ borderLeft: "4px solid #cbd5e1", paddingLeft: 12 }}>
        <Multiline>{props.note}</Multiline>
      </MailText>
    )}
    <MailText style={smallText}>
      Stato: {props.status} · aggiornata da {props.actor}
    </MailText>
    <MailAction href={props.url}>Apri l’evento</MailAction>
  </EmailLayout>
)
AssociationEventEmail.PreviewProps = {
  associationName: "Associazione Alfa",
  title: "Serata giochi da tavolo",
  status: "Approvato",
  summary: "PoliNetwork ha approvato l’evento: ora è nel calendario del sito.",
  note: "Ottima idea!",
  actor: "PoliNetwork",
  url: "https://admin.polinetwork.org/dashboard/associations/events/1",
}
export default AssociationEventEmail
