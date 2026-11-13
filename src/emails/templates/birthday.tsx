import {
  Body,
  Container,
  Head,
  Heading,
  Html,
  Img,
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
// sky. Only Apple Mail loads web fonts; Gmail and Outlook fall back to Helvetica/Arial.
const display = { fontFamily: "'DM Sans', Helvetica, Arial, sans-serif" }
const text = { fontFamily: "'Red Hat Text', Helvetica, Arial, sans-serif", letterSpacing: "0.3px" }
/** Bold in the same colour as the text, so dark mode recolours both alike. */
const bold = { fontWeight: 700 }
const label = {
  ...text,
  fontSize: 11,
  lineHeight: "16px",
  letterSpacing: "1px",
  textTransform: "uppercase" as const,
  color: "#64748B",
}
const value = { ...display, fontSize: 20, lineHeight: "28px", fontWeight: 600, color: "#020617" }

/** The commit that holds `src/emails/assets/birthday-header.gif`: emails need a public URL that never changes. */
const ARTWORK_COMMIT = "c23cad0c6cc981da176fb809c4c260217f74e735"
export const BIRTHDAY_HEADER_URL = `https://raw.githubusercontent.com/PoliNetworkOrg/backend/${ARTWORK_COMMIT}/src/emails/assets/birthday-header.gif`

/**
 * To every active socio on their birthday (28 February for those born on the 29th, in years without one).
 *
 * Built for dark mode: Outlook and the Gmail apps recolour every colour the email declares but never image pixels.
 * So the artwork (logo, website shapes, falling confetti) is a plain `<img>` with nothing over it, and the greeting
 * is ordinary text on the card, recoloured together with it. Nothing sits on a background image and there is no
 * outer tint, which in dark mode turned into a grey band.
 */
const BirthdayEmail: EmailTemplate<BirthdayMailData> = (data) => (
  <Html lang="it">
    <Tailwind config={{ presets: [pixelBasedPreset] }}>
      <Head>
        <meta name="color-scheme" content="light only" />
        <meta name="supported-color-schemes" content="light only" />
        <style>{":root { color-scheme: light only; }"}</style>
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@500;600&family=Red+Hat+Text:wght@400;500;700&display=swap"
        />
      </Head>
      <Preview>Oggi è il tuo giorno: tanti auguri!</Preview>
      <Body className="m-0 p-0 py-6 text-[#020617]" style={text}>
        <Container className="birthday-card mx-auto max-w-[480px] rounded-[20px] bg-white">
          <Img
            className="birthday-header"
            src={BIRTHDAY_HEADER_URL}
            width={480}
            height={200}
            alt="PoliNetwork"
            style={{ display: "block", width: "100%", maxWidth: 480, height: "auto", border: 0 }}
          />
          <Section className="px-8 pt-8 text-center">
            <Text className="m-0 text-[44px] leading-none">🎂</Text>
            <Heading
              className="birthday-title m-0 mt-4 text-[32px] font-medium leading-[38px] tracking-[-0.5px] text-[#020617]"
              style={display}
            >
              Tanti auguri, {data.name}!
            </Heading>
          </Section>
          <Section className="mail-content px-8 pb-10 pt-6">
            {/* The membership details: plain text only, no coloured surface, so dark mode recolours them like the rest. */}
            <table className="birthday-membership" role="presentation" cellPadding={0} cellSpacing={0}>
              <tbody>
                <tr>
                  <td style={{ paddingRight: 20 }}>
                    <Text className="m-0" style={label}>
                      Socio n.
                    </Text>
                    <Text className="m-0" style={value}>
                      {String(data.number).padStart(4, "0")}
                    </Text>
                  </td>
                  <td style={{ paddingLeft: 20, borderLeft: "1px solid #E2E8F0" }}>
                    <Text className="m-0" style={label}>
                      Con noi dal
                    </Text>
                    <Text className="m-0" style={value}>
                      {data.since}
                    </Text>
                  </td>
                </tr>
              </tbody>
            </table>
            <Text className="my-4 text-[16px] leading-[26px]" style={text}>
              Oggi è il tuo giorno e volevamo essere tra i primi a farti gli auguri di{" "}
              <strong style={bold}>buon compleanno</strong>!
            </Text>
            <Text className="my-4 text-[16px] leading-[26px]" style={text}>
              Grazie per il tempo, le idee e l’impegno che dedichi a PoliNetwork. Il tuo contributo ci aiuta a mettere
              in contatto gli studenti e a creare occasioni per incontrarsi e collaborare.{" "}
              <strong style={bold}>Noi ne siamo fieri</strong>, e speriamo lo sia anche tu.
            </Text>
            <Text className="my-4 text-[16px] leading-[26px]" style={text}>
              Ti auguriamo una <strong style={bold}>giornata piena di cose belle</strong>, da festeggiare con le persone
              a cui vuoi bene.
            </Text>
            <Text className="mb-0 mt-7 text-[16px] leading-[24px]" style={text}>
              Un abbraccio,
              <br />
              il Consiglio Direttivo di PoliNetwork
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
