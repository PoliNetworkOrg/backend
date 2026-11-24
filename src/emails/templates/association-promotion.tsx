import { EmailLayout, MailAction, MailText, smallText } from "../components/email-layout"
import { Multiline } from "../components/multiline"
import type { EmailTemplate } from "../types"

/** A promotion request moved (submitted, changes requested, approved, scheduled, published…) or got a comment. */
export type AssociationPromotionProps = {
  associationName: string
  title: string
  status: string
  summary: string
  note: string | null
  actor: string
  url: string
}

const AssociationPromotionEmail: EmailTemplate<AssociationPromotionProps> = (props) => (
  <EmailLayout heading="Richiesta di promozione" preview={`${props.status}: ${props.title}`}>
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
    <MailAction href={props.url}>Apri la richiesta</MailAction>
  </EmailLayout>
)
AssociationPromotionEmail.PreviewProps = {
  associationName: "Associazione Alfa",
  title: "Hackathon d’autunno",
  status: "Modifiche richieste",
  summary: "PoliNetwork chiede alcune modifiche prima di approvare la richiesta.",
  note: "Aggiungi il link al modulo di iscrizione.",
  actor: "PoliNetwork",
  url: "https://admin.polinetwork.org/dashboard/associations/promotions/1",
}
export default AssociationPromotionEmail
