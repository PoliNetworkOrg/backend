import { Text } from "@react-email/components"
import type { BirthdayMailData } from "@/soci/types"
import { FeeLayout } from "../components/fee-layout"
import type { EmailTemplate } from "../types"

export const birthdaySubject = (data: BirthdayMailData) => `Buon compleanno, ${data.name}!`

/** To every active socio on their birthday (28 February for those born on the 29th, in years without one). */
const BirthdayEmail: EmailTemplate<BirthdayMailData> = (data) => (
  <FeeLayout preview="Tanti auguri da PoliNetwork!" title="Buon compleanno! 🎉" name={data.name}>
    <Text className="my-2 text-base leading-normal">
      tutta PoliNetwork ti augura un felice compleanno! Grazie per far parte dell'associazione e per tutto quello che
      fai insieme a noi.
    </Text>
  </FeeLayout>
)

BirthdayEmail.PreviewProps = { name: "Mario" }

export default BirthdayEmail
