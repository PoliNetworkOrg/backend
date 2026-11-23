import type { FeeMailData } from "@/soci/types"
import { MailText as Text } from "../components/email-layout"
import { FeeLayout } from "../components/fee-layout"
import { FEE_PREVIEW } from "../components/fee-payment"
import type { EmailTemplate } from "../types"

export const feeLapsedSubject = (data: FeeMailData) => `Fine dello status di socio — quota ${data.yearLabel}`

const FeeLapsedEmail: EmailTemplate<FeeMailData> = (data) => (
  <FeeLayout kind="fee-lapsed" name={data.name} preview={`Il tuo status di socio è terminato il ${data.deadline}`}>
    <Text>
      la quota associativa {data.yearLabel} non risulta pagata entro il {data.deadline}. Il tuo status di socio è quindi
      terminato con questa data, come previsto dal Regolamento Interno.
    </Text>
    <Text>
      L’account è stato rimosso dal gruppo Soci ed è in attesa di cancellazione. Se ritieni che ci sia un errore,
      contatta il Consiglio Direttivo a direttivo@polinetwork.org.
    </Text>
    <Text>Grazie per aver fatto parte di PoliNetwork.</Text>
  </FeeLayout>
)

FeeLapsedEmail.PreviewProps = FEE_PREVIEW
export default FeeLapsedEmail
