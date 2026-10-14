import type { MemberSummary } from "./types"

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
