import { Column, Row, Section } from "@react-email/components"
import type { FeeMailData } from "@/soci/types"
import { MailText as Text } from "../components/email-layout"
import { FeeLayout } from "../components/fee-layout"
import { FEE_PREVIEW, FeePayment } from "../components/fee-payment"
import { Multiline } from "../components/multiline"
import type { EmailTemplate } from "../types"

export const feeRejectedSubject = (data: FeeMailData) => `Ricevuta della quota ${data.yearLabel} non accettata`

/** When the Direttivo rejects an uploaded receipt; the fee is Due again. */
const FeeRejectedEmail: EmailTemplate<FeeMailData> = (data) => (
  <FeeLayout
    kind="fee-rejected"
    preview={`La ricevuta della quota ${data.yearLabel} non è stata accettata`}
    name={data.name}
    action={{ label: "Carica una nuova ricevuta", href: data.myAreaUrl }}
  >
    <Text>
      il Consiglio Direttivo non ha accettato la ricevuta che hai caricato per la quota associativa {data.yearLabel}. Il
      motivo:
    </Text>
    <Section style={{ margin: "16px 0", backgroundColor: "#f8fafc", border: "1px solid #e0edf7", borderRadius: 14 }}>
      <Row>
        <Column style={{ padding: 18 }}>
          <Text>
            <Multiline>{data.reason}</Multiline>
          </Text>
        </Column>
      </Row>
    </Section>
    <Text>Carica una nuova ricevuta entro il {data.deadline}. Ti ricordiamo i dati per il bonifico:</Text>
    <FeePayment data={data} />
  </FeeLayout>
)

FeeRejectedEmail.PreviewProps = { ...FEE_PREVIEW, reason: "L'importo del bonifico è di 3,00 € invece di 5,00 €." }

export default FeeRejectedEmail
