import { Text } from "@react-email/components"
import type { FeeMailData } from "@/soci/types"
import { FeeLayout } from "../components/fee-layout"
import { FEE_PREVIEW, FeePayment } from "../components/fee-payment"
import type { EmailTemplate } from "../types"

export const feeReminderSubject = (data: FeeMailData) =>
  `Promemoria: quota associativa ${data.yearLabel} entro il ${data.deadline}`

/** 1 and 21 December, to soci whose fee is still Due. */
const FeeReminderEmail: EmailTemplate<FeeMailData> = (data) => (
  <FeeLayout
    preview={`La quota ${data.yearLabel} non risulta ancora pagata: scade il ${data.deadline}`}
    title="Promemoria quota associativa"
    name={data.name}
    action={{ label: "Carica la ricevuta", href: data.myAreaUrl }}
  >
    <Text className="my-2 text-base leading-normal">
      la tua quota associativa {data.yearLabel} non risulta ancora pagata. Se non è pagata entro il {data.deadline}, lo
      status di socio decade.
    </Text>
    <FeePayment data={data} />
    <Text className="my-2 text-base leading-normal">
      Se hai già fatto il bonifico, carica la ricevuta nella tua area personale.
    </Text>
  </FeeLayout>
)

FeeReminderEmail.PreviewProps = FEE_PREVIEW

export default FeeReminderEmail
