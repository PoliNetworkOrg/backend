import { Heading, Section, Text } from "@react-email/components"
import {
  GoldButton,
  SANTA,
  SecretSantaLayout,
  santaBold,
  santaDisplay,
  santaLabel,
  santaParagraph,
  santaValue,
} from "../components/secret-santa-layout"
import type { EmailTemplate } from "../types"

export type SecretSantaMailData = {
  /** First name of the participant. */
  name: string
  /** The Secret Santa page on PoliNetwork Live, where the golden letter opens. */
  url: string
  /** Free text from the admin, e.g. "Cena di Natale, 19 dicembre". */
  exchange?: string
  budget?: string
}

export const secretSantaSubject = (data: SecretSantaMailData) => `${data.name}, l'estrazione del Secret Santa è fatta`

/** To everyone signed up, as soon as the gift draw is done. The name of their person is only on the website. */
const SecretSantaEmail: EmailTemplate<SecretSantaMailData> = (data) => (
  <SecretSantaLayout
    title={secretSantaSubject(data)}
    preview="C'è una persona che aspetta un tuo regalo. Apri la lettera dorata per scoprire chi è."
    heading={
      <Heading
        className="m-0 mt-3 text-[32px] font-medium leading-[38px] tracking-[-0.6px]"
        style={{ ...santaDisplay, color: SANTA.navy }}
      >
        Ciao {data.name},
        <br />
        l'estrazione è fatta!
      </Heading>
    }
  >
    <Section className="px-8 pt-2">
      <Text className="my-4 text-center text-[16px] leading-[26px]" style={santaParagraph}>
        Gli elfi hanno chiuso la cassetta delle lettere e pescato i nomi. Da adesso{" "}
        <strong style={santaBold}>c'è una persona che aspetta un tuo regalo</strong>.
      </Text>
      <Text className="my-4 text-center text-[16px] leading-[26px]" style={santaParagraph}>
        Chi sarà? Lo scopri aprendo la tua <strong style={santaBold}>lettera dorata</strong>, insieme a quello che le
        piace. Meglio aprirla quando nessuno ti guarda.
      </Text>
    </Section>
    <GoldButton href={data.url}>Apri la lettera dorata</GoldButton>
    {(data.exchange || data.budget) && (
      <Section className="px-8 pt-8">
        <table
          role="presentation"
          width="100%"
          cellPadding={0}
          cellSpacing={0}
          style={{ borderTop: `1px solid ${SANTA.ice}`, borderBottom: `1px solid ${SANTA.ice}` }}
        >
          <tbody>
            <tr>
              {data.exchange && (
                <td style={{ padding: "18px 16px 18px 0", verticalAlign: "top" }}>
                  <Text className="m-0" style={santaLabel}>
                    Scambio dei regali
                  </Text>
                  <Text className="m-0 mt-1" style={santaValue}>
                    {data.exchange}
                  </Text>
                </td>
              )}
              {data.budget && (
                <td
                  style={{
                    padding: data.exchange ? "18px 0 18px 16px" : "18px 0",
                    borderLeft: data.exchange ? `1px solid ${SANTA.ice}` : undefined,
                    verticalAlign: "top",
                  }}
                >
                  <Text className="m-0" style={santaLabel}>
                    Budget
                  </Text>
                  <Text className="m-0 mt-1" style={santaValue}>
                    {data.budget}
                  </Text>
                </td>
              )}
            </tr>
          </tbody>
        </table>
      </Section>
    )}
  </SecretSantaLayout>
)

SecretSantaEmail.PreviewProps = {
  name: "Mario",
  url: "https://live.polinetwork.org/secret-santa",
  exchange: "Cena di Natale, 19 dicembre",
  budget: "circa 10 €",
}

export default SecretSantaEmail
