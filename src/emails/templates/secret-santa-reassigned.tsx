import { Heading, Section, Text } from "@react-email/components"
import {
  GoldButton,
  SANTA,
  SecretSantaLayout,
  santaBold,
  santaDisplay,
  santaParagraph,
} from "../components/secret-santa-layout"
import type { EmailTemplate } from "../types"

export type SecretSantaReassignedMailData = {
  /** First name of the Santa who gets a new person. */
  name: string
  /** Name of the person who withdrew: the Santa already knew who they were giving a gift to. */
  withdrawnName: string
  /** False when nobody is left to give a gift to (only two people were left). */
  hasNewMatch: boolean
  reason?: "withdrawn" | "unconfirmed"
  /** The Secret Santa page on PoliNetwork Live, where the new golden letter opens. */
  url: string
}

export const secretSantaReassignedSubject = (data: SecretSantaReassignedMailData) =>
  data.hasNewMatch ? `${data.name}, c'è una nuova lettera dorata per te` : `${data.name}, novità sul tuo Secret Santa`

/**
 * To the Santa whose person withdrew after the draw. Their new person is NOT named here: it is in a new golden letter on
 * the website, behind sign-in, like the first one.
 */
const SecretSantaReassignedEmail: EmailTemplate<SecretSantaReassignedMailData> = (data) => (
  <SecretSantaLayout
    title={secretSantaReassignedSubject(data)}
    preview={
      data.hasNewMatch
        ? `${data.withdrawnName} non partecipa più: gli elfi ti hanno assegnato una nuova persona.`
        : `${data.withdrawnName} non partecipa più al Secret Santa.`
    }
    heading={
      <Heading
        className="m-0 mt-3 text-[32px] font-medium leading-[38px] tracking-[-0.6px]"
        style={{ ...santaDisplay, color: SANTA.navy }}
      >
        Ciao {data.name},
        <br />
        {data.hasNewMatch ? "cambio di programma!" : "una piccola novità"}
      </Heading>
    }
  >
    <Section className="px-8 pt-2">
      <Text className="my-4 text-center text-[16px] leading-[26px]" style={santaParagraph}>
        <strong style={santaBold}>{data.withdrawnName}</strong>{" "}
        {data.reason === "unconfirmed"
          ? "non ha confermato il regalo entro il termine ed è stato rimosso da questo giro."
          : "si è ritirato dal Secret Santa e non potrà esserci allo scambio dei regali."}
      </Text>
      {data.hasNewMatch ? (
        <Text className="my-4 text-center text-[16px] leading-[26px]" style={santaParagraph}>
          Niente paura: gli elfi ti hanno già <strong style={santaBold}>riassegnato a una nuova persona</strong>. La
          trovi in una nuova lettera dorata, insieme a quello che le piace. Se avevi già un regalo in mente, magari va
          bene anche per lei. Se hai già confermato di aver preso il regalo, la tua conferma resta valida.
        </Text>
      ) : (
        <Text className="my-4 text-center text-[16px] leading-[26px]" style={santaParagraph}>
          Al momento non c'è nessun'altra persona da assegnarti: gli organizzatori ti contatteranno a breve.
        </Text>
      )}
    </Section>
    {data.hasNewMatch && <GoldButton href={data.url}>Apri la nuova lettera dorata</GoldButton>}
  </SecretSantaLayout>
)

SecretSantaReassignedEmail.PreviewProps = {
  name: "Mario",
  withdrawnName: "Giulia",
  hasNewMatch: true,
  url: "https://live.polinetwork.org/secret-santa",
}

export default SecretSantaReassignedEmail
