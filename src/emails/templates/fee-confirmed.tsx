import type { FeeMailData } from "@/soci/types"
import { MailText as Text } from "../components/email-layout"
import { FeeLayout } from "../components/fee-layout"
import { FEE_PREVIEW } from "../components/fee-payment"
import type { EmailTemplate } from "../types"

export const feeConfirmedSubject = (data: FeeMailData) => `Quota associativa ${data.yearLabel} pagata`

/** When the Direttivo confirms a receipt or marks the fee as paid. */
const FeeConfirmedEmail: EmailTemplate<FeeMailData> = (data) => (
  <FeeLayout
    kind="fee-confirmed"
    preview={`Abbiamo registrato la tua quota associativa ${data.yearLabel}`}
    name={data.name}
    action={{ label: "Apri la tua area personale", href: data.myAreaUrl }}
  >
    <Text>
      abbiamo registrato il pagamento della tua quota associativa {data.yearLabel}
      {data.paidOn ? `, del ${data.paidOn}` : ""}. Grazie per far parte di PoliNetwork!
    </Text>
  </FeeLayout>
)

FeeConfirmedEmail.PreviewProps = { ...FEE_PREVIEW, paidOn: "10 novembre 2026" }

export default FeeConfirmedEmail
