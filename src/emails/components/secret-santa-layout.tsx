import {
  Body,
  Button,
  Container,
  Head,
  Html,
  Img,
  Link,
  Preview,
  pixelBasedPreset,
  Section,
  Tailwind,
  Text,
} from "@react-email/components"
import type { ReactNode } from "react"

/**
 * Shared look of the Secret Santa emails (draw, reassignment). Same type and approach as the birthday email: DM Sans
 * for titles, Red Hat Text for text, and no tinted surfaces that dark mode could turn into a grey band. PoliNetwork
 * blue and white throughout, gold only for the call to action (the golden letter waiting on the website). The only
 * image is the logo in a Santa hat; the rest is text, so it still reads well when images are blocked.
 * Names of who gives a gift to whom are never in these emails: they are only revealed on the website, behind sign-in.
 */

/**
 * The PoliNetwork logo wearing a Santa hat (`src/emails/assets/secret-santa-logo.png`): the same artwork as on the
 * Secret Santa page of PoliNetwork Live, resized for email and padded so the logo's circle sits at the exact centre of
 * the image (centring the image centres the circle), with snowflakes in the margins. The preview server serves this
 * URL from `templates/static`; renderEmail embeds the actual PNG as an inline CID attachment for delivery.
 */
export const SECRET_SANTA_LOGO_URL = "/static/secret-santa-logo.png?v=5"

export const santaDisplay = { fontFamily: "'DM Sans', Helvetica, Arial, sans-serif" }
export const santaText = { fontFamily: "'Red Hat Text', Helvetica, Arial, sans-serif", letterSpacing: "0.3px" }
export const santaBold = { fontWeight: 700 }

export const SANTA = {
  navy: "#14284B",
  blue: "#1E63D6",
  sky: "#7FB6FF",
  ice: "#DCEBFF",
  gold: "#E2B33F",
  goldEdge: "#C08F22",
  muted: "#5B6B85",
}

export const santaLabel = {
  ...santaText,
  fontSize: 11,
  lineHeight: "16px",
  letterSpacing: "1.5px",
  textTransform: "uppercase" as const,
  color: SANTA.blue,
}
export const santaValue = { ...santaDisplay, fontSize: 18, lineHeight: "26px", fontWeight: 600, color: SANTA.navy }
export const santaParagraph = { ...santaText, color: SANTA.navy }

/** A candy-cane ribbon in PoliNetwork blues and white. */
function Ribbon() {
  const stripes = Array.from({ length: 16 }, (_, i) => [SANTA.navy, "#FFFFFF", SANTA.sky, "#FFFFFF"][i % 4] as string)
  return (
    <table role="presentation" width="100%" cellPadding={0} cellSpacing={0} style={{ tableLayout: "fixed" }}>
      <tbody>
        <tr>
          {stripes.map((color, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: static decoration
            <td key={i} height={8} style={{ height: 8, backgroundColor: color, fontSize: 0, lineHeight: 0 }}>
              &nbsp;
            </td>
          ))}
        </tr>
      </tbody>
    </table>
  )
}

/** A thin ornament: line, star, line. Plain text glyphs, so every client shows it. */
export function Ornament() {
  return (
    <table role="presentation" align="center" cellPadding={0} cellSpacing={0} style={{ margin: "0 auto" }}>
      <tbody>
        <tr>
          <td style={{ width: 48, borderBottom: `1px solid ${SANTA.ice}`, fontSize: 0, lineHeight: 0 }}>&nbsp;</td>
          <td
            style={{
              padding: "0 12px",
              color: SANTA.sky,
              fontSize: 14,
              lineHeight: "14px",
              fontFamily: "Arial, sans-serif",
            }}
          >
            ✦
          </td>
          <td style={{ width: 48, borderBottom: `1px solid ${SANTA.ice}`, fontSize: 0, lineHeight: 0 }}>&nbsp;</td>
        </tr>
      </tbody>
    </table>
  )
}

/** The gold call to action that leads to the golden letter on the website. */
export function GoldButton({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Section className="px-8 pt-2 text-center">
      <Button
        href={href}
        style={{
          display: "inline-block",
          boxSizing: "border-box",
          maxWidth: "100%",
          borderRadius: 60,
          backgroundColor: SANTA.gold,
          border: `1px solid ${SANTA.goldEdge}`,
          padding: "16px 32px",
          color: SANTA.navy,
          textDecoration: "none",
          fontFamily: santaDisplay.fontFamily,
          fontWeight: 600,
          fontSize: 17,
          lineHeight: "24px",
          letterSpacing: "0.2px",
          textAlign: "center",
        }}
      >
        {children}
      </Button>
      <Text className="m-0 mt-3 text-[13px] leading-[20px]" style={{ ...santaText, color: SANTA.muted }}>
        Ti chiederemo di accedere con il tuo account PoliNetwork.
      </Text>
    </Section>
  )
}

/** Card with ribbons, the logo in a Santa hat, the heading block, the sign-off and the footer. */
export function SecretSantaLayout({
  title,
  preview,
  heading,
  children,
}: {
  title: string
  preview: string
  heading: ReactNode
  children: ReactNode
}) {
  return (
    <Html lang="it">
      <Tailwind config={{ presets: [pixelBasedPreset] }}>
        <Head>
          <title>{title}</title>
          <meta name="color-scheme" content="light only" />
          <meta name="supported-color-schemes" content="light only" />
          <style>{":root { color-scheme: light only; }"}</style>
          <link
            rel="stylesheet"
            href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@500;600&family=Red+Hat+Text:wght@400;500;700&display=swap"
          />
        </Head>
        <Preview>{preview}</Preview>
        <Body className="m-0 px-3 py-6" style={santaParagraph}>
          <Container
            className="mx-auto max-w-[480px] overflow-hidden rounded-[21px] border border-solid bg-white"
            style={{ borderColor: SANTA.ice }}
          >
            <Ribbon />
            <Section className="px-8 pb-2 pt-10 text-center">
              <Img
                src={SECRET_SANTA_LOGO_URL}
                alt="PoliNetwork"
                width={240}
                height={205}
                style={{ display: "block", margin: "0 auto 20px", width: 240, height: 205, border: 0 }}
              />
              <Ornament />
              <Text className="m-0 mt-5" style={santaLabel}>
                Secret Santa · PoliNetwork
              </Text>
              {heading}
            </Section>
            {children}
            <Section className="px-8 pb-10 pt-6 text-center">
              <Text className="m-0 mb-5 text-[16px] leading-[24px]" style={santaParagraph}>
                Buone feste e buona caccia al regalo perfetto.
                <br />
                <span style={{ color: SANTA.muted }}>Gli elfi di PoliNetwork</span>
              </Text>
              <Ornament />
            </Section>
            <Ribbon />
          </Container>
          <Container className="mx-auto max-w-[480px]">
            <Text
              className="mx-6 my-6 text-center text-[12px] leading-[18px]"
              style={{ ...santaText, color: SANTA.muted }}
            >
              Ricevi questa email perché ti sei iscritto al Secret Santa su PoliNetwork Live. Messaggio automatico: non
              rispondere a questa email. Per qualsiasi cosa, scrivi a{" "}
              <Link href="mailto:direttivo@polinetwork.org" style={{ color: SANTA.blue, textDecoration: "underline" }}>
                direttivo@polinetwork.org
              </Link>
              .
              <br />
              <Link href="https://polinetwork.org" style={{ color: SANTA.muted, textDecoration: "underline" }}>
                PoliNetwork APS
              </Link>
            </Text>
          </Container>
        </Body>
      </Tailwind>
    </Html>
  )
}
