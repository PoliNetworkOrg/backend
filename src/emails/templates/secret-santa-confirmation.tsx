import { Heading, Link, Section, Text } from "@react-email/components"
import {
  GoldButton,
  SANTA,
  SecretSantaLayout,
  santaBold,
  santaDisplay,
  santaParagraph,
} from "../components/secret-santa-layout"
import type { EmailTemplate } from "../types"

export type SecretSantaConfirmationMailData = {
  kind: "confirmation-reminder" | "removed"
  name: string
  url: string
  closesAt: number
}
export const secretSantaConfirmationSubject = (data: SecretSantaConfirmationMailData) =>
  data.kind === "removed"
    ? `${data.name}, la tua partecipazione al Secret Santa è terminata`
    : `${data.name}, conferma il regalo entro mezzanotte`

const telegramLink = { color: SANTA.blue, fontWeight: 700, textDecoration: "underline" }

/**
 * To participants who have not confirmed the gift: the last reminder (only to those still unconfirmed) and, after the
 * deadline, the removal notice with the organizers' Telegram contacts.
 */
const SecretSantaConfirmationEmail: EmailTemplate<SecretSantaConfirmationMailData> = (data) => {
  const removed = data.kind === "removed"
  const day = new Date(data.closesAt - 1).toLocaleDateString("it-IT", {
    timeZone: "Europe/Rome",
    day: "numeric",
    month: "long",
    year: "numeric",
  })
  return (
    <SecretSantaLayout
      title={secretSantaConfirmationSubject(data)}
      preview={
        removed
          ? "Non abbiamo ricevuto la conferma del regalo entro il termine previsto."
          : `Hai tempo fino alla mezzanotte del ${day}, ora italiana.`
      }
      heading={
        <Heading
          className="m-0 mt-3 text-[32px] font-medium leading-[38px]"
          style={{ ...santaDisplay, color: SANTA.navy }}
        >
          Ciao {data.name},<br />
          {removed ? "la partecipazione è terminata" : "il regalo è pronto?"}
        </Heading>
      }
    >
      <Section className="px-8 pt-2">
        {removed ? (
          <>
            <Text className="my-4 text-center text-[16px] leading-[26px]" style={santaParagraph}>
              Non hai confermato di aver preso il regalo entro la mezzanotte del{" "}
              <strong style={santaBold}>{day}</strong>, ora italiana. Per questo sei stato rimosso da questo giro di
              Secret Santa.
            </Text>
            <Text className="my-4 text-center text-[16px] leading-[26px]" style={santaParagraph}>
              Gli abbinamenti sono stati aggiornati. Se pensi che ci sia un errore o hai bisogno di aiuto, scrivi su
              Telegram a{" "}
              <Link href="https://t.me/bia3ia" style={telegramLink}>
                @bia3ia
              </Link>{" "}
              o a{" "}
              <Link href="https://t.me/viganogabriele" style={telegramLink}>
                @viganogabriele
              </Link>
              .
            </Text>
          </>
        ) : (
          <>
            <Text className="my-4 text-center text-[16px] leading-[26px]" style={santaParagraph}>
              Non abbiamo ancora ricevuto la tua conferma. Se hai acquistato o preparato il regalo, apri il sito, accedi
              al tuo account e premi <strong style={santaBold}>Ho preso il regalo</strong>.
            </Text>
            <Text className="my-4 text-center text-[16px] leading-[26px]" style={santaParagraph}>
              Hai tempo fino alla <strong style={santaBold}>mezzanotte del {day}, ora italiana</strong>. Dopo il
              termine, chi non ha confermato verrà rimosso e gli abbinamenti saranno aggiornati.
            </Text>
          </>
        )}
      </Section>
      <GoldButton href={data.url}>
        {removed ? "Vedi lo stato della partecipazione" : "Conferma il regalo sul sito"}
      </GoldButton>
    </SecretSantaLayout>
  )
}
SecretSantaConfirmationEmail.PreviewProps = {
  kind: "confirmation-reminder",
  name: "Mario",
  url: "https://live.polinetwork.org/secret-santa",
  closesAt: Date.parse("2026-12-10T23:00:00Z"),
}
export default SecretSantaConfirmationEmail
