import { TRPCError } from "@trpc/server"
import { IncompleteMemberError, safeErrorDetail } from "@/azure/errors"
import { MAIL_DOMAIN, mailboxLocalPart } from "@/azure/mailbox"
import type { AzureDirectory, CreatedMember, MemberSummary } from "@/azure/types"
import type * as C from "./contract"
import type { ActivityEntry, Socio, SocioChanges, SociStore } from "./types"

type Logger = {
  info: (obj: object, msg: string) => void
  error: (obj: object, msg: string) => void
}

export type SociOptions = {
  store: SociStore
  directory: Pick<AzureDirectory, "createMember" | "deleteUser" | "findByMail" | "getSociMembers" | "setMemberNumber">
  /** The Entra-side lock and pending-number cache (`src/azure/member-writes.ts`). */
  writes: {
    serialize: <T>(task: () => Promise<T>) => Promise<T>
    numberHolder: (number: number) => Promise<MemberSummary | null>
    currentMember: (userId: string) => Promise<MemberSummary | null>
    rememberNumber: (member: MemberSummary, number: number, created?: boolean) => void
  }
  mail: {
    welcome: (
      to: string,
      credentials: { email: string; password: string },
      member: { firstName: string; assocNumber: number }
    ) => Promise<boolean>
    numberChanged: (
      to: string,
      member: {
        firstName: string | null
        assocNumber: number
        previousAssocNumber: string | null
        email: string | null
      }
    ) => Promise<boolean>
  }
  logger: Logger
  now?: () => Date
}

export function fail(
  code: "BAD_REQUEST" | "NOT_FOUND" | "CONFLICT" | "PRECONDITION_FAILED" | "INTERNAL_SERVER_ERROR",
  message: string
): never {
  throw new TRPCError({ code, message })
}

/** A member number written as Microsoft 365 holds it, when it is one. */
function parseNumber(employeeId: string | null) {
  return employeeId && /^[1-9]\d{0,5}$/.test(employeeId) ? Number(employeeId) : null
}

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
const FIELD_LABELS: Record<string, string> = {
  firstName: "first name",
  lastName: "last name",
  alias: "alias",
  codiceFiscale: "codice fiscale",
  birthDate: "birth date",
  birthPlace: "birth place",
  residence: "residence",
  admittedOn: "admission date",
}

export function createSociService(options: SociOptions) {
  const { store, directory, writes, mail, logger } = options
  const now = options.now ?? (() => new Date())
  const entry = (actor: string, text: string): ActivityEntry => ({ actor, text, at: now().toISOString() })

  async function sociGroup() {
    try {
      return await directory.getSociMembers()
    } catch (error) {
      logger.error({ error: safeErrorDetail(error) }, "[soci] could not read the Soci group")
      return null
    }
  }

  function row(s: Socio, soci: Set<string> | null): C.SocioRow {
    const inSoci = soci ? soci.has(s.entraObjectId) : null
    const mismatch =
      inSoci === null ? null : !s.endedOn && !inSoci ? "not_in_soci" : s.endedOn && inSoci ? "still_in_soci" : null
    return {
      number: s.number,
      entraObjectId: s.entraObjectId,
      mailbox: s.mailbox,
      displayName: s.displayName,
      firstName: s.firstName,
      lastName: s.lastName,
      alias: s.alias,
      codiceFiscale: s.codiceFiscale,
      admittedOn: s.admittedOn,
      endedOn: s.endedOn,
      endReason: s.endReason,
      accountState: s.accountState,
      inSoci,
      mismatch,
    }
  }

  async function find(number: number) {
    return (await store.byNumber(number)) ?? fail("NOT_FOUND", `There is no socio with number ${number}.`)
  }

  /** Free only if no record has ever held it and no Microsoft 365 user other than `self` has it. */
  async function requireFreeNumber(number: number, self: { memberId?: number; userId?: string } = {}) {
    const owner = await store.numberOwner(number)
    if (owner !== null && owner !== self.memberId)
      fail("CONFLICT", `Member number ${number} was already given to a socio: numbers are never reused.`)
    const holder = await writes.numberHolder(number)
    if (holder && holder.id !== self.userId)
      fail(
        "CONFLICT",
        `Member number ${number} is already assigned in Microsoft 365 to ${holder.displayName ?? holder.mail ?? "another user"}.`
      )
  }

  async function requireUniqueCodiceFiscale(codiceFiscale: string | null, self?: number) {
    if (!codiceFiscale) return
    const active = await store.activeByCodiceFiscale(codiceFiscale)
    if (active && active.id !== self)
      fail("CONFLICT", `This codice fiscale belongs to socio ${active.number}, who is still active.`)
  }

  const detailsOf = (d: C.SocioDetails) => ({
    firstName: d.firstName,
    lastName: d.lastName,
    alias: d.alias,
    codiceFiscale: d.codiceFiscale,
    birthDate: d.birthDate,
    birthPlace: d.birthPlace,
    residence: d.residence,
  })

  return {
    async list(): Promise<C.SociList> {
      const [records, group] = await Promise.all([store.list(), sociGroup()])
      const soci = group && new Set(group.map((m) => m.id))
      return { members: records.map((s) => row(s, soci)), directoryAvailable: soci !== null }
    },

    async get(input: C.NumberInput): Promise<C.SocioRecord> {
      const s = await find(input.number)
      const deleted = s.accountState === "deleted"
      const [history, group, account] = await Promise.all([
        store.activity(s.id),
        deleted ? Promise.resolve([]) : sociGroup(),
        deleted ? Promise.resolve(null) : writes.currentMember(s.entraObjectId).catch(() => null),
      ])
      const { id: _, ...record } = s
      return {
        ...record,
        ...row(s, group && new Set(group.map((m) => m.id))),
        accountNumber: account?.employeeId ?? null,
        activity: history,
      }
    },

    async unregistered(): Promise<C.Unregistered[]> {
      const group = (await sociGroup()) ?? fail("PRECONDITION_FAILED", "Microsoft 365 can't be read right now.")
      const registered = new Set((await store.list()).map((s) => s.entraObjectId))
      return group
        .filter((m) => !registered.has(m.id))
        .map((m) => ({
          entraObjectId: m.id,
          displayName: m.displayName,
          givenName: m.givenName,
          surname: m.surname,
          mail: m.mail,
          employeeId: m.employeeId,
          createdDateTime: m.createdDateTime,
        }))
        .sort(
          (a, b) =>
            (parseNumber(a.employeeId) ?? Number.MAX_SAFE_INTEGER) -
              (parseNumber(b.employeeId) ?? Number.MAX_SAFE_INTEGER) ||
            (a.displayName ?? "").localeCompare(b.displayName ?? "")
        )
    },

    /**
     * Today's Microsoft 365 workflow (account with `employeeId`, licences, Soci group, cleanup on failure), then the
     * record. A record that can't be written deletes the new account, like any other failed setup step.
     */
    async admit(actor: string, input: C.AdmitInput): Promise<C.AdmitResult> {
      const { account, number } = input
      const localPart = mailboxLocalPart(account.firstName, account.lastName, account.mailbox)
      if (localPart === null) fail("BAD_REQUEST", "This name cannot form a standard address: choose a custom one.")
      const address = `${localPart}@${MAIL_DOMAIN}`
      if (account.sendEmailTo.toLowerCase() === address)
        fail("BAD_REQUEST", "The welcome email cannot go to the address being created: it has no mailbox yet.")

      const { member, socio } = await writes.serialize(async () => {
        if (await directory.findByMail(address)) fail("CONFLICT", `The address ${address} is already in use.`)
        await requireFreeNumber(number)
        await requireUniqueCodiceFiscale(input.details.codiceFiscale)

        const displayName = `${account.firstName} ${account.lastName}`
        let member: CreatedMember
        try {
          member = await directory.createMember({
            firstName: account.firstName,
            lastName: account.lastName,
            assocNumber: number,
            localPart,
          })
        } catch (error) {
          if (error instanceof IncompleteMemberError) {
            writes.rememberNumber(error.member, number, true)
            logger.error({ error: safeErrorDetail(error.cause), by: actor }, "[soci] account setup incomplete")
            fail("INTERNAL_SERVER_ERROR", error.message)
          }
          logger.error({ error: safeErrorDetail(error), by: actor, number }, "[soci] could not create the account")
          if (
            error instanceof Error &&
            /same value for property (userPrincipalName|proxyAddresses)/i.test(error.message)
          )
            fail("CONFLICT", `The address ${address} is already in use.`)
          fail("INTERNAL_SERVER_ERROR", "Microsoft 365 refused to create the account, see the backend logs.")
        }
        const summary: MemberSummary = {
          id: member.id,
          displayName,
          givenName: account.firstName,
          mail: member.mail,
          employeeId: String(number),
        }

        const at = now().toISOString()
        let socio: Socio
        try {
          socio = await store.insert(
            {
              number,
              entraObjectId: member.id,
              mailbox: member.mail,
              displayName,
              ...detailsOf(input.details),
              admittedOn: input.admittedOn,
              endedOn: null,
              endReason: null,
              endNote: null,
              accountState: "active",
              accountDeletedOn: null,
              createdBy: actor,
              createdAt: at,
              updatedBy: actor,
              updatedAt: at,
            },
            entry(actor, `Admitted with number ${number}; account ${member.mail} created`)
          )
        } catch (error) {
          logger.error({ error: safeErrorDetail(error), by: actor, memberId: member.id }, "[soci] record not written")
          try {
            await directory.deleteUser(member.id)
          } catch (cleanupError) {
            writes.rememberNumber(summary, number, true)
            logger.error(
              { error: safeErrorDetail(cleanupError), memberId: member.id },
              "[soci] could not delete the account after the record failed"
            )
            fail(
              "INTERNAL_SERVER_ERROR",
              `Account ${member.mail} was created, but its record couldn't be saved and the account couldn't be deleted. Contact IT before trying again.`
            )
          }
          fail("INTERNAL_SERVER_ERROR", "The record couldn't be saved, so the new account was deleted. Try again.")
        }
        writes.rememberNumber(summary, number, true)
        return { member, socio }
      })
      logger.info({ by: actor, memberId: member.id, number }, "[soci] socio admitted")

      let welcomeMailSent = false
      try {
        welcomeMailSent = await mail.welcome(
          account.sendEmailTo,
          { email: member.mail, password: member.password },
          { firstName: account.firstName, assocNumber: number }
        )
      } catch (error) {
        logger.error({ error: safeErrorDetail(error), by: actor, memberId: member.id }, "[soci] welcome email failed")
      }
      return { number: socio.number, entraObjectId: member.id, mailbox: member.mail, welcomeMailSent }
    },

    /**
     * A record for an account already in the Soci group. Its number is the account's; an account without one gets
     * the number given here.
     */
    async register(actor: string, input: C.RegisterInput): Promise<C.NumberInput> {
      const socio = await writes.serialize(async () => {
        const existing = await store.byObjectId(input.entraObjectId)
        if (existing) fail("CONFLICT", `This account already has a record: socio ${existing.number}.`)
        const group =
          (await directory.getSociMembers().catch((error) => {
            logger.error({ error: safeErrorDetail(error) }, "[soci] could not read the Soci group")
            return null
          })) ?? fail("PRECONDITION_FAILED", "Microsoft 365 can't be read right now.")
        const listed = group.find((m) => m.id === input.entraObjectId)
        if (!listed) fail("PRECONDITION_FAILED", "This account isn't in the Soci group in Microsoft 365.")
        const account = (await writes.currentMember(input.entraObjectId)) ?? listed

        const accountNumber = parseNumber(account.employeeId)
        if (accountNumber !== null && input.number !== undefined && input.number !== accountNumber)
          fail(
            "BAD_REQUEST",
            `The account has member number ${accountNumber}: register it with that number, then change it.`
          )
        const number =
          accountNumber ??
          input.number ??
          fail("BAD_REQUEST", "The account has no member number in Microsoft 365: choose one.")
        await requireFreeNumber(number, { userId: account.id })
        await requireUniqueCodiceFiscale(input.details.codiceFiscale)

        if (accountNumber === null) {
          const { error } = await directory.setMemberNumber(account.id, number)
          if (error) {
            logger.error({ error: safeErrorDetail(error), by: actor, memberId: account.id }, "[soci] number not set")
            fail("INTERNAL_SERVER_ERROR", "Microsoft 365 refused the member number, see the backend logs.")
          }
          writes.rememberNumber(account, number)
        }

        const at = now().toISOString()
        // If this fails after the number was set, trying again finds the account with it and goes on.
        return store.insert(
          {
            number,
            entraObjectId: account.id,
            mailbox: account.mail ?? listed.mail ?? "",
            displayName:
              account.displayName ?? listed.displayName ?? `${input.details.firstName} ${input.details.lastName}`,
            ...detailsOf(input.details),
            admittedOn: input.admittedOn,
            endedOn: null,
            endReason: null,
            endNote: null,
            accountState: "active",
            accountDeletedOn: null,
            createdBy: actor,
            createdAt: at,
            updatedBy: actor,
            updatedAt: at,
          },
          entry(
            actor,
            accountNumber === null
              ? `Registered from Microsoft 365 with the new number ${number}`
              : `Registered from Microsoft 365 with number ${number}`
          )
        )
      })
      logger.info({ by: actor, memberId: socio.entraObjectId, number: socio.number }, "[soci] socio registered")
      return { number: socio.number }
    },

    async update(actor: string, input: C.UpdateInput): Promise<void> {
      await writes.serialize(async () => {
        const s = await find(input.number)
        // An ended record may share its code with the person's current one.
        if (!s.endedOn) await requireUniqueCodiceFiscale(input.details.codiceFiscale, s.id)
        const next = { ...detailsOf(input.details), admittedOn: input.admittedOn }
        const changed = (Object.keys(next) as (keyof typeof next)[]).filter((key) => !sameValue(next[key], s[key]))
        if (!changed.length) return
        const changes: SocioChanges = {
          ...Object.fromEntries(changed.map((key) => [key, next[key]])),
          updatedBy: actor,
          updatedAt: now().toISOString(),
        }
        await store.update(s.id, changes, entry(actor, `Edited ${changed.map((key) => FIELD_LABELS[key]).join(", ")}`))
      })
    },

    /** Changes the number on the account (`employeeId`) and on the record, optionally emailing it. */
    async setNumber(actor: string, input: C.SetNumberInput): Promise<C.SetNumberResult> {
      const { s, member } = await writes.serialize(async () => {
        const s = await find(input.number)
        if (input.newNumber === s.number) fail("BAD_REQUEST", `The socio already has number ${s.number}.`)
        if (s.accountState === "deleted") fail("PRECONDITION_FAILED", "The socio's account has been deleted.")
        const member =
          (await writes.currentMember(s.entraObjectId)) ??
          fail("PRECONDITION_FAILED", "The socio's account no longer exists in Microsoft 365.")
        await requireFreeNumber(input.newNumber, { memberId: s.id, userId: member.id })

        const { error } = await directory.setMemberNumber(member.id, input.newNumber)
        if (error) {
          logger.error({ error: safeErrorDetail(error), by: actor, memberId: member.id }, "[soci] number not changed")
          fail("INTERNAL_SERVER_ERROR", "Microsoft 365 refused the change, see the backend logs.")
        }
        writes.rememberNumber(member, input.newNumber)
        try {
          await store.changeNumber(
            s.id,
            input.newNumber,
            entry(actor, `Member number changed from ${s.number} to ${input.newNumber}`)
          )
        } catch (error) {
          logger.error({ error: safeErrorDetail(error), by: actor, memberId: member.id }, "[soci] number not saved")
          // Put the account back on the record's number, so the two agree.
          const restored = await directory.setMemberNumber(member.id, s.number)
          if (!restored.error) writes.rememberNumber({ ...member, employeeId: String(input.newNumber) }, s.number)
          fail("INTERNAL_SERVER_ERROR", "The new number couldn't be saved; the account keeps the old one.")
        }
        return { s, member }
      })
      logger.info({ by: actor, memberId: member.id, from: s.number, to: input.newNumber }, "[soci] number changed")

      let notificationSent: boolean | null = null
      if (input.notifyEmail) {
        try {
          notificationSent = await mail.numberChanged(input.notifyEmail, {
            firstName: s.alias ?? member.givenName ?? s.firstName,
            assocNumber: input.newNumber,
            previousAssocNumber: String(s.number),
            email: member.mail,
          })
        } catch (error) {
          logger.error({ error: safeErrorDetail(error), by: actor, memberId: member.id }, "[soci] number email failed")
          notificationSent = false
        }
      }
      return { number: input.newNumber, notificationSent }
    },
  }
}

export type SociService = ReturnType<typeof createSociService>
