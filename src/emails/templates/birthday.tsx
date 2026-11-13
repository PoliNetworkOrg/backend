import {
  Body,
  Container,
  Head,
  Html,
  Link,
  Preview,
  pixelBasedPreset,
  Section,
  Tailwind,
  Text,
} from "@react-email/components"
import type { BirthdayMailData } from "@/soci/types"
import type { EmailTemplate } from "../types"

export const birthdaySubject = (data: BirthdayMailData) => `Tanti auguri, ${data.name}!`

// The website's type and palette (PoliNetworkOrg/web): DM Sans for titles, Red Hat Text for text, Tailwind slate and
// sky. Clients that drop web fonts (Gmail, Outlook) fall back to Helvetica/Arial.
const display = { fontFamily: "'DM Sans', Helvetica, Arial, sans-serif" }
const text = { fontFamily: "'Red Hat Text', Helvetica, Arial, sans-serif", letterSpacing: "0.3px" }

/**
 * To every active socio on their birthday (28 February for those born on the 29th, in years without one). The wishes
 * come first; the membership details are a quiet line at the bottom.
 */
const BirthdayEmail: EmailTemplate<BirthdayMailData> = (data) => (
  <Html lang="it">
    <Tailwind config={{ presets: [pixelBasedPreset] }}>
      <Head>
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@500&family=Red+Hat+Text:wght@400;500&display=swap"
        />
      </Head>
      <Preview>Oggi è il tuo giorno: tanti auguri!</Preview>
      <Body className="m-0 bg-[#F1F5F9] px-3 py-10 text-[#020617]" style={text}>
        <Container className="mx-auto max-w-[480px] rounded-[20px] border border-solid border-[#E2E8F0] bg-white">
          <Section className="px-8 pb-2 pt-12 text-center">
            <Text className="m-0 text-[44px] leading-none">🎂</Text>
            <Text className="m-0 mt-6 text-[34px] font-medium leading-[40px] tracking-[-0.5px]" style={display}>
              Tanti auguri, {data.name}!
            </Text>
          </Section>
          <Section className="px-8 pb-10 pt-4">
            <Text className="my-4 text-[16px] leading-[26px]" style={text}>
              Oggi è il tuo giorno, e volevamo essere tra i primi a fartelo sapere.
            </Text>
            <Text className="my-4 text-[16px] leading-[26px]" style={text}>
              Ti auguriamo un anno pieno di cose belle: esami che vanno come speri, progetti che ti appassionano e
              persone con cui condividerli. Goditi la giornata e festeggia come si deve.
            </Text>
            <Text className="mb-0 mt-7 text-[16px] leading-[24px]" style={text}>
              Un abbraccio,
              <br />
              il Consiglio Direttivo di PoliNetwork
            </Text>
            <Text className="mb-0 mt-8">
              <span
                className="rounded-[60px] bg-[#F0F9FF] px-3 py-[6px] text-[12px] font-medium text-[#0369A1]"
                style={text}
              >
                Socio n. {String(data.number).padStart(4, "0")} · con noi dal {data.since}
              </span>
            </Text>
          </Section>
        </Container>
        <Container className="mx-auto max-w-[480px]">
          <Text className="mx-6 my-6 text-center text-[12px] leading-[18px] text-[#64748B]" style={text}>
            Messaggio automatico, non rispondere a questa email. Per qualsiasi cosa scrivi a{" "}
            <Link href="mailto:direttivo@polinetwork.org" className="text-[#0369A1] underline">
              direttivo@polinetwork.org
            </Link>
            .
            <br />
            <Link href="https://polinetwork.org" className="text-[#64748B] underline">
              PoliNetwork APS
            </Link>
          </Text>
        </Container>
      </Body>
    </Tailwind>
  </Html>
)

BirthdayEmail.PreviewProps = { name: "Mario", number: 344, since: 2024 }

export default BirthdayEmail
