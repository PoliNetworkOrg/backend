import { CodeInline, Section, Text } from "@react-email/components"
import type { FeeMailData } from "@/soci/types"

/** How to pay the fee: amount, bank details, the transfer's reason and the deadline. */
export function FeePayment({ data }: { data: FeeMailData }) {
  const rows: [string, string][] = [
    ["Importo", data.amount],
    ["IBAN", data.iban],
    ["Beneficiario", data.beneficiary],
    ["Causale", data.reference],
    ["Entro il", data.deadline],
  ]
  return (
    <Section className="my-4 rounded-md bg-blue-100 p-4">
      {rows.map(([label, value]) => (
        <Text key={label} className="my-1 text-sm leading-normal">
          {label}: <CodeInline className="text-xs sm:text-sm">{value}</CodeInline>
        </Text>
      ))}
    </Section>
  )
}

export const FEE_PREVIEW: FeeMailData = {
  name: "Mario",
  yearLabel: "2026/27",
  amount: "5,00 €",
  deadline: "31 dicembre 2026",
  iban: "IT60X0542811101000000123456",
  beneficiary: "PoliNetwork APS",
  reference: "Quota 2026/27 0344 Mario Rossi",
  myAreaUrl: "https://admin.polinetwork.org/dashboard/account/me",
}
