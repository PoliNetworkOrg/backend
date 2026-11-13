import { Text } from "@react-email/components"
import type { FeeMailData } from "@/soci/types"
import { FeeLayout } from "../components/fee-layout"
import { FEE_PREVIEW } from "../components/fee-payment"
import type { EmailTemplate } from "../types"

export const feeConfirmedSubject = (data: FeeMailData) => `Quota associativa ${data.yearLabel} pagata`

/** When the Direttivo confirms a receipt or marks the fee as paid. */
const FeeConfirmedEmail: EmailTemplate<FeeMailData> = (data) => (
  <FeeLayout
    preview={`Abbiamo registrato la tua quota associativa ${data.yearLabel}`}
    title="Quota pagata"
    name={data.name}
    action={{ label: "Apri la tua area personale", href: data.myAreaUrl }}
  >
    <Text className="my-2 text-base leading-normal">
      abbiamo registrato il pagamento della tua quota associativa {data.yearLabel}
      {data.paidOn ? `, del ${data.paidOn}` : ""}. Grazie per far parte di PoliNetwork!
    </Text>
  </FeeLayout>
)

FeeConfirmedEmail.PreviewProps = { ...FEE_PREVIEW, paidOn: "10 novembre 2026" }

export default FeeConfirmedEmail
