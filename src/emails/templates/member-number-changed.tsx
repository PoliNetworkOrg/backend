import { Column, Link, Row, Section } from "@react-email/components"
import { EmailLayout, linkStyle, MailText, smallText } from "../components/email-layout"
import type { EmailTemplate } from "../types"

type Props = { firstName: string | null; assocNum: number; previousAssocNum: string | null; email: string | null }
export const memberNumberChangedSubject = "Il tuo numero socio è cambiato"
const MemberNumberChangedEmail: EmailTemplate<Props> = (props) => (
  <EmailLayout kind="member-number-changed" preview={`Il tuo numero socio PoliNetwork è ora ${props.assocNum}`}>
    <MailText>
      Ciao
      {props.firstName ? (
        <>
          {" "}
          <strong>{props.firstName}</strong>
        </>
      ) : null}
      ,<br />
      il tuo numero socio PoliNetwork è ora <strong>{props.assocNum}</strong>
      {props.previousAssocNum ? ` (prima era ${props.previousAssocNum})` : ""}.
    </MailText>
    {props.email && (
      <>
        <MailText>Account Microsoft 365</MailText>
        <Section style={{ backgroundColor: "#f0f9ff", border: "1px solid #e0edf7", borderRadius: 14 }}>
          <Row>
            <Column style={{ padding: 18 }}>
              <MailText
                style={{
                  margin: 0,
                  fontFamily: "Consolas, Menlo, monospace",
                  fontSize: 13,
                  lineHeight: "23px",
                  wordBreak: "break-all",
                }}
              >
                {props.email}
              </MailText>
            </Column>
          </Row>
        </Section>
      </>
    )}
    <MailText>
      Per domande o problemi, contatta il responsabile del team IT scrivendo a{" "}
      <Link href="mailto:it@polinetwork.org" style={linkStyle}>
        it@polinetwork.org
      </Link>
      .
    </MailText>
    <MailText style={smallText}>Il team IT di PoliNetwork</MailText>
  </EmailLayout>
)
MemberNumberChangedEmail.PreviewProps = {
  firstName: "Mario",
  assocNum: 456,
  previousAssocNum: "123",
  email: "mario.rossi@polinetwork.org",
}
export default MemberNumberChangedEmail
