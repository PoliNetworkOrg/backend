import { Column, Img, Row, Section } from "@react-email/components"

export const LOGO_URL =
  "https://raw.githubusercontent.com/PoliNetworkOrg/backend/597155632582db2692fa3c97473a7483b93b20a1/src/emails/assets/logo.png"

export function Logo() {
  return (
    <Section>
      <Row>
        <Column align="center" style={{ padding: "28px 0" }}>
          <Img
            src={LOGO_URL}
            alt="PoliNetwork APS"
            width={96}
            height={96}
            style={{ display: "block", width: 96, height: 96, border: 0 }}
          />
        </Column>
      </Row>
    </Section>
  )
}
