import { azureDirectory } from "./directory"
import type { MemberSummary } from "./types"

/**
 * Runs member writes one at a time, so two requests cannot both pass the duplicate checks before either writes.
 * Entra does not enforce a unique `employeeId`, and the backend runs as a single instance.
 */
let memberWrites: Promise<unknown> = Promise.resolve()
export function serializeMemberWrite<T>(task: () => Promise<T>): Promise<T> {
  const run = memberWrites.then(task, task)
  memberWrites = run.catch(() => undefined)
  return run
}

// Keep successful writes until both directory searches and user reads can see them.
const pendingNumbers = new Map<
  number,
  { member: MemberSummary; previousNumbers: Set<string | null>; created: boolean; userVisible: boolean }
>()

export function rememberNumber(member: MemberSummary, assocNumber: number, created = false) {
  const previousNumbers = new Set([member.employeeId])
  for (const [number, pending] of pendingNumbers) {
    if (pending.member.id === member.id) {
      for (const previous of pending.previousNumbers) previousNumbers.add(previous)
      previousNumbers.add(pending.member.employeeId)
      created ||= pending.created && !pending.userVisible
      pendingNumbers.delete(number)
    }
  }
  if (created) previousNumbers.add(null)
  pendingNumbers.set(assocNumber, {
    member: { ...member, employeeId: assocNumber.toString() },
    previousNumbers,
    created,
    userVisible: false,
  })
}

export async function currentMember(userId: string) {
  const member = await azureDirectory.getMember(userId)
  const entry = [...pendingNumbers.entries()].find(([, pending]) => pending.member.id === userId)
  if (!entry) return member
  const [number, pending] = entry
  if (member?.employeeId === pending.member.employeeId) pending.userVisible = true
  const externalChange =
    (member === null && !pending.created) ||
    (member !== null &&
      !pending.previousNumbers.has(member.employeeId) &&
      member.employeeId !== pending.member.employeeId)
  if (pending.userVisible || externalChange) {
    // Once the user read has caught up, later edits or deletions in Entra are authoritative.
    if (member?.employeeId !== pending.member.employeeId) pendingNumbers.delete(number)
    return member
  }
  return { ...(member ?? pending.member), employeeId: pending.member.employeeId }
}

export async function numberHolder(assocNumber: number) {
  const holder = await azureDirectory.findByMemberNumber(assocNumber)
  const pending = pendingNumbers.get(assocNumber)
  if (pending) {
    await currentMember(pending.member.id)
    if (!pendingNumbers.has(assocNumber)) return holder
    if (holder?.id === pending.member.id && pending.userVisible) pendingNumbers.delete(assocNumber)
    return pending.member
  }
  return holder
}
