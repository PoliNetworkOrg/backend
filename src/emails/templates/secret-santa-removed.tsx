import type { EmailTemplate } from "../types"
import SecretSantaConfirmationEmail, { type SecretSantaConfirmationMailData } from "./secret-santa-confirmation"

/**
 * Preview only: the removal variant of `secret-santa-confirmation.tsx`, so the email preview server can show it too.
 * The mailer always sends `SecretSantaConfirmationEmail` with `kind: "removed"`.
 */
const SecretSantaRemovedPreview: EmailTemplate<SecretSantaConfirmationMailData> = (data) => (
  <SecretSantaConfirmationEmail {...data} />
)

SecretSantaRemovedPreview.PreviewProps = {
  kind: "removed",
  name: "Mario",
  url: "https://live.polinetwork.org/secret-santa",
  closesAt: Date.parse("2026-12-10T23:00:00Z"),
}

export default SecretSantaRemovedPreview
