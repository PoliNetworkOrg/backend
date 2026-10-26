import type { MemberSummary } from "./types"

export function safeErrorDetail(error: unknown) {
  let detail: string | undefined
  try {
    detail =
      error instanceof Error
        ? `${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ""}`
        : typeof error === "string"
          ? error
          : JSON.stringify(error)
  } catch {
    detail = "Unserializable error"
  }
  return (detail ?? "Unknown error").replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[redacted email]")
}

export class IncompleteMemberError extends Error {
  constructor(
    readonly member: MemberSummary,
    cause: unknown
  ) {
    super(
      `Account ${member.mail} (${member.id}) was created, but setup and cleanup failed. Contact IT before trying again.`,
      { cause }
    )
    this.name = "IncompleteMemberError"
  }
}
