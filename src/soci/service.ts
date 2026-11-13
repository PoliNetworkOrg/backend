import { randomUUID } from "node:crypto"
import { TRPCError } from "@trpc/server"
import { IncompleteMemberError, safeErrorDetail } from "@/azure/errors"
import { MAIL_DOMAIN, mailboxLocalPart } from "@/azure/mailbox"
import type { AzureDirectory, CreatedMember, MemberSummary } from "@/azure/types"
import { matchesBirthDate } from "./codice-fiscale"
import * as C from "./contract"
import {
  exemptYearFor,
  FEE_CENTS,
  feeYearLabel,
  feeYearOf,
  formatEuro,
  formatItalianDay,
  paymentReference,
  reminderDay,
  reminderOn,
  renewalDeadline,
  romeDay,
} from "./fees"
import { receiptType } from "./receipt"
import type {
  ActivityEntry,
  FeeMailData,
  MailKind,
  NewFee,
  NewMail,
  SociMail,
  Socio,
  SocioChanges,
  SociStore,
  StoredFee,
} from "./types"

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
  /** Fees: the bank details of the association, My area's address, and the outbox's sender. */
  fees: {
    /** `null` until `SOCI_IBAN` and `SOCI_BENEFICIARI` are set: then no fee year is opened. */
    bank: { iban: string; beneficiary: string } | null
    myAreaUrl: string
    send: (mail: SociMail) => Promise<void>
  }
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
const SYSTEM = "system"
const SELF_LABELS: Record<(typeof C.SELF_FIELDS)[number], string> = {
  codiceFiscale: "codice fiscale",
  birthDate: "birth date",
  birthPlace: "birth place",
  residence: "residence",
  phone: "phone",
}
const emptyFee = {
  fileId: null,
  transferDate: null,
  declaredCents: null,
  uploadedAt: null,
  reviewedBy: null,
  reviewedAt: null,
  rejectionReason: null,
  paidOn: null,
  method: null,
  note: null,
  recordedBy: null,
} satisfies Partial<NewFee>
const FIELD_LABELS: Record<string, string> = {
  firstName: "first name",
  lastName: "last name",
  alias: "alias",
  codiceFiscale: "codice fiscale",
  birthDate: "birth date",
  birthPlace: "birth place",
  residence: "residence",
  phone: "phone",
  admittedOn: "admission date",
}

export function createSociService(options: SociOptions) {
  const { store, directory, writes, mail, logger } = options
  const now = options.now ?? (() => new Date())
  const entry = (actor: string, text: string): ActivityEntry => ({ actor, text, at: now().toISOString() })
  const today = () => romeDay(now())
  const currentYear = () => feeYearOf(today())

  /** The fee year of the admission, recorded as paid: the Direttivo admits someone after they've paid. */
  function admissionFee(admittedOn: string, actor: string, at: string): NewFee {
    return {
      ...emptyFee,
      year: feeYearOf(admittedOn),
      status: "paid",
      amountCents: FEE_CENTS,
      paidOn: admittedOn,
      method: "admission",
      recordedBy: actor,
      createdAt: at,
      updatedAt: at,
    }
  }

  async function feeView(fees: StoredFee[]): Promise<C.Fee[]> {
    const names = await store.fileNames(fees.flatMap((f) => (f.fileId ? [f.fileId] : [])))
    return fees.map((f) => {
      const file = f.fileId ? names.get(f.fileId) : undefined
      return {
        year: f.year,
        label: feeYearLabel(f.year),
        status: f.status,
        amountCents: f.amountCents,
        upload:
          f.fileId && file && f.transferDate && f.declaredCents !== null && f.uploadedAt
            ? {
                fileId: f.fileId,
                fileName: file.fileName,
                contentType: file.contentType,
                transferDate: f.transferDate,
                declaredCents: f.declaredCents,
                uploadedAt: f.uploadedAt,
              }
            : null,
        lastRejection:
          f.rejectionReason && f.reviewedBy && f.reviewedAt
            ? { reason: f.rejectionReason, by: f.reviewedBy, at: f.reviewedAt }
            : null,
        payment:
          f.status === "paid" && f.paidOn && f.method && f.recordedBy
            ? { paidOn: f.paidOn, method: f.method, note: f.note, recordedBy: f.recordedBy }
            : null,
      }
    })
  }

  /** What every fee email shows, for the socio and the fee year. */
  function mailData(s: Socio, year: number, extra: Partial<FeeMailData> = {}): FeeMailData {
    return {
      name: s.alias ?? s.firstName,
      yearLabel: feeYearLabel(year),
      amount: formatEuro(FEE_CENTS),
      deadline: formatItalianDay(renewalDeadline(year)),
      iban: options.fees.bank?.iban ?? "",
      beneficiary: options.fees.bank?.beneficiary ?? "",
      reference: paymentReference(year, s.number, s.firstName, s.lastName),
      myAreaUrl: options.fees.myAreaUrl,
      ...extra,
    }
  }

  /** An email to the socio's PoliNetwork mailbox, or none once the account is gone. */
  function feeMail(s: Socio, id: string, kind: MailKind, data: FeeMailData): NewMail | undefined {
    return s.accountState === "deleted" ? undefined : { id, to: s.mailbox, kind, data }
  }

  async function feeOf(s: Socio, year: number) {
    return (await store.fees({ memberId: s.id, year }))[0] ?? null
  }

  async function requireFee(s: Socio, year: number) {
    return (await feeOf(s, year)) ?? fail("NOT_FOUND", `Socio ${s.number} has no fee for ${feeYearLabel(year)}.`)
  }

  /** A review applies only to the receipt that was reviewed, not to one the socio uploaded since. */
  function reviewed(fee: StoredFee, fileId: string) {
    if (fee.fileId !== fileId) fail("CONFLICT", "The socio uploaded a new receipt in the meantime: review that one.")
  }

  function changed(ok: boolean) {
    if (!ok) fail("CONFLICT", "The fee changed in the meantime: reload and try again.")
  }

  /** The socio behind the signed-in account, found by its Microsoft 365 object ID. */
  async function self(entraObjectId: string) {
    return (await store.byObjectId(entraObjectId)) ?? fail("NOT_FOUND", "Your account has no socio record.")
  }

  async function sociGroup() {
    try {
      return await directory.getSociMembers()
    } catch (error) {
      logger.error({ error: safeErrorDetail(error) }, "[soci] could not read the Soci group")
      return null
    }
  }

  function row(s: Socio, soci: Set<string> | null, fee: StoredFee | null = null): C.SocioRow {
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
      fee: fee?.status ?? null,
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
    phone: d.phone,
  })

  return {
    async list(): Promise<C.SociList> {
      const [records, group, fees] = await Promise.all([store.list(), sociGroup(), store.fees({ year: currentYear() })])
      const soci = group && new Set(group.map((m) => m.id))
      const feeOfMember = new Map(fees.map((f) => [f.memberId, f]))
      return {
        members: records.map((s) => row(s, soci, feeOfMember.get(s.id) ?? null)),
        directoryAvailable: soci !== null,
      }
    },

    async get(input: C.NumberInput): Promise<C.SocioRecord> {
      const s = await find(input.number)
      const deleted = s.accountState === "deleted"
      const [history, group, account, fees] = await Promise.all([
        store.activity(s.id),
        deleted ? Promise.resolve([]) : sociGroup(),
        deleted ? Promise.resolve(null) : writes.currentMember(s.entraObjectId).catch(() => null),
        store.fees({ memberId: s.id }),
      ])
      const { id: _, ...record } = s
      return {
        ...record,
        ...row(
          s,
          group && new Set(group.map((m) => m.id)),
          fees.find((f) => f.year === currentYear())
        ),
        accountNumber: account?.employeeId ?? null,
        activity: history,
        fees: await feeView(fees),
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
            entry(actor, `Admitted with number ${number}; account ${member.mail} created`),
            [admissionFee(input.admittedOn, actor, at)]
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
          ),
          [admissionFee(input.admittedOn, actor, at)]
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

    // Fees, for the Direttivo.

    async listFees(input: C.FeesListInput): Promise<C.FeesList> {
      const year = input.year ?? currentYear()
      const [fees, records] = await Promise.all([store.fees({ year }), store.list()])
      const byId = new Map(records.map((s) => [s.id, s]))
      const totals = { due: 0, uploaded: 0, paid: 0, exempt: 0 }
      for (const f of fees) totals[f.status]++
      const shown = fees.filter((f) => !input.status || f.status === input.status)
      const views = await feeView(shown)
      return {
        year,
        label: feeYearLabel(year),
        totals,
        fees: shown
          .map((f, i) => {
            const s = byId.get(f.memberId) as Socio
            return {
              number: s.number,
              firstName: s.firstName,
              lastName: s.lastName,
              alias: s.alias,
              mailbox: s.mailbox,
              endedOn: s.endedOn,
              fee: views[i],
            }
          })
          .sort((a, b) => a.number - b.number),
      }
    },

    async feeFile(input: { fileId: string }): Promise<C.FeeFile> {
      const file = (await store.file(input.fileId)) ?? fail("NOT_FOUND", "There is no such file.")
      return {
        fileName: file.fileName,
        contentType: file.contentType,
        base64: Buffer.from(file.content).toString("base64"),
      }
    },

    async confirmFee(actor: string, input: C.ReviewInput): Promise<void> {
      const s = await find(input.number)
      const fee = await requireFee(s, input.year)
      if (fee.status !== "uploaded") fail("PRECONDITION_FAILED", "Only an uploaded receipt can be confirmed.")
      reviewed(fee, input.fileId)
      const at = now().toISOString()
      changed(
        await store.updateFee(
          { ...fee, fileId: input.fileId },
          ["uploaded"],
          {
            status: "paid",
            paidOn: fee.transferDate,
            method: "transfer",
            note: null,
            recordedBy: actor,
            reviewedBy: actor,
            reviewedAt: at,
            updatedAt: at,
          },
          entry(actor, `Confirmed the ${feeYearLabel(input.year)} fee`),
          feeMail(
            s,
            `confirmed:${input.year}:${s.id}`,
            "confirmed",
            mailData(s, input.year, { paidOn: formatItalianDay(fee.transferDate as string) })
          )
        )
      )
      logger.info({ by: actor, number: s.number, year: input.year }, "[soci] fee confirmed")
    },

    async rejectFee(actor: string, input: C.RejectInput): Promise<void> {
      const s = await find(input.number)
      const fee = await requireFee(s, input.year)
      if (fee.status !== "uploaded") fail("PRECONDITION_FAILED", "Only an uploaded receipt can be rejected.")
      reviewed(fee, input.fileId)
      const at = now().toISOString()
      changed(
        await store.updateFee(
          { ...fee, fileId: input.fileId },
          ["uploaded"],
          { status: "due", rejectionReason: input.reason, reviewedBy: actor, reviewedAt: at, updatedAt: at },
          entry(actor, `Rejected the ${feeYearLabel(input.year)} receipt: ${input.reason}`),
          feeMail(
            s,
            `rejected:${input.year}:${s.id}:${fee.uploadedAt}`,
            "rejected",
            mailData(s, input.year, { reason: input.reason })
          )
        )
      )
      logger.info({ by: actor, number: s.number, year: input.year }, "[soci] fee rejected")
    },

    /** Records a payment made outside the dashboard, opening the fee if the year hasn't opened it yet. */
    async markPaid(actor: string, input: C.MarkPaidInput): Promise<void> {
      const s = await find(input.number)
      if (input.year > currentYear()) fail("BAD_REQUEST", `The ${feeYearLabel(input.year)} fee year hasn't started.`)
      if (input.year < feeYearOf(s.admittedOn))
        fail("BAD_REQUEST", `Socio ${s.number} was admitted after ${feeYearLabel(input.year)}.`)
      if (input.paidOn > today()) fail("BAD_REQUEST", "The payment date is in the future.")
      const at = now().toISOString()
      const payment = {
        status: "paid" as const,
        paidOn: input.paidOn,
        method: input.method,
        note: input.note,
        recordedBy: actor,
        updatedAt: at,
      }
      const text = `Marked the ${feeYearLabel(input.year)} fee as paid (${input.method}, ${input.paidOn})`
      const email = feeMail(
        s,
        `confirmed:${input.year}:${s.id}`,
        "confirmed",
        mailData(s, input.year, { paidOn: formatItalianDay(input.paidOn) })
      )
      const fee = await feeOf(s, input.year)
      if (!fee) {
        if (exemptYearFor(s.admittedOn) === input.year)
          fail("PRECONDITION_FAILED", `The ${feeYearLabel(input.year)} fee is exempt.`)
        const opened = await store.openFee(
          s.id,
          { ...emptyFee, ...payment, year: input.year, amountCents: FEE_CENTS, createdAt: at },
          entry(actor, text),
          email
        )
        changed(opened !== null)
      } else {
        if (fee.status === "paid") fail("CONFLICT", `The ${feeYearLabel(input.year)} fee is already paid.`)
        if (fee.status === "exempt") fail("PRECONDITION_FAILED", `The ${feeYearLabel(input.year)} fee is exempt.`)
        changed(await store.updateFee(fee, ["due", "uploaded"], payment, entry(actor, text), email))
      }
      logger.info({ by: actor, number: s.number, year: input.year }, "[soci] fee marked as paid")
    },

    // My area: the signed-in socio, found by their Microsoft 365 object ID.

    async me(entraObjectId: string): Promise<C.Me> {
      const s = await self(entraObjectId)
      const year = currentYear()
      const fees = await store.fees({ memberId: s.id })
      return {
        number: s.number,
        admittedOn: s.admittedOn,
        endedOn: s.endedOn,
        endReason: s.endReason,
        details: {
          firstName: s.firstName,
          lastName: s.lastName,
          alias: s.alias,
          codiceFiscale: s.codiceFiscale,
          birthDate: s.birthDate,
          birthPlace: s.birthPlace,
          residence: s.residence,
          phone: s.phone,
        },
        missing: C.SELF_FIELDS.filter((key) => key !== "phone" && s[key] === null),
        payment: {
          year,
          label: feeYearLabel(year),
          amountCents: FEE_CENTS,
          deadline: renewalDeadline(year),
          reference: paymentReference(year, s.number, s.firstName, s.lastName),
          iban: options.fees.bank?.iban ?? null,
          beneficiary: options.fees.bank?.beneficiary ?? null,
        },
        fees: await feeView(fees),
      }
    },

    /** The transfer receipt for this fee year, replacing one still waiting for review. */
    async uploadReceipt(
      entraObjectId: string,
      sub: string,
      file: { name: string; bytes: Uint8Array },
      input: C.ReceiptInput
    ): Promise<void> {
      const s = await self(entraObjectId)
      if (s.endedOn) fail("PRECONDITION_FAILED", "Your socio status has ended.")
      const year = currentYear()
      const fee =
        (await feeOf(s, year)) ??
        fail("PRECONDITION_FAILED", `Your ${feeYearLabel(year)} fee isn't open yet: try again tomorrow.`)
      if (fee.status === "paid") fail("PRECONDITION_FAILED", `Your ${feeYearLabel(year)} fee is already paid.`)
      if (fee.status === "exempt") fail("PRECONDITION_FAILED", `You're exempt from the ${feeYearLabel(year)} fee.`)
      if (input.transferDate > today()) fail("BAD_REQUEST", "The transfer date is in the future.")
      const contentType = await receiptType(file.bytes)
      const at = now().toISOString()
      const fileId = randomUUID()
      const fileName =
        file.name
          .replace(/^.*[\\/]/, "")
          .split("")
          .filter((c) => c.charCodeAt(0) >= 32)
          .join("")
          .trim()
          .slice(0, 200) || "receipt"
      changed(
        await store.updateFee(
          fee,
          ["due", "uploaded"],
          {
            status: "uploaded",
            fileId,
            transferDate: input.transferDate,
            declaredCents: input.declaredCents,
            uploadedAt: at,
            updatedAt: at,
          },
          entry(sub, `Uploaded a transfer receipt for ${feeYearLabel(year)}`),
          undefined,
          { id: fileId, memberId: s.id, fileName, contentType, content: file.bytes, uploadedBy: sub, uploadedAt: at }
        )
      )
      logger.info({ number: s.number, year }, "[soci] receipt uploaded")
    },

    /** Fills in the socio's own empty fields. Recorded ones only the Direttivo changes. */
    async completeDetails(entraObjectId: string, sub: string, input: C.CompleteDetailsInput): Promise<void> {
      await writes.serialize(async () => {
        const s = await self(entraObjectId)
        if (s.endedOn) fail("PRECONDITION_FAILED", "Your socio status has ended.")
        const given = C.SELF_FIELDS.filter((key) => input[key] !== null)
        const recorded = given.filter((key) => s[key] !== null)
        if (recorded.length)
          fail(
            "BAD_REQUEST",
            `Already recorded: ${recorded.map((key) => SELF_LABELS[key]).join(", ")}. Ask the Direttivo to change it.`
          )
        const codiceFiscale = input.codiceFiscale ?? s.codiceFiscale
        const birthDate = input.birthDate ?? s.birthDate
        if (codiceFiscale && birthDate && !matchesBirthDate(codiceFiscale, birthDate))
          fail("BAD_REQUEST", "The birth date doesn't match the codice fiscale.")
        if (input.codiceFiscale && !s.endedOn) await requireUniqueCodiceFiscale(input.codiceFiscale, s.id)
        await store.update(
          s.id,
          {
            ...Object.fromEntries(given.map((key) => [key, input[key]])),
            updatedBy: sub,
            updatedAt: now().toISOString(),
          },
          entry(sub, `Completed ${given.map((key) => SELF_LABELS[key]).join(", ")}`)
        )
      })
    },

    // Jobs.

    /**
     * Daily: opens this fee year for every active socio without a fee, Due (with the opening email until the deadline)
     * or Exempt, then sends the 1 and 21 December reminders. Idempotent: a second run that day opens and queues nothing.
     */
    async runDaily(): Promise<{ opened: number; reminded: number }> {
      const bank = options.fees.bank
      if (!bank) {
        logger.error({}, "[soci] SOCI_IBAN and SOCI_BENEFICIARI aren't set: no fee year is opened")
        return { opened: 0, reminded: 0 }
      }
      const day = today()
      const year = feeYearOf(day)
      const label = feeYearLabel(year)
      const records = await store.list()
      const byId = new Map(records.map((s) => [s.id, s]))
      const open = new Set((await store.fees({ year })).map((f) => f.memberId))
      let opened = 0
      for (const s of records) {
        if (s.endedOn || open.has(s.id) || s.admittedOn > day || feeYearOf(s.admittedOn) > year) continue
        const exempt = exemptYearFor(s.admittedOn) === year
        const at = now().toISOString()
        const fee = await store.openFee(
          s.id,
          {
            ...emptyFee,
            year,
            status: exempt ? "exempt" : "due",
            amountCents: exempt ? 0 : FEE_CENTS,
            createdAt: at,
            updatedAt: at,
          },
          entry(SYSTEM, exempt ? `Opened the ${label} fee: exempt, admitted in the summer` : `Opened the ${label} fee`),
          // Past the renewal deadline the email would ask to pay by a day gone: the fee opens Due without it.
          exempt || day > renewalDeadline(year)
            ? undefined
            : feeMail(s, `opening:${year}:${s.id}`, "opening", mailData(s, year))
        )
        if (fee) opened++
      }

      let reminded = 0
      const reminder = reminderOn(day)
      if (reminder)
        for (const fee of await store.fees({ year })) {
          const s = byId.get(fee.memberId)
          if (fee.status !== "due" || !s || s.endedOn) continue
          // Opened or rejected on or after the reminder's day: that email already gave the deadline.
          if (romeDay(new Date(fee.updatedAt)) >= reminderDay(year, reminder)) continue
          const email = feeMail(s, `reminder:${year}:${reminder}:${s.id}`, "reminder", mailData(s, year))
          if (email && (await store.enqueue(s.id, email, now().toISOString()))) reminded++
        }
      if (opened || reminded) logger.info({ year, opened, reminded }, "[soci] daily fee run")
      return { opened, reminded }
    },

    /** Sends queued fee emails; the cron calls it every minute. */
    async deliverPending(): Promise<void> {
      const at = now()
      const claimed = await store.claimMail(at.toISOString(), new Date(at.getTime() - 10 * 60_000).toISOString(), 20)
      for (const queued of claimed) {
        let error: string | null = null
        try {
          await options.fees.send(queued)
        } catch (err) {
          error = err instanceof Error ? err.message : String(err)
          logger.error({ error: safeErrorDetail(err), mail: queued.id }, "[soci] fee email failed")
        }
        await store.finishMail(queued, error, now().toISOString())
      }
    },
  }
}

export type SociService = ReturnType<typeof createSociService>
