import { Column, Row, Section } from "@react-email/components"
import type { FeeMailData } from "@/soci/types"
import { MailText } from "./email-layout"

/** How to pay the fee: amount, bank details, the transfer's reason and the deadline. */
export function FeePayment({ data }: { data: FeeMailData }) {
  const rows: [string, string][] = [
    ["Importo", data.amount],
    ["IBAN", data.iban],
    ["Beneficiario", data.beneficiary],
    ["Causale", data.reference],
    ["Scadenza", data.deadline],
  ]
  return (
    <Section style={{ margin: "16px 0", backgroundColor: "#f0f9ff", border: "1px solid #e0edf7", borderRadius: 14 }}>
      <Row>
        <Column style={{ padding: 18 }}>
          {rows.map(([label, value]) => (
            <MailText key={label} style={{ margin: "8px 0", fontSize: 14, lineHeight: "23px" }}>
              {label}: <span style={{ fontFamily: "Consolas, monospace", wordBreak: "break-word" }}>{value}</span>
            </MailText>
          ))}
        </Column>
      </Row>
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
