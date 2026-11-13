import { Link } from "@react-email/components"
import type { ReactNode } from "react"
import type { EmailHeaderKind } from "../headers"
import { EmailLayout, linkStyle, MailAction, MailText, smallText } from "./email-layout"

export function FeeLayout(props: {
  kind: Extract<EmailHeaderKind, `fee-${string}`>
  preview: string
  name: string
  action?: { label: string; href: string }
  children: ReactNode
}) {
  return (
    <EmailLayout
      kind={props.kind}
      preview={props.preview}
      footer={
        <>
          Questo è un messaggio automatico: <strong>non rispondere</strong> a questa email. Per domande scrivi al
          Consiglio Direttivo a{" "}
          <Link href="mailto:direttivo@polinetwork.org" style={linkStyle}>
            direttivo@polinetwork.org
          </Link>
          .
        </>
      }
    >
      <MailText>
        Ciao <strong>{props.name}</strong>,
      </MailText>
      {props.children}
      {props.action && <MailAction href={props.action.href}>{props.action.label}</MailAction>}
      <MailText style={smallText}>~ Il Consiglio Direttivo di PoliNetwork</MailText>
    </EmailLayout>
  )
}
