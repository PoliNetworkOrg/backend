import { Section, Text } from "@react-email/components"
import type { FeeMailData } from "@/soci/types"
import { FeeLayout } from "../components/fee-layout"
import { FEE_PREVIEW, FeePayment } from "../components/fee-payment"
import type { EmailTemplate } from "../types"

export const feeRejectedSubject = (data: FeeMailData) => `Ricevuta della quota ${data.yearLabel} non accettata`

/** When the Direttivo rejects an uploaded receipt; the fee is Due again. */
const FeeRejectedEmail: EmailTemplate<FeeMailData> = (data) => (
  <FeeLayout
    preview={`La ricevuta della quota ${data.yearLabel} non è stata accettata`}
    title="Ricevuta non accettata"
    name={data.name}
    myAreaUrl={data.myAreaUrl}
    action="Carica una nuova ricevuta"
  >
    <Text className="my-2 text-base leading-normal">
      il Consiglio Direttivo non ha accettato la ricevuta che hai caricato per la quota associativa {data.yearLabel}. Il
      motivo:
    </Text>
    <Section className="my-4 rounded-md bg-gray-100 p-4">
      <Text className="m-0 whitespace-pre-line text-base leading-normal">{data.reason}</Text>
    </Section>
    <Text className="my-2 text-base leading-normal">
      Carica una nuova ricevuta entro il {data.deadline}. Ti ricordiamo i dati per il bonifico:
    </Text>
    <FeePayment data={data} />
  </FeeLayout>
)

FeeRejectedEmail.PreviewProps = { ...FEE_PREVIEW, reason: "L'importo del bonifico è di 3,00 € invece di 5,00 €." }

export default FeeRejectedEmail
