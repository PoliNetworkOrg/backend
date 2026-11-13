import { Text } from "@react-email/components"
import type { FeeMailData } from "@/soci/types"
import { FeeLayout } from "../components/fee-layout"
import { FEE_PREVIEW, FeePayment } from "../components/fee-payment"
import type { EmailTemplate } from "../types"

export const feeOpeningSubject = (data: FeeMailData) => `Quota associativa ${data.yearLabel}`

/** 1 September, or the day the fee year opens for the socio. */
const FeeOpeningEmail: EmailTemplate<FeeMailData> = (data) => (
  <FeeLayout
    preview={`È aperta la quota associativa ${data.yearLabel}: ${data.amount} entro il ${data.deadline}`}
    title={`Quota associativa ${data.yearLabel}`}
    name={data.name}
    action={{ label: "Carica la ricevuta", href: data.myAreaUrl }}
  >
    <Text className="my-2 text-base leading-normal">
      è aperta la quota associativa {data.yearLabel} di PoliNetwork APS. Per restare socio, fai un bonifico con questi
      dati:
    </Text>
    <FeePayment data={data} />
    <Text className="my-2 text-base leading-normal">
      Poi carica la ricevuta del bonifico nella tua area personale: il Consiglio Direttivo la controlla e ti conferma il
      pagamento. Se la quota non è pagata entro il {data.deadline}, lo status di socio decade.
    </Text>
  </FeeLayout>
)

FeeOpeningEmail.PreviewProps = FEE_PREVIEW

export default FeeOpeningEmail
