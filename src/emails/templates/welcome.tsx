import { Column, Link, Row, Section } from "@react-email/components"
import { EmailLayout, linkStyle, MailText, smallText } from "../components/email-layout"
import type { EmailTemplate } from "../types"

type Props = { firstName: string; assocNum: number; email: string; password: string }
export const welcomeSubject = "Benvenuto in PoliNetwork APS"

const WelcomeEmail: EmailTemplate<Props> = (props) => (
  <EmailLayout kind="welcome" preview="Il tuo account e il tuo numero socio PoliNetwork">
    <MailText>
      Ciao <strong>{props.firstName}</strong>, grazie per esserti unito alla nostra associazione!
      <br />
      Il tuo <strong>numero socio è {props.assocNum}</strong>.
    </MailText>
    <MailText>
      Per attivare il tuo account Microsoft 365, apri da un computer la{" "}
      <Link href="https://outlook.office.com" style={linkStyle}>
        pagina di accesso Microsoft
      </Link>
      , inserisci queste credenziali e segui le istruzioni.
    </MailText>
    <Section style={{ backgroundColor: "#f0f9ff", border: "1px solid #e0edf7", borderRadius: 14 }}>
      <Row>
        <Column style={{ padding: 18 }}>
          <MailText
            className="account-email"
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
          <MailText
            style={{
              margin: 0,
              fontFamily: "Consolas, Menlo, monospace",
              fontSize: 13,
              lineHeight: "23px",
              wordBreak: "break-all",
            }}
          >
            {props.password}
          </MailText>
        </Column>
      </Row>
    </Section>
    <MailText>
      Ti verrà chiesto di cambiare la password e configurare l’autenticazione a due fattori. Segui le istruzioni per
      completare l’attivazione.
    </MailText>
    <MailText>
      <strong>Importante!</strong> Aggiungi questo indirizzo alla tua app di posta, per esempio Outlook: qui riceverai
      le <strong>comunicazioni ufficiali</strong> dell’associazione, tra cui convocazioni, rinnovi e ricevute.
    </MailText>
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
WelcomeEmail.PreviewProps = {
  firstName: "Mario",
  email: "mario.rossi@polinetwork.org",
  password: "Password-di-esempio-123!",
  assocNum: 12,
}
export default WelcomeEmail
