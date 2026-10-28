import { randomBytes, randomUUID } from "node:crypto"
import { zipSync } from "fflate"
import * as C from "./contract"
import { evidenceBetween } from "./identity"
import { MAX_FILE_BYTES, parseImport } from "./imports"
import {
  accountsOf,
  attachAccount,
  awaitingReason,
  decideFor,
  openReview,
  reconcilePreliminary,
  signInState,
} from "./linking"
import { mergePeople } from "./merge"
import {
  academicYear,
  csvCell,
  fail,
  fee,
  filePayload,
  find,
  findReceipt,
  general,
  hash,
  leads,
  log,
  longDate,
  nameOf,
  newestReceipts,
  newPerson,
  office,
  own,
  queue,
  receiptEligible,
  record,
  ref,
  requireGeneral,
  requireOwn,
  requireSelf,
  row,
  teamAccess,
  today,
  validateFields,
} from "./model"
import { receiptPdf } from "./pdf"
import {
  type AzureMember,
  boundRoles,
  flagForReview,
  type PeopleRoles,
  RoleChangeError,
  type RoleDirectory,
  type RoleResult,
  roleChanges,
  roleView,
  syncDirectory,
  syncMembers,
  syncPersonRoles,
  wantedView,
} from "./roles"
import type {
  Account,
  ImportRow,
  MailAction,
  PeopleConfig,
  PeopleState,
  PeopleStore,
  Person,
  StoredReceipt,
  TelegramUser,
  UnitOfWork,
  Viewer,
} from "./types"

export type PeopleOptions = {
  store: PeopleStore
  config: PeopleConfig
  now?: () => Date
  /** Accounts when People runs without PoliNetwork Auth (development and tests); otherwise Auth's People directory. */
  directory?: () => Promise<Account[]>
  telegramUsers: () => Promise<TelegramUser[]>
  provisionMember: (person: Person, number: string) => Promise<{ id: string; email: string }>
  setMemberNumber: (person: Person, number: string) => Promise<void>
  sendMail: (mail: {
    id: string
    to: string
    subject: string
    text: string
    /** The recipient's first name, for the greeting. */
    firstName: string | null
    action: MailAction | null
    attachment: { fileName: string; contentType: string; content: Uint8Array } | null
  }) => Promise<void>
  verifySigned: (sub: string, requestId: string, bytes: Uint8Array) => Promise<{ signer: string; content: Uint8Array }>
  inspectSigned: (sub: string, bytes: Uint8Array) => Promise<{ signer: string }>
  completeSigned: (sub: string, requestId: string, bytes: Uint8Array) => Promise<void>
  transferType: (bytes: Uint8Array) => Promise<string>
  /** Roles bound to People in PoliNetwork Auth; `null` when the backend can't reach it. */
  allowLocalPeople?: boolean
  peopleRoles?: PeopleRoles | null
  /** Members of the Microsoft 365 Soci group. */
  azureMembers?: () => Promise<AzureMember[]>
}

/**
 * How long People reuses what it read from its sources, in memory only: it stores no copy of them. PoliNetwork Auth
 * decides who holds which role, Microsoft 365 who is a member and their number, Telegram who administers a group.
 */
export const SOURCE_TTL_MS = { directory: 15_000, members: 5 * 60_000 }
/** Past this, People refuses to work rather than decide who leads or administers from an old answer. */
export const DIRECTORY_MAX_AGE_MS = 60 * 60_000
/** At most one extra read of Auth this often for an account it didn't list. */
const UNKNOWN_ACCOUNT_REREAD_MS = 2_000
type RoleSnapshot = Pick<Person, "admin" | "teams">
const PENDING_ROLES = "A role change for this person is waiting for PoliNetwork Auth; try again in a moment."
const AWAITING_AUTH = "Awaiting confirmation from PoliNetwork Auth"

/**
 * The roles of a record about to be linked that PoliNetwork Auth has confirmed: none. Its active roles are ended until
 * Auth confirms them, so a role Auth refuses never grants access; their history and details are kept.
 */
function unconfirmed(p: Person, on: string): RoleSnapshot {
  const ended = { endedOn: on, endReason: AWAITING_AUTH }
  return structuredClone({
    admin:
      p.admin?.status === "active" ? { ...p.admin, ...ended, status: "former" as const, capoScope: null } : p.admin,
    teams: p.teams.map((t) => (t.endedOn ? t : { ...t, ...ended })),
  })
}

export function createPeopleService(options: PeopleOptions) {
  const { store, config } = options
  /** The account holder's area in the dashboard, where every People email leads. */
  const AREA = `${config.dashboardUrl}/dashboard/account/me`
  const feeReminder = (f: { year: string; dueOn: string; amountCents: number }) =>
    `ti ricordiamo che la quota associativa ${f.year} di PoliNetwork, di ${(f.amountCents / 100).toLocaleString("it-IT", { style: "currency", currency: "EUR" })}, è da versare. Scadenza: ${longDate(f.dueOn)}.\n\nNella tua area personale trovi le coordinate per il bonifico e puoi caricare la ricevuta. Se l'hai già versata, ignora questo messaggio.`
  const now = options.now ?? (() => new Date())
  const date = () => today(now())
  const year = () => academicYear(date())
  /**
   * A People transaction on the register alone. Role commands it records for PoliNetwork Auth are delivered after it
   * commits, so the People lock is never held across a call to Auth; a refused direct dashboard change (`strict`) then
   * fails the call. Only internal work (deliveries, the sweep) uses it directly: everything else goes through `tx`.
   */
  const commit = async <T>(fn: (u: UnitOfWork) => Promise<T> | T): Promise<T> => {
    let queued: { personId: string; strict: boolean }[] = []
    const result = await store.transaction(async (u) => {
      const known = new Set(Object.values(u.state.persons).flatMap((p) => p.roleCommand?.request.id ?? []))
      const result = await fn(u)
      queued = Object.values(u.state.persons).flatMap((p) =>
        p.roleCommand && !known.has(p.roleCommand.request.id) ? [{ personId: p.id, strict: p.roleCommand.strict }] : []
      )
      return result
    })
    for (const command of queued) {
      const error = await deliverRoleCommand(command.personId)
      if (error && command.strict)
        fail(
          error.status === 403 ? "FORBIDDEN" : error.status === 404 ? "NOT_FOUND" : "PRECONDITION_FAILED",
          error.message
        )
    }
    return result
  }
  type SourceRead<T> = { value: T; at: number; revision: number }
  let directoryRead: SourceRead<RoleDirectory> | null = null
  /** When an unknown account last made People read Auth again, so unknown callers can't make it read on every call. */
  let unknownAccountReadAt = 0
  let membersRead: SourceRead<AzureMember[]> | null = null
  /** Who holds the roles bound to People, from PoliNetwork Auth; null when People has no Auth to ask. */
  async function readDirectory(force = false): Promise<SourceRead<RoleDirectory> | null> {
    if (!options.peopleRoles) return null
    const at = now().getTime()
    if (!force && directoryRead && at - directoryRead.at < SOURCE_TTL_MS.directory) return directoryRead
    // A role command confirmed while Auth answers would make this answer older than the register's history.
    const revision = await commit((u) => u.state.counters.roleRevision ?? 0)
    try {
      directoryRead = { value: await options.peopleRoles.directory(), at, revision }
    } catch (error) {
      if (!directoryRead || at - directoryRead.at > DIRECTORY_MAX_AGE_MS)
        fail("PRECONDITION_FAILED", "PoliNetwork Auth can't be reached: People can't tell who holds which role")
      console.error(error)
    }
    return directoryRead
  }
  /** Login accounts and the identity each proved, from the same PoliNetwork Auth answer as the roles. */
  async function readAccounts(force = false): Promise<Account[]> {
    if (!options.peopleRoles) return (await options.directory?.()) ?? []
    const read = await readDirectory(force)
    return read ? accountsOf(read.value) : []
  }
  /** The signed-in account; Auth is read again for one it doesn't know yet, so a first sign-in is not missed. */
  async function readAccount(sub: string): Promise<Account | undefined> {
    const known = (await readAccounts()).find((a) => a.sub === sub)
    if (known || now().getTime() - unknownAccountReadAt < UNKNOWN_ACCOUNT_REREAD_MS) return known
    unknownAccountReadAt = now().getTime()
    return (await readAccounts(true)).find((a) => a.sub === sub)
  }
  /** The Microsoft 365 Soci group; null without Microsoft 365, or while it has never answered. */
  async function readMembers(force = false): Promise<SourceRead<AzureMember[]> | null> {
    if (!options.azureMembers) return null
    const at = now().getTime()
    if (!force && membersRead && at - membersRead.at < SOURCE_TTL_MS.members) return membersRead
    try {
      membersRead = { value: await options.azureMembers(), at, revision: 0 }
    } catch (error) {
      console.error(error)
    }
    return membersRead
  }
  /** Lays the sources over the register: their answer wins, and the register keeps only history and its own data. */
  function applySources(
    s: PeopleState,
    directory: SourceRead<RoleDirectory> | null,
    members: SourceRead<AzureMember[]> | null
  ) {
    const at = { date: date(), now: now() }
    if (directory) {
      if (directory.revision === (s.counters.roleRevision ?? 0)) {
        syncDirectory(s, directory.value, at)
        // Stored with the register, so a transaction that fails doesn't skip the next pass.
        if (s.counters.preliminaryReconciledAt !== directory.at) {
          reconcilePreliminary(s, accountsOf(directory.value), at.date)
          s.counters.preliminaryReconciledAt = directory.at
        }
      } else directoryRead = null
    }
    if (members) syncMembers(s, members.value, at)
  }
  /** A People transaction that first lays PoliNetwork Auth and Microsoft 365 over the register. */
  const tx = async <T>(fn: (u: UnitOfWork) => Promise<T> | T): Promise<T> => {
    const [directory, members] = await Promise.all([readDirectory(), readMembers()])
    return commit((u) => {
      applySources(u.state, directory, members)
      return fn(u)
    })
  }
  const currentFee = (p: Person) => fee(p, config, date()) ?? fail("CONFLICT", "This person is not a current member")
  const roleViews = (s: PeopleState) =>
    new Map<string, RoleSnapshot>(
      Object.values(s.persons).map((p) => [p.id, structuredClone({ admin: p.admin, teams: p.teams })])
    )
  /** Lets a sync tell whether a role changed while it read PoliNetwork Auth. */
  const bumpRoles = (s: PeopleState) => {
    s.counters.roleRevision = (s.counters.roleRevision ?? 0) + 1
  }
  const settled = (p: Person) => {
    if (p.roleCommand) fail("CONFLICT", PENDING_ROLES)
  }

  /**
   * Turns the roles just changed on linked records into one command each for PoliNetwork Auth, acting as `actor`, who
   * must be allowed to there too. Until Auth confirms it, the record keeps the roles it had (`before`): a requested
   * role grants nothing. `strict` (a direct dashboard action) fails the call on a refusal; otherwise (census, import,
   * linking) the refusal is noted on the record for HR.
   */
  function pushRoles(
    s: PeopleState,
    before: Map<string, RoleSnapshot>,
    actor: string,
    reason: string,
    strict: boolean
  ) {
    if (!options.peopleRoles) return
    for (const p of Object.values(s.persons)) {
      const was = before.get(p.id)
      if (!was || !p.accountSub || (p.account.status !== "linked" && !p.authProvisional)) continue
      const changes = roleChanges(roleView(was), roleView(p))
      if (!changes.length) continue
      settled(p)
      p.roleCommand = {
        // PoliNetwork Auth keeps reasons of up to 500 characters.
        request: { id: randomUUID(), actor, sub: p.accountSub, reason: reason.slice(0, 500), changes },
        desired: structuredClone({ admin: p.admin, teams: p.teams }),
        strict,
      }
      for (const change of changes)
        if (change.kind === "admin") p.admin = structuredClone(was.admin)
        else
          p.teams = [
            ...p.teams.filter((t) => t.team !== change.team),
            ...structuredClone(was.teams.filter((t) => t.team === change.team)),
          ]
      log(p, actor, `Asked PoliNetwork Auth to change roles: ${reason}`, now())
      bumpRoles(s)
    }
  }

  /**
   * Sends a person's pending role command and applies Auth's answer. A refusal drops it; no answer (Auth unreachable,
   * failing, or the response lost) keeps it for the sweep to send again with the same ID, which Auth applies once.
   */
  async function deliverRoleCommand(personId: string): Promise<RoleChangeError | null> {
    const pending = await commit((u) => structuredClone(u.state.persons[personId]?.roleCommand))
    if (!pending || !options.peopleRoles) return null
    const { request } = pending
    let result: RoleResult
    try {
      result = await options.peopleRoles.change(request)
    } catch (error) {
      if (!(error instanceof RoleChangeError)) console.error(error)
      const failure = error instanceof RoleChangeError ? error : new RoleChangeError(503, "No answer")
      const unanswered = failure.status >= 500 || failure.status === 408 || failure.status === 429
      await commit((u) => {
        const p = u.state.persons[personId]
        if (p?.roleCommand?.request.id !== request.id) return
        if (unanswered) {
          if (!pending.unanswered)
            log(
              p,
              request.actor,
              `PoliNetwork Auth didn't answer (${failure.message}); the change will be retried`,
              now()
            )
          p.roleCommand.unanswered = true
          return
        }
        delete p.roleCommand
        for (const t of p.teams) if (t.endReason === AWAITING_AUTH) t.endReason = "Not confirmed by PoliNetwork Auth"
        if (p.admin?.endReason === AWAITING_AUTH) p.admin.endReason = "Not confirmed by PoliNetwork Auth"
        log(p, request.actor, `PoliNetwork Auth refused the role change: ${failure.message}`, now())
        if (!pending.strict)
          flagForReview(
            p,
            `PoliNetwork Auth refused a role change (${request.reason}): ${failure.message} Its roles stay as Auth holds them: change them again from People or in Auth.`
          )
        bumpRoles(u.state)
      })
      return new RoleChangeError(
        failure.status,
        unanswered
          ? "PoliNetwork Auth didn't answer. The change is saved and will be retried automatically: don't repeat it."
          : `PoliNetwork Auth: ${failure.message}`
      )
    }
    await commit((u) => {
      const p = u.state.persons[personId]
      if (p?.roleCommand?.request.id !== request.id) return
      for (const change of request.changes)
        if (change.kind === "admin") p.admin = pending.desired.admin
        else
          p.teams = [
            ...p.teams.filter((t) => t.team !== change.team),
            ...pending.desired.teams.filter((t) => t.team === change.team),
          ]
      delete p.roleCommand
      log(p, request.actor, `PoliNetwork Auth confirmed the role change: ${request.reason}`, now())
      // What Auth holds after the command wins, for example a role it kept through a parent role.
      const bound = boundRoles({ roles: result.roles, users: [] })
      syncPersonRoles(p, bound, wantedView(bound, result.held), { date: date(), now: now() })
      bumpRoles(u.state)
    })
    directoryRead = null
    return null
  }
  function assertReceiptConfig(s: PeopleState) {
    if (!config.legalName || !config.address || !config.taxCode)
      fail("PRECONDITION_FAILED", "Configure receipt legal details before recording a paid fee")
    for (const id of Object.values(config.officers))
      if (!id || !s.persons[id]?.accountSub || s.persons[id].account.status !== "linked")
        fail(
          "PRECONDITION_FAILED",
          "Configure confirmed President and Vice-president records before recording a paid fee"
        )
  }
  const activeCampaign = (s: PeopleState) => {
    const y = year()
    s.campaigns[y] ??= {
      id: y,
      year: y,
      status: "open",
      openedOn: `${y.slice(0, 4)}-09-01`,
      closesOn: `${y.slice(0, 4)}-10-31`,
      source: "Forms / Dashboard",
      expected: 0,
      continuing: 0,
      leaving: 0,
      noAnswer: 0,
    }
    const c = s.campaigns[y]
    for (const p of Object.values(s.persons)) {
      if ((p.admin?.status === "active" || p.teams.some((t) => !t.endedOn)) && !p.census.some((e) => e.year === y))
        p.census.unshift({ year: y, answer: null, answeredOn: null, source: null, declaredMember: null, reminders: 0 })
    }
    return c
  }
  const campaign = (s: PeopleState, id: string) => s.campaigns[id] ?? fail("NOT_FOUND", "Campaign not found")
  const campaignView = (s: PeopleState, id: string): C.Campaign => {
    const c = campaign(s, id)
    const entries = Object.values(s.persons).flatMap((p) => p.census.filter((e) => e.year === c.year))
    return {
      ...c,
      expected: entries.length,
      continuing: entries.filter((e) => e.answer === "continues").length,
      leaving: entries.filter((e) => e.answer === "leaving").length,
      noAnswer: entries.filter((e) => !e.answer).length,
    }
  }
  function endRoles(p: Person, reason: string, actor: string, lastDay = date()) {
    if (p.admin?.status === "active")
      Object.assign(p.admin, { status: "former", endedOn: lastDay, endReason: reason, capoScope: null })
    for (const t of p.teams) if (!t.endedOn) Object.assign(t, { endedOn: lastDay, endReason: reason })
    log(p, actor, `Ended volunteer roles: ${reason}`, now())
  }
  async function issue(
    u: UnitOfWork,
    p: Person,
    payment: NonNullable<C.FeeDetail["payment"]>,
    actor: string,
    note: string
  ) {
    assertReceiptConfig(u.state)
    const f = currentFee(p)
    if (
      f.status === "paid" ||
      Object.values(u.state.receipts).some((r) => r.person.id === p.id && r.year === f.year && r.status !== "voided")
    )
      fail("CONFLICT", "This fee already has a receipt")
    if (payment.paidOn > date()) fail("BAD_REQUEST", "Payment date is in the future")
    const seq = (u.state.counters[`receipt:${f.year}`] ?? 0) + 1
    u.state.counters[`receipt:${f.year}`] = seq
    const id = randomUUID()
    const signer = p.id === config.officers.president ? "vicePresident" : "president"
    const officerId = config.officers[signer]
    const officer = officerId ? u.state.persons[officerId] : null
    if (!officer?.accountSub || officer.account.status !== "linked")
      fail("PRECONDITION_FAILED", "Configure a confirmed President and Vice-president before issuing receipts")
    const receipt: StoredReceipt = {
      id,
      number: `${f.year.slice(0, 4)}/${String(seq).padStart(3, "0")}`,
      year: f.year,
      person: ref(p),
      memberNumber: p.member?.number ?? "",
      amountCents: payment.amountCents,
      issuedOn: date(),
      paidOn: payment.paidOn,
      method: payment.method,
      transferDate: payment.transferDate,
      status: "toSign",
      signer,
      officerPersonId: officer.id,
      signedBy: null,
      signedOn: null,
      sentAt: null,
      sentTo: null,
      failure: null,
      voided: null,
      originalFileId: `original:${id}`,
      signedFileId: null,
      sha256: "",
      requestId: null,
      recipient: p.member?.m365Email ?? "",
    }
    if (!receipt.recipient) fail("PRECONDITION_FAILED", "The member has no Microsoft 365 email")
    const bytes = await receiptPdf(receipt, config, nameOf(officer))
    receipt.sha256 = hash(bytes)
    await u.putFile({
      id: receipt.originalFileId,
      fileName: `Ricevuta_${receipt.number.replace("/", "-")}.pdf`,
      contentType: "application/pdf",
      content: bytes,
      expiresAt: null,
    })
    u.state.receipts[id] = receipt
    f.status = "paid"
    f.payment = payment
    f.rejection = null
    f.upload = null
    if (f.fileId) await u.deleteFile(f.fileId)
    f.fileId = null
    if (p.member) p.member.fee = "paid"
    log(p, actor, `Recorded payment for ${f.year}${note ? `: ${note}` : ""}`, now())
    log(p, actor, `Issued receipt ${receipt.number}`, now())
    return { receipt: receipt.number }
  }
  /** The one way a record gets an account: Auth links a preliminary person, People links any other record. */
  async function linkRecord(s: PeopleState, p: Person, account: Account, actor: string, reason: string) {
    if (await linkPreliminaryPerson(s, p, account, actor, reason)) return
    if (attachAccount(s, p, account, actor, reason, { date: date(), now: now() }))
      pushRoles(s, new Map([[p.id, unconfirmed(p, date())]]), actor, `Linked in People: ${reason}`, false)
  }
  async function linkPreliminaryPerson(s: PeopleState, p: Person, account: Account, actor: string, reason: string) {
    if (!p.authProvisional || !p.authRegistrationId) return false
    settled(p)
    if (Object.values(s.persons).some((other) => other.id !== p.id && other.accountSub === account.sub))
      fail("CONFLICT", "This account already has a People record; review the duplicate before linking")
    if (!options.peopleRoles?.link) fail("PRECONDITION_FAILED", "Auth identity linking is unavailable")
    const result = await options.peopleRoles.link({
      operation: "link-person",
      id: randomUUID(),
      actor,
      personId: p.authRegistrationId,
      userId: account.sub,
      reason,
    })
    if (result.sub !== account.sub) fail("PRECONDITION_FAILED", "Auth returned another account for this link")
    p.accountSub = result.sub
    p.authProvisional = false
    p.account = {
      status: "linked",
      email: account.email ?? "",
      via: "PoliNetwork Auth",
      linkedOn: date(),
      how: "Master Admin approved the preliminary identity",
    }
    directoryRead = null
    log(p, actor, `Auth approved the preliminary identity link: ${reason}`, now())
    return true
  }
  const roleNames = (p: Person) => [
    ...(p.admin?.status === "active" ? ["Admin"] : []),
    ...p.teams.filter((t) => !t.endedOn).map((t) => C.TEAMS[t.team].name),
  ]
  const receiptForOfficer = (s: PeopleState, v: Viewer, id: string, cie: boolean) => {
    requireGeneral(v, "people:receipts:sign")
    const r = findReceipt(s, id)
    if (
      r.status !== "toSign" ||
      office(s, v, config) !== r.signer ||
      config.officers[r.signer] !== r.officerPersonId ||
      (cie && !v.can("esign:sign"))
    )
      fail("FORBIDDEN", "This receipt is not waiting for your signature")
    return r
  }
  const addCensusAnswer = (
    p: Person,
    y: string,
    entry: C.CensusEntry,
    answers: { question: string; answer: string }[],
    actor: string
  ) => {
    p.census = [entry, ...p.census.filter((e) => e.year !== y)]
    p.answers[y] = answers
    if (entry.answer === "leaving") endRoles(p, `Census ${y}: leaving`, actor)
    log(p, actor, `Answered census ${y}: ${entry.answer}`, now())
  }

  return {
    async listPeople(v: Viewer) {
      requireGeneral(v, "people:read")
      return tx((u) => {
        activeCampaign(u.state)
        return Object.values(u.state.persons).map((p) => row(u.state, p, v, config, date()))
      })
    },
    async getPerson(v: Viewer, input: { id: string }) {
      requireGeneral(v, "people:read")
      return tx((u) => {
        return record(u.state, find(u.state, input.id), v, config, date())
      })
    },
    async createPerson(v: Viewer, raw: C.CreatePersonInput) {
      requireGeneral(v, "people:write")
      const input = C.createPersonInputSchema.parse(raw)
      if (options.peopleRoles?.create) {
        const created = await options.peopleRoles.create({
          operation: "create-person",
          id: input.requestId ?? randomUUID(),
          actor: v.sub,
          firstName: input.firstName,
          lastName: input.lastName,
          email: input.personalEmail,
          phone: input.phone,
          telegramId: input.telegramId,
          telegramUsername: input.telegramUsername,
          changes: [
            ...(input.admin ? [{ kind: "admin" as const, active: true }] : []),
            ...input.teams.map((team) => ({ kind: "team" as const, team, role: "member" as const })),
          ],
        })
        directoryRead = null
        return tx((u) => {
          const person = Object.values(u.state.persons).find((p) => p.accountSub === created.sub)
          if (!person) fail("PRECONDITION_FAILED", "Auth saved the person; refresh People before retrying")
          return { id: person.id }
        })
      }
      if (!options.allowLocalPeople)
        fail("PRECONDITION_FAILED", "Auth person creation is unavailable; no local person was created")
      return tx((u) => {
        const p = newPerson(u.state, input, date())
        log(p, v.sub, "Created person", now())
        activeCampaign(u.state)
        return { id: p.id }
      })
    },
    async updatePerson(v: Viewer, input: C.UpdatePersonInput) {
      requireGeneral(v, "people:write")
      return tx(async (u) => {
        const p = find(u.state, input.id)
        if (p.authRegistrationId) {
          if (!options.peopleRoles?.update) fail("PRECONDITION_FAILED", "Auth contact editing is unavailable")
          await options.peopleRoles.update({
            operation: "update-person",
            id: randomUUID(),
            actor: v.sub,
            personId: p.authRegistrationId,
            firstName: input.firstName,
            lastName: input.lastName,
            email: input.personalEmail,
            phone: input.phone,
            telegramId: p.profile.telegramId ?? "",
            telegramUsername: input.telegramUsername,
          })
          directoryRead = null
        }
        const { id: _, ...profile } = input
        Object.assign(p.profile, profile)
        log(p, v.sub, "Updated profile", now())
      })
    },
    async setNote(v: Viewer, input: C.SetNoteInput) {
      requireGeneral(v, "people:write")
      return tx((u) => {
        const p = find(u.state, input.id)
        p.notes = input.note || null
        log(p, v.sub, "Updated HR note", now())
      })
    },
    async listMembers(v: Viewer) {
      requireGeneral(v, "people:members:read")
      return tx((u) =>
        Object.values(u.state.persons).map((p) => {
          fee(p, config, date())
          return C.memberRegisterRowSchema.parse({
            ...p,
            profile: { ...p.profile, personalEmail: general(v, "people:read") ? p.profile.personalEmail : null },
          })
        })
      )
    },
    async createMember(v: Viewer, input: C.CreateMemberInput) {
      requireGeneral(v, "people:members:write")
      return tx(async (u) => {
        const p = find(u.state, input.personId)
        if (p.member) fail("CONFLICT", "This person already has a membership; update its status instead")
        if (Object.values(u.state.persons).some((other) => other.member?.number === input.number))
          fail("CONFLICT", "Member number already used")
        if (input.admittedOn > date()) fail("BAD_REQUEST", "Admission date is in the future")
        // Issuing a receipt is a payment operation; membership write alone cannot authorize it.
        if (input.fee === "paid") {
          requireGeneral(v, "people:fees:write")
          assertReceiptConfig(u.state)
        }
        const azure = await options.provisionMember(p, input.number)
        // Microsoft 365 now lists the new member: read the Soci group again.
        membersRead = null
        p.azureId = azure.id
        p.member = {
          number: input.number,
          status: "active",
          admittedOn: input.admittedOn,
          fee: "due",
          m365Email: azure.email,
        }
        currentFee(p)
        log(p, v.sub, `Admitted member ${input.number}`, now())
        if (input.fee === "paid")
          await issue(
            u,
            p,
            { paidOn: input.admittedOn, method: "cash", amountCents: config.feeCents, transferDate: null },
            v.sub,
            "Paid on admission"
          )
      })
    },
    async setMemberStatus(v: Viewer, input: C.MemberStatusInput) {
      requireGeneral(v, "people:members:write")
      return tx((u) => {
        const p = find(u.state, input.personId)
        if (!p.member) fail("CONFLICT", "Not a member")
        if (input.status !== "active" && !input.reason) fail("BAD_REQUEST", "A reason is required")
        p.member.status = input.status
        if (input.status === "former") p.member.fee = null
        else currentFee(p)
        log(p, v.sub, `Membership ${input.status}: ${input.reason}`, now())
      })
    },
    async setMemberNumber(v: Viewer, input: C.MemberNumberInput) {
      requireGeneral(v, "people:members:write")
      return tx(async (u) => {
        const p = find(u.state, input.personId)
        if (!p.member) fail("CONFLICT", "Not a member")
        if (Object.values(u.state.persons).some((o) => o.id !== p.id && o.member?.number === input.number))
          fail("CONFLICT", "Member number already used")
        await options.setMemberNumber(p, input.number)
        membersRead = null
        p.member.number = input.number
        log(p, v.sub, `Changed member number to ${input.number}`, now())
      })
    },
    async exportMembers(v: Viewer) {
      requireGeneral(v, "people:members:write")
      return tx((u) => ({
        filename: `members-${date()}.csv`,
        csv: [
          ["Number", "Name", "Status", "Admitted on", "Microsoft 365 email"],
          ...Object.values(u.state.persons)
            .filter((p) => p.member)
            .map((p) => [
              p.member?.number ?? "",
              nameOf(p),
              p.member?.status ?? "",
              p.member?.admittedOn ?? "",
              p.member?.m365Email ?? "",
            ]),
        ]
          .map((r) => r.map(csvCell).join(","))
          .join("\r\n"),
      }))
    },
    async endAdmin(v: Viewer, input: C.EndAdminInput) {
      requireGeneral(v, "people:write")
      return tx(async (u) => {
        const before = roleViews(u.state)
        const p = find(u.state, input.personId)
        if (p.admin?.status !== "active") fail("CONFLICT", "Not an active admin")
        if (p.admin.capoScope) requireGeneral(v, "people:appoint")
        Object.assign(p.admin, { status: "former", endedOn: date(), endReason: input.reason, capoScope: null })
        log(p, v.sub, `Ended admin role: ${input.reason}`, now())
        pushRoles(u.state, before, v.sub, input.reason, true)
      })
    },
    async setCapoScope(v: Viewer, input: C.CapoScopeInput) {
      requireGeneral(v, "people:appoint")
      return tx((u) => {
        const p = find(u.state, input.personId)
        settled(p)
        if (p.admin?.status !== "active") fail("CONFLICT", "Not an active admin")
        p.admin.capoScope = input.scope || null
        log(p, v.sub, `Set Capo Admin scope: ${input.scope ?? "none"}`, now())
      })
    },
    async setCapoOfReference(v: Viewer, input: C.CapoRefInput) {
      requireGeneral(v, "people:write")
      return tx((u) => {
        const p = find(u.state, input.personId)
        settled(p)
        if (p.admin?.status !== "active") fail("CONFLICT", "Not an active admin")
        const capo = input.capoId ? find(u.state, input.capoId) : null
        if (capo && (capo.id === p.id || capo.admin?.status !== "active" || !capo.admin.capoScope))
          fail("BAD_REQUEST", "Choose an active Capo Admin")
        p.admin.capoOfReference = capo ? ref(capo) : null
        log(p, v.sub, "Changed Capo Admin of reference", now())
      })
    },
    async listTeams(v: Viewer) {
      return tx((u) => {
        const allowed = general(v, "people:read") ? [...C.TEAM_IDS] : v.can("people:self") ? leads(own(u.state, v)) : []
        if (!allowed.length) fail("FORBIDDEN", "No readable teams")
        return allowed.map((id) => {
          const full = general(v, "people:read")
          const people = Object.values(u.state.persons).filter((p) =>
            p.teams.some((t) => t.team === id && (full || !t.endedOn))
          )
          const lead = people.find((p) => leads(p, id).length)
          return {
            id,
            name: C.TEAMS[id].name,
            lead: lead ? ref(lead) : null,
            members: people.map((p) => {
              const result = row(u.state, p, v, config, date(), true)
              if (!general(v, "people:read")) result.teams = result.teams.filter((t) => t.team === id)
              return result
            }),
          }
        })
      })
    },
    async listTeamCandidates(v: Viewer, input: C.TeamCandidatesInput) {
      return tx((u) => {
        teamAccess(u.state, v, input.teamId, false)
        return Object.values(u.state.persons)
          .filter((p) => !p.teams.some((m) => m.team === input.teamId && !m.endedOn))
          .map((p) => ({ ...ref(p), course: p.profile.course }))
      })
    },
    async addTeamMember(v: Viewer, input: C.AddTeamMemberInput) {
      return tx(async (u) => {
        const before = roleViews(u.state)
        teamAccess(u.state, v, input.teamId, true)
        if (input.role === "lead") requireGeneral(v, "people:appoint")
        validateFields(input.teamId, input.fields)
        const p = find(u.state, input.personId)
        if (p.teams.some((t) => t.team === input.teamId && !t.endedOn)) fail("CONFLICT", "Already active in this team")
        // Including a Lead appointment PoliNetwork Auth hasn't confirmed yet.
        if (
          input.role === "lead" &&
          Object.values(u.state.persons).some(
            (p) => leads(p, input.teamId).length || (p.roleCommand && leads(p.roleCommand.desired, input.teamId).length)
          )
        )
          fail("CONFLICT", "End the existing Lead appointment first")
        if (input.since > date()) fail("BAD_REQUEST", "Start date is in the future")
        p.teams.push({
          team: input.teamId,
          role: input.role,
          since: input.since,
          endedOn: null,
          endReason: null,
          fields: input.fields,
        })
        log(p, v.sub, `Joined ${input.teamId} as ${input.role}`, now())
        pushRoles(u.state, before, v.sub, `Added to ${C.TEAMS[input.teamId].name} from People`, true)
        activeCampaign(u.state)
      })
    },
    async updateTeamFields(v: Viewer, input: C.TeamFieldsInput) {
      return tx((u) => {
        teamAccess(u.state, v, input.teamId, true)
        validateFields(input.teamId, input.fields)
        const p = find(u.state, input.personId)
        settled(p)
        const t = p.teams.find((t) => t.team === input.teamId && !t.endedOn)
        if (!t) fail("CONFLICT", "No active team membership")
        t.fields = input.fields
        log(p, v.sub, `Updated ${input.teamId} fields`, now())
      })
    },
    async endTeamMembership(v: Viewer, input: C.EndTeamInput) {
      return tx(async (u) => {
        const before = roleViews(u.state)
        teamAccess(u.state, v, input.teamId, true)
        const p = find(u.state, input.personId)
        const t = p.teams.find((t) => t.team === input.teamId && !t.endedOn)
        if (!t) fail("CONFLICT", "No active team membership")
        if (t.role === "lead") requireGeneral(v, "people:appoint")
        if (input.lastDay < t.since || input.lastDay > date()) fail("BAD_REQUEST", "Invalid last day")
        Object.assign(t, { endedOn: input.lastDay, endReason: input.reason })
        log(p, v.sub, `Ended ${input.teamId}: ${input.reason}${input.note ? `; ${input.note}` : ""}`, now())
        pushRoles(u.state, before, v.sub, input.reason, true)
      })
    },
    async listCampaigns(v: Viewer) {
      requireGeneral(v, "people:read")
      return tx((u) => {
        activeCampaign(u.state)
        return Object.keys(u.state.campaigns)
          .sort()
          .reverse()
          .map((id) => campaignView(u.state, id))
      })
    },
    async getCampaign(v: Viewer, input: { id: string }) {
      requireGeneral(v, "people:read")
      return tx((u) => {
        activeCampaign(u.state)
        const c = campaignView(u.state, input.id)
        return {
          campaign: c,
          people: Object.values(u.state.persons)
            .filter((p) => p.census.some((e) => e.year === c.year))
            .map((p) => row(u.state, p, v, config, date())),
        }
      })
    },
    async getAnswers(v: Viewer, input: C.AnswersInput) {
      requireGeneral(v, "people:read")
      return tx((u) => find(u.state, input.personId).answers[input.year] ?? [])
    },
    async closeCampaign(v: Viewer, input: { campaignId: string }) {
      requireGeneral(v, "people:write")
      return tx((u) => {
        const c = campaign(u.state, input.campaignId)
        if (c.status === "closed") fail("CONFLICT", "Campaign already closed")
        c.status = "closed"
        for (const p of Object.values(u.state.persons))
          if (p.census.some((e) => e.year === c.year)) log(p, v.sub, `Closed census ${c.year}`, now())
      })
    },
    async remind(v: Viewer, input: C.RemindInput) {
      requireGeneral(v, "people:write")
      const result = await tx((u) => {
        const c = campaign(u.state, input.campaignId)
        if (c.status !== "open") fail("CONFLICT", "Campaign is closed")
        const ids: string[] = []
        let skipped = 0
        for (const p of Object.values(u.state.persons).filter((p) => !input.personId || p.id === input.personId)) {
          const entry = p.census.find((e) => e.year === c.year)
          const last = p.reminders[c.id]
          if (
            !entry ||
            entry.answer ||
            !p.profile.personalEmail ||
            (last && now().getTime() - Date.parse(last) < 3 * 86400000)
          ) {
            skipped++
            continue
          }
          const id = `census:${c.id}:${p.id}:${date()}`
          queue(
            u.state,
            p,
            id,
            p.profile.personalEmail,
            `Censimento PoliNetwork ${c.year}`,
            `è aperto il censimento ${c.year} di PoliNetwork: ogni anno chiediamo a chi fa parte dell'associazione se continua e di aggiornare corso, anno e sede. Ci vogliono un paio di minuti.\n\nPuoi rispondere dalla tua area personale. Chiusura del censimento: ${longDate(c.closesOn)}.`,
            { label: "Rispondi al censimento", url: AREA }
          )
          p.reminders[c.id] = now().toISOString()
          entry.reminders++
          ids.push(id)
          log(p, v.sub, `Queued census ${c.year} reminder`, now())
        }
        return { ids, skipped }
      })
      await this.deliverPending(result.ids)
      return tx((u) => {
        const sent = result.ids.filter((id) => u.state.outbox[id].status === "sent").length
        return { sent, skipped: result.skipped + result.ids.length - sent }
      })
    },

    async importPreview(v: Viewer, input: { campaignId: string; file: File }) {
      requireGeneral(v, "people:write")
      const parsed = await parseImport(input.file)
      const telegramUsers = await options.telegramUsers()
      return tx((u) => {
        const c = campaign(u.state, input.campaignId)
        if (c.status !== "open") fail("CONFLICT", "Campaign is closed")
        const preview: C.ImportPreview = {
          importId: randomUUID(),
          fileName: input.file.name,
          rows: parsed.length,
          counts: {
            newPeople: 0,
            updates: 0,
            duplicates: 0,
            invalid: 0,
            discrepancies: 0,
            alreadyImported: 0,
            leaving: 0,
          },
          tabs: { newPeople: [], updates: [], duplicates: [], invalid: [], discrepancies: [], alreadyImported: [] },
          duplicates: [],
          telegram: [],
        }
        const rows: ImportRow[] = []
        const seen = new Set<string>()
        const seenEmails = new Set<string>()
        for (const source of parsed) {
          const fp = `${c.year}:${source.fingerprint}`
          const display = {
            row: source.row,
            name: source.profile ? `${source.profile.firstName} ${source.profile.lastName}` : `Row ${source.row}`,
            detail: source.error ?? "",
            answer: source.answer,
          }
          if (u.state.fingerprints[fp] || seen.has(fp)) {
            preview.tabs.alreadyImported.push(display)
            continue
          }
          seen.add(fp)
          if (source.error || !source.profile || !source.answer || !source.volunteer) {
            preview.tabs.invalid.push(display)
            continue
          }
          const inputProfile = source.profile
          const emailKey = inputProfile.personalEmail.toLowerCase()
          if (seenEmails.has(emailKey)) {
            preview.tabs.invalid.push({ ...display, detail: "Another response in this file uses the same email" })
            continue
          }
          seenEmails.add(emailKey)
          const emailMatches = Object.values(u.state.persons).filter(
            (p) => p.profile.personalEmail?.toLowerCase() === inputProfile.personalEmail.toLowerCase()
          )
          const exact = emailMatches.length === 1 ? emailMatches[0] : null
          const possible =
            exact ?? Object.values(u.state.persons).find((p) => nameOf(p).toLowerCase() === display.name.toLowerCase())
          const duplicateId = !exact && possible ? `pair-${source.row}` : null
          const suggestion = telegramUsers.find(
            (t) => t.username?.toLowerCase() === inputProfile.telegramUsername.toLowerCase()
          )
          const entry: C.CensusEntry = {
            year: c.year,
            answer: source.answer,
            answeredOn: source.answeredOn ?? date(),
            source: "forms",
            declaredMember: source.declaredMember,
            reminders: 0,
          }
          rows.push({
            volunteer: source.volunteer,
            row: source.row,
            fingerprint: fp,
            profile: {
              ...inputProfile,
              phone: inputProfile.phone || null,
              telegramUsername: inputProfile.telegramUsername || null,
              telegramId: null,
              otherAssociations: [],
              studentRepresentative: null,
            },
            entry,
            answers: source.answers,
            personId: possible?.id ?? null,
            duplicateId,
            telegramSuggestion: suggestion?.id ?? null,
          })
          const tab = duplicateId ? "duplicates" : exact ? "updates" : "newPeople"
          preview.tabs[tab].push({ ...display, detail: possible ? possible.id : "New person" })
          if (duplicateId && possible)
            preview.duplicates.push({
              pairId: duplicateId,
              row: source.row,
              recordId: possible.id,
              fields: ["firstName", "lastName", "personalEmail", "course", "year"].map((key) => ({
                label: key,
                file: String(inputProfile[key as keyof typeof inputProfile]),
                record: String(possible.profile[key as keyof typeof possible.profile]),
                mono: key === "personalEmail",
              })),
            })
          if (inputProfile.telegramUsername)
            preview.telegram.push({
              rowId: String(source.row),
              name: display.name,
              username: inputProfile.telegramUsername,
              suggestion: suggestion
                ? {
                    telegramId: suggestion.id,
                    name: suggestion.name,
                    info: "Matching bot username; confirmation required",
                  }
                : null,
            })
          if (source.declaredMember && !possible?.member)
            preview.tabs.discrepancies.push({ ...display, detail: "Declared member but absent from register" })
          if (source.answer === "leaving") preview.counts.leaving++
        }
        for (const key of C.IMPORT_TABS) preview.counts[key] = preview.tabs[key].length
        u.state.imports[preview.importId] = {
          id: preview.importId,
          owner: v.sub,
          campaignId: c.id,
          expiresAt: new Date(now().getTime() + 86400000).toISOString(),
          committed: false,
          rows,
          preview,
        }
        return preview
      })
    },
    async importCommit(v: Viewer, input: C.ImportCommitInput) {
      requireGeneral(v, "people:write")
      return tx(async (u) => {
        const before = roleViews(u.state)
        const batch = u.state.imports[input.importId]
        if (!batch || batch.owner !== v.sub || batch.expiresAt < now().toISOString())
          fail("NOT_FOUND", "Import preview expired")
        if (batch.committed) return { imported: 0 }
        const c = campaign(u.state, batch.campaignId)
        if (c.status !== "open") fail("CONFLICT", "Campaign is closed")
        const pairs = new Set(batch.rows.flatMap((r) => (r.duplicateId ? [r.duplicateId] : [])))
        const telegramRows = new Set(batch.preview.telegram.map((r) => r.rowId))
        if (
          Object.keys(input.duplicates).some((id) => !pairs.has(id)) ||
          [...pairs].some((id) => !input.duplicates[id]) ||
          Object.keys(input.telegram).some((id) => !telegramRows.has(id))
        )
          fail("BAD_REQUEST", "Import decisions do not match this preview")
        let imported = 0
        for (const r of batch.rows) {
          if (u.state.fingerprints[r.fingerprint]) continue
          let p =
            r.personId && (!r.duplicateId || input.duplicates[r.duplicateId] === "same")
              ? find(u.state, r.personId)
              : null
          if (!p)
            p = newPerson(
              u.state,
              {
                ...r.profile,
                personalEmail: r.profile.personalEmail ?? "",
                phone: r.profile.phone ?? "",
                telegramUsername: r.profile.telegramUsername ?? "",
                telegramId: r.profile.telegramId ?? "",
                year: C.personInputSchema.shape.year.parse(r.profile.year),
                campus: C.campusSchema.parse(r.profile.campus),
                admin: false,
              },
              date()
            )
          // A Forms import never changes account links or membership; only reviewed volunteer/profile data.
          const selected = input.telegram[String(r.row)]
          if (selected && selected !== r.telegramSuggestion)
            fail("BAD_REQUEST", "Confirm only the Telegram suggestion in this preview")
          if (
            selected &&
            Object.values(u.state.persons).some((other) => other.id !== p.id && other.profile.telegramId === selected)
          )
            fail("CONFLICT", "Telegram identity already belongs to another person")
          if (p.census.some((e) => e.year === c.year && e.answer))
            fail("CONFLICT", "A census answer changed after the preview; import again")
          Object.assign(p.profile, {
            firstName: r.profile.firstName,
            lastName: r.profile.lastName,
            personalEmail: r.profile.personalEmail,
            phone: r.profile.phone,
            course: r.profile.course,
            year: r.profile.year,
            campus: r.profile.campus,
            telegramUsername: r.profile.telegramUsername,
            telegramId: selected || p.profile.telegramId,
          })
          if (r.volunteer.otherAssociations) p.profile.otherAssociations = r.volunteer.otherAssociations
          if (r.volunteer.studentRepresentative !== undefined)
            p.profile.studentRepresentative = r.volunteer.studentRepresentative || null
          if (r.entry.answer === "continues") {
            if (r.volunteer.admin && p.admin?.status !== "active")
              p.admin = {
                status: "active",
                since: r.entry.answeredOn ?? date(),
                endedOn: null,
                endReason: null,
                availableAsCapo: false,
                capoOfReference: null,
                capoScope: null,
              }
            if (p.admin) p.admin.availableAsCapo = r.volunteer.availableAsCapo
            for (const team of r.volunteer.teams)
              if (!p.teams.some((t) => t.team === team && !t.endedOn))
                p.teams.push({
                  team,
                  role: "member",
                  since: r.entry.answeredOn ?? date(),
                  endedOn: null,
                  endReason: null,
                  fields: {},
                })
          }
          if (
            r.volunteer.privacyVersion &&
            r.volunteer.privacyAcceptedOn &&
            (!p.consents.privacy || p.consents.privacy.acceptedOn < r.volunteer.privacyAcceptedOn)
          )
            p.consents.privacy = { version: r.volunteer.privacyVersion, acceptedOn: r.volunteer.privacyAcceptedOn }
          if (
            r.volunteer.photoConsent &&
            r.entry.answeredOn &&
            (!p.consents.photo || p.consents.photo.on < r.entry.answeredOn)
          )
            p.consents.photo = { status: r.volunteer.photoConsent, on: r.entry.answeredOn }
          addCensusAnswer(p, c.year, r.entry, r.answers, v.sub)
          if (r.entry.declaredMember && !p.member)
            p.discrepancies.push({
              kind: "declared-member",
              message: `Declared membership in census ${c.year}`,
              suggestedTelegram: null,
            })
          u.state.fingerprints[r.fingerprint] = true
          imported++
        }
        batch.committed = true
        pushRoles(u.state, before, v.sub, `Census ${c.year} import`, false)
        return { imported }
      })
    },

    async listReviews(v: Viewer) {
      requireGeneral(v, "people:read")
      return tx((u) =>
        Object.values(u.state.reviews)
          .filter((r) => !r.resolved)
          .map((r) => C.reviewSchema.parse(r))
      )
    },
    async dismissReview(v: Viewer, input: { reviewId: string }) {
      requireGeneral(v, "people:write")
      return tx((u) => {
        const r = u.state.reviews[input.reviewId]
        if (!r || r.resolved) fail("CONFLICT", "Review already handled")
        r.resolved = true
        if (r.record) {
          // A dismissed single-record match would only open again: matching skips the record for this account.
          if (r.kind === "identity-match" || r.kind === "name-only" || r.kind === "preliminary-link")
            r.rejectedPersonIds.push(r.record.id)
          const p = find(u.state, r.record.id)
          if (p.account.status === "review") p.account = { status: "none" }
          log(p, v.sub, `Dismissed review ${r.id}`, now())
        }
      })
    },
    async resolveReview(v: Viewer, input: C.ResolveReviewInput) {
      requireGeneral(v, "people:write")
      const accounts = await readAccounts()
      return tx(async (u) => {
        const r = u.state.reviews[input.reviewId]
        if (!r || r.resolved) fail("CONFLICT", "Review already handled")
        const linkChoices = ["move-telegram", "link-other", "link-first", "link-second", "link-anyway"]
        const allowed: Record<C.ReviewKind, string[]> = {
          "telegram-conflict": ["move-telegram", "ask-details", "link-other"],
          "ask-to-be-added": ["add-new", "decline"],
          "two-records": ["link-first", "link-second", "merge-first"],
          "not-me": ["link-anyway", "add-new", "decline"],
          "name-only": ["link-anyway", "add-new", "decline"],
          "preliminary-link": ["link-anyway", "decline"],
          "identity-match": ["link-anyway", "decline"],
        }
        if (!allowed[r.kind].includes(input.resolution)) fail("BAD_REQUEST", "Resolution does not apply to this review")
        const account = accounts.find((a) => a.sub === r.sub)
        if (linkChoices.includes(input.resolution)) {
          const target = ["link-other", "link-second"].includes(input.resolution) ? r.other : r.record
          if (!target || !account) fail("CONFLICT", "No confirmed account or target record")
          if (input.resolution === "move-telegram") {
            if (!account.telegramId) fail("CONFLICT", "This account has no verified Telegram identity")
            const previous = Object.values(u.state.persons).find(
              (p) => p.profile.telegramId === account.telegramId && p.id !== target.id
            )
            if (previous) {
              previous.profile.telegramId = null
              log(previous, v.sub, `Moved Telegram identity to ${target.id}: ${input.reason}`, now())
            }
            find(u.state, target.id).profile.telegramId = account.telegramId
          }
          await linkRecord(u.state, find(u.state, target.id), account, v.sub, input.reason)
        } else if (input.resolution === "add-new") {
          if (!account) fail("CONFLICT", "IdP account no longer exists")
          const parts = account.name.trim().split(/\s+/)
          const p = newPerson(
            u.state,
            {
              firstName: parts.shift() || "Unknown",
              lastName: parts.join(" ") || "Unknown",
              personalEmail: account.email ?? "",
              phone: "",
              telegramUsername: "",
              course: "To be completed by HR",
              year: "Graduated",
              campus: "External",
              admin: false,
            },
            date()
          )
          p.discrepancies.push({
            kind: "needs-review",
            message: "Created from sign-in; HR must complete the profile and assign requested roles",
            suggestedTelegram: null,
          })
          if (
            account.telegramId &&
            !Object.values(u.state.persons).some(
              (other) => other.id !== p.id && other.profile.telegramId === account.telegramId
            )
          )
            p.profile.telegramId = account.telegramId
          await linkRecord(u.state, p, account, v.sub, input.reason)
        } else if (input.resolution === "ask-details") {
          if (!account?.email || !r.record) fail("CONFLICT", "No contact address")
          queue(
            u.state,
            find(u.state, r.record.id),
            `review-details:${r.id}:${randomUUID()}`,
            account.email,
            "PoliNetwork · verifica anagrafica",
            `stiamo collegando il tuo account PoliNetwork alla tua scheda nell'associazione e prima di farlo dobbiamo verificare alcuni dati. Questo è il messaggio del team HR:\n\n${input.reason}`
          )
        } else if (input.resolution === "merge-first") {
          if (!r.record || !r.other || !account) fail("CONFLICT", "Two records and a registered account are required")
          const first = find(u.state, r.record.id)
          const second = find(u.state, r.other.id)
          if ([first.accountSub, second.accountSub].some((sub) => sub && sub !== account.sub))
            fail("CONFLICT", "Unlink the other account before merging")
          settled(first)
          settled(second)
          const before = roleViews(u.state)
          // Auth confirmed only the linked record's roles: diff the merged result against those.
          if (!first.accountSub && second.accountSub) {
            const confirmed = before.get(second.id)
            if (confirmed) before.set(first.id, confirmed)
          }
          const linked = !!first.accountSub || !!second.accountSub
          r.mergedRecord = structuredClone(second)
          mergePeople(u.state, first, second, v, config, now())
          await linkRecord(u.state, first, account, v.sub, input.reason)
          // Roles merged into an already linked record reach PoliNetwork Auth like any other change.
          if (linked) pushRoles(u.state, before, v.sub, `Merged ${second.id}: ${input.reason}`, false)
        } else if (input.resolution === "unlink" && r.record) {
          const p = find(u.state, r.record.id)
          if (p.accountSub === r.sub) {
            settled(p)
            p.accountSub = null
            p.account = { status: "none" }
            log(p, v.sub, `Unlinked account: ${input.reason}`, now())
          }
        }
        r.resolved = true
        // Matching skips this record for this account from now on, so the review doesn't open again.
        if (input.resolution === "decline" && r.record) r.rejectedPersonIds.push(r.record.id)
        if (r.record)
          log(find(u.state, r.record.id), v.sub, `Resolved ${r.kind}: ${input.resolution}; ${input.reason}`, now())
      })
    },
    async listInvites(v: Viewer) {
      requireGeneral(v, "people:read")
      return tx((u) =>
        Object.values(u.state.persons).flatMap((p) =>
          p.account.status === "invite" ? [{ personId: p.id, name: nameOf(p), ...p.account }] : []
        )
      )
    },
    async sendInvite(v: Viewer, input: { personId: string }) {
      requireGeneral(v, "people:write")
      return tx((u) => {
        const p = find(u.state, input.personId)
        if (p.accountSub || !p.profile.personalEmail)
          fail("CONFLICT", "Account already linked or personal email missing")
        const token = randomBytes(32).toString("base64url")
        p.invite = { hash: hash(token), expiresAt: new Date(now().getTime() + 14 * 86400000).toISOString() }
        p.account = {
          status: "invite",
          email: p.profile.personalEmail,
          sentOn: date(),
          expiresOn: p.invite.expiresAt.slice(0, 10),
          sentBy: v.sub,
        }
        queue(
          u.state,
          p,
          `invite:${p.id}:${p.invite.hash}`,
          p.profile.personalEmail,
          "PoliNetwork · collega il tuo account",
          `il team HR di PoliNetwork ti invita a collegare il tuo account PoliNetwork alla tua scheda nell'associazione. Una volta collegato, nella tua area personale trovi i tuoi dati, i tuoi ruoli e le quote associative.\n\nPremi il pulsante e accedi con l'account che usa questo indirizzo email (${p.profile.personalEmail}). Il collegamento avviene subito, non devi fare altro.\n\nScadenza dell'invito: ${longDate(p.invite.expiresAt.slice(0, 10))}. Se non ti aspettavi questo messaggio, ignoralo: senza il tuo accesso non succede niente.`,
          { label: "Collega il tuo account", url: `${AREA}?peopleInvite=${token}` }
        )
        log(p, v.sub, "Queued account invitation", now())
      })
    },
    async revokeInvite(v: Viewer, input: { personId: string }) {
      requireGeneral(v, "people:write")
      return tx((u) => {
        const p = find(u.state, input.personId)
        if (p.account.status !== "invite") fail("CONFLICT", "No pending invitation")
        p.invite = null
        p.account = { status: "none" }
        log(p, v.sub, "Revoked account invitation", now())
      })
    },
    async searchAccounts(v: Viewer, input: C.SearchAccountsInput) {
      requireGeneral(v, "people:write")
      const accounts = await readAccounts()
      return tx((u) => {
        const p = find(u.state, input.personId)
        const q = input.query.toLowerCase()
        return accounts
          .filter((a) => !q || `${a.name} ${a.email ?? ""} ${a.telegramId ?? ""}`.toLowerCase().includes(q))
          .slice(0, 100)
          .map((a) => {
            const linked = Object.values(u.state.persons).find((p) => p.accountSub === a.sub)
            const evidence = evidenceBetween(p, a)
            return {
              id: a.sub,
              name: a.name,
              email: a.email ?? "",
              telegram: a.telegramId,
              via: "IdP",
              linkedTo: linked ? ref(linked) : null,
              reason:
                evidence === "telegram"
                  ? ("same-telegram" as const)
                  : evidence === "email" || evidence === "microsoft-365"
                    ? ("same-email" as const)
                    : ("similar-name" as const),
            }
          })
      })
    },
    async linkAccount(v: Viewer, input: C.LinkAccountInput) {
      requireGeneral(v, "people:write")
      const account = (await readAccounts()).find((a) => a.sub === input.accountId)
      if (!account) fail("NOT_FOUND", "IdP account not found")
      return tx((u) => linkRecord(u.state, find(u.state, input.personId), account, v.sub, input.reason))
    },
    async unlinkAccount(v: Viewer, input: { personId: string }) {
      requireGeneral(v, "people:write")
      return tx((u) => {
        const p = find(u.state, input.personId)
        if (p.authRegistrationId) fail("FORBIDDEN", "Manage this identity link in Auth")
        if (!p.accountSub) fail("CONFLICT", "Account not linked")
        settled(p)
        p.accountSub = null
        p.account = { status: "none" }
        // Without an account its roles can't follow PoliNetwork Auth: People owns them from now on.
        log(p, v.sub, "Unlinked account", now())
      })
    },
    async acceptInvite(v: Viewer, input: { token: string }) {
      requireSelf(v)
      const account = await readAccount(v.sub)
      if (!account?.email) fail("FORBIDDEN", "Verified account email required")
      return tx(async (u) => {
        const p = Object.values(u.state.persons).find(
          (p) => p.invite?.hash === hash(input.token) && p.invite.expiresAt > now().toISOString()
        )
        if (!p || p.profile.personalEmail?.toLowerCase() !== account.email?.toLowerCase())
          fail("NOT_FOUND", "Invitation expired or not addressed to this account")
        await linkRecord(u.state, p, account, v.sub, "Accepted email invitation")
      })
    },

    async getMyRoles(v: Viewer) {
      requireSelf(v)
      return tx((u) => {
        const p = own(u.state, v)
        return { capoScope: p?.admin?.status === "active" ? p.admin.capoScope : null, leads: leads(p) }
      })
    },
    async getMyArea(v: Viewer): Promise<C.MyArea> {
      requireSelf(v)
      const linked = await tx((u) => !!own(u.state, v))
      const account = linked ? undefined : await readAccount(v.sub)
      return tx((u) => {
        const p = own(u.state, v)
        if (!p) {
          const view = account ? signInState(u.state, account, date()) : ({ state: "none" } as const)
          if (view.state === "match")
            return {
              state: "match",
              candidate: {
                ...ref(view.person),
                course: view.person.profile.course,
                year: view.person.profile.year,
                campus: view.person.profile.campus,
                roles: roleNames(view.person),
              },
              reason:
                view.evidence === "telegram"
                  ? "Same verified Telegram account"
                  : view.evidence === "microsoft-365"
                    ? "Same Microsoft 365 account"
                    : "Same verified email address",
            }
          if (view.state === "awaiting")
            return {
              state: "awaiting-approval",
              candidate: view.person ? { ...ref(view.person), roles: roleNames(view.person) } : null,
              reason: awaitingReason(view.review, view.person),
            }
          const asked = Object.values(u.state.reviews).find(
            (r) => r.sub === v.sub && r.kind === "ask-to-be-added" && !r.resolved
          )
          return { state: "none", request: asked ? { sentOn: asked.since } : null }
        }
        const c = activeCampaign(u.state)
        const team = p.teams.find((t) => !t.endedOn)?.team
        const contacts: Extract<C.MyArea, { state: "linked" }>["contacts"] = []
        const capoId = p.admin?.capoOfReference?.id
        const capo = capoId ? u.state.persons[capoId] : null
        if (capo)
          contacts.push({
            role: "capo",
            name: nameOf(capo),
            telegram: capo.profile.telegramUsername,
            email: null,
            team: null,
          })
        for (const other of Object.values(u.state.persons)) {
          for (const t of other.teams.filter(
            (t) => !t.endedOn && t.role === "lead" && p.teams.some((mine) => !mine.endedOn && mine.team === t.team)
          ))
            contacts.push({
              role: "lead",
              name: nameOf(other),
              telegram: other.profile.telegramUsername,
              email: other.member?.m365Email ?? null,
              team: t.team,
            })
          if (other.teams.some((t) => t.team === "hr" && !t.endedOn))
            contacts.push({
              role: "hr",
              name: nameOf(other),
              telegram: other.profile.telegramUsername,
              email: other.member?.m365Email ?? null,
              team: "hr",
            })
        }
        return {
          state: "linked",
          person: record(u.state, p, v, config, date()),
          feeInstructions:
            p.member && p.member.status !== "former" && config.iban
              ? {
                  beneficiary: config.beneficiary,
                  iban: config.iban,
                  reference: `Quota ${year()} ${p.member.number} ${nameOf(p)}`,
                }
              : null,
          campaign:
            c.status === "open" && p.census.some((e) => e.year === c.year)
              ? { id: c.id, year: c.year, closesOn: c.closesOn }
              : null,
          contacts,
          roster: team
            ? {
                team,
                members: Object.values(u.state.persons).flatMap((other) => {
                  const t = other.teams.find((t) => t.team === team && !t.endedOn)
                  return t
                    ? [
                        {
                          ...ref(other),
                          role: t.role,
                          telegram: other.profile.telegramUsername,
                          email: other.member?.m365Email ?? null,
                        },
                      ]
                    : []
                }),
              }
            : null,
        }
      })
    },
    async confirmMatch(v: Viewer) {
      requireSelf(v)
      const account = await readAccount(v.sub)
      return tx(async (u) => {
        if (own(u.state, v)) return
        const decision = account ? decideFor(u.state, account) : null
        if (!account || decision?.action !== "confirm") fail("CONFLICT", "No unique verified match to confirm")
        await linkRecord(u.state, decision.person, account, v.sub, "Confirmed verified identity match")
      })
    },
    async rejectMatch(v: Viewer) {
      requireSelf(v)
      const account = await readAccount(v.sub)
      return tx((u) => {
        const decision = account ? decideFor(u.state, account) : null
        if (!account || decision?.action !== "confirm") fail("CONFLICT", "No match to reject")
        const r = openReview(
          u.state,
          account,
          "not-me",
          decision.person,
          "The account holder rejected this match",
          date()
        )
        r.rejectedPersonIds.push(decision.person.id)
      })
    },
    async askToBeAdded(v: Viewer, input: C.AskToBeAddedInput) {
      requireSelf(v)
      const account = await readAccount(v.sub)
      if (!account) fail("PRECONDITION_FAILED", "IdP account unavailable")
      return tx((u) => {
        if (own(u.state, v)) fail("CONFLICT", "Already linked to a person")
        if (signInState(u.state, account, date()).state === "awaiting")
          fail("CONFLICT", "An admin is already checking your existing record")
        openReview(u.state, account, "ask-to-be-added", null, JSON.stringify(input), date())
      })
    },
    async answerCensus(v: Viewer, input: C.AnswerCensusInput) {
      return tx(async (u) => {
        const before = roleViews(u.state)
        const p = requireOwn(u.state, v)
        const c = activeCampaign(u.state)
        if (c.status !== "open" || c.closesOn < date()) fail("CONFLICT", "Census is closed")
        if (!p.census.some((e) => e.year === c.year)) fail("FORBIDDEN", "Not expected in this campaign")
        if (p.census.some((e) => e.year === c.year && e.answer)) fail("CONFLICT", "Census already answered")
        if (input.keepTeams.some((id) => !p.teams.some((t) => t.team === id && !t.endedOn)))
          fail("BAD_REQUEST", "You can only retain your own roles")
        if (input.answer === "leaving" && !input.reason) fail("BAD_REQUEST", "A leaving reason is required")
        Object.assign(p.profile, { course: input.course, year: input.year, campus: input.campus })
        if (input.answer === "continues") {
          for (const t of p.teams)
            if (!t.endedOn && !input.keepTeams.includes(t.team))
              Object.assign(t, { endedOn: date(), endReason: input.reason || `Census ${c.year}` })
        }
        addCensusAnswer(
          p,
          c.year,
          {
            year: c.year,
            answer: input.answer,
            answeredOn: date(),
            source: "dashboard",
            declaredMember: !!p.member && p.member.status !== "former",
            reminders: 0,
          },
          Object.entries(input).map(([question, value]) => ({
            question,
            answer: Array.isArray(value) ? value.join(", ") : value,
          })),
          v.sub
        )
        // Giving up one's own roles is always allowed in PoliNetwork Auth.
        pushRoles(u.state, before, v.sub, `Census ${c.year}: ${input.answer}`, false)
      })
    },
    async requestCorrection(v: Viewer, input: C.CorrectionInput) {
      const account = await readAccount(v.sub)
      return tx((u) => {
        const p = requireOwn(u.state, v)
        if (!account) fail("PRECONDITION_FAILED", "IdP account unavailable")
        const text = `Correction: ${input.field} → ${input.value}; ${input.note}`
        const r = openReview(u.state, account, "name-only", p, text, date())
        if (!r.message?.includes(text)) r.message = [r.message, text].filter(Boolean).join("\n")
        log(p, v.sub, `Requested correction: ${input.field}`, now())
      })
    },
    async revokePhotoConsent(v: Viewer) {
      return tx((u) => {
        const p = requireOwn(u.state, v)
        if (p.consents.photo?.status !== "granted") fail("CONFLICT", "No photo consent to revoke")
        p.consents.photo = { status: "revoked", on: date() }
        log(p, v.sub, "Revoked photo consent", now())
      })
    },
    async getCapoArea(v: Viewer): Promise<C.CapoArea> {
      requireSelf(v)
      return tx((u) => {
        const p = requireOwn(u.state, v)
        const scope = p.admin?.status === "active" ? p.admin.capoScope : null
        if (!scope) fail("FORBIDDEN", "No active Capo Admin scope")
        const scoped = Object.values(u.state.persons).filter(
          (other) => other.admin?.status === "active" && other.admin.capoOfReference?.id === p.id
        )
        return {
          scope,
          admins: scoped.map((p) => {
            const r = row(u.state, p, v, config, date(), true)
            r.profile.personalEmail = null
            return r
          }),
        }
      })
    },

    async getFeeReview(v: Viewer, input: { personId: string }) {
      requireGeneral(v, "people:fees:write")
      return tx((u) => {
        const p = find(u.state, input.personId)
        const f = currentFee(p)
        return {
          person: ref(p),
          memberNumber: p.member?.number ?? "",
          m365Email: p.member?.m365Email ?? "",
          fee: C.feeDetailSchema.parse(f),
          rejections: f.rejections,
          nextReceipt: `${f.year.slice(0, 4)}/${String((u.state.counters[`receipt:${f.year}`] ?? 0) + 1).padStart(3, "0")}`,
        }
      })
    },
    async getFeeUpload(v: Viewer, input: { personId: string }) {
      requireGeneral(v, "people:fees:write")
      return tx((u) => {
        const f = currentFee(find(u.state, input.personId))
        if (!f.fileId) fail("NOT_FOUND", "No transfer receipt uploaded")
        return filePayload(u, f.fileId)
      })
    },
    async approveFee(v: Viewer, input: { personId: string }) {
      requireGeneral(v, "people:fees:write")
      return tx(async (u) => {
        const p = find(u.state, input.personId)
        const f = currentFee(p)
        if (f.status !== "receipt" || !f.upload || !f.fileId) fail("CONFLICT", "No transfer receipt to review")
        log(p, v.sub, `Approved fee ${f.year}`, now())
        return issue(
          u,
          p,
          {
            paidOn: f.upload.transferDate,
            amountCents: f.upload.amountCents,
            transferDate: f.upload.transferDate,
            method: "transfer",
          },
          v.sub,
          "Approved transfer receipt"
        )
      })
    },
    async rejectFee(v: Viewer, input: C.RejectFeeInput) {
      requireGeneral(v, "people:fees:write")
      return tx(async (u) => {
        const p = find(u.state, input.personId)
        const f = currentFee(p)
        if (f.status !== "receipt" || !f.fileId) fail("CONFLICT", "No transfer receipt to reject")
        await u.deleteFile(f.fileId)
        f.fileId = null
        f.upload = null
        f.rejection = { reason: input.reason, by: v.sub, at: now().toISOString() }
        f.rejections.unshift(f.rejection)
        f.status = date() > f.dueOn ? "unpaid" : "due"
        if (p.member) p.member.fee = f.status
        if (p.profile.personalEmail)
          queue(
            u.state,
            p,
            `fee-rejection:${randomUUID()}`,
            p.profile.personalEmail,
            "PoliNetwork · verifica del bonifico",
            `abbiamo controllato la ricevuta del bonifico per la quota associativa ${f.year} e non abbiamo potuto accettarla. Questo è il motivo:\n\n${input.reason}\n\nPuoi caricare una nuova ricevuta dalla tua area personale.`,
            { label: "Apri la tua area", url: AREA }
          )
        log(p, v.sub, `Rejected fee receipt: ${input.reason}`, now())
      })
    },
    async markFeePaid(v: Viewer, input: C.MarkPaidInput) {
      requireGeneral(v, "people:fees:write")
      return tx(async (u) => {
        const p = find(u.state, input.personId)
        const f = currentFee(p)
        if (f.status === "receipt") fail("CONFLICT", "Review the uploaded transfer instead")
        return issue(
          u,
          p,
          {
            paidOn: input.paidOn,
            amountCents: input.amountCents,
            method: input.method,
            transferDate: input.method === "transfer" ? input.paidOn : null,
          },
          v.sub,
          input.note
        )
      })
    },
    async remindFees(v: Viewer, input: C.FeeRemindInput) {
      requireGeneral(v, "people:fees:write")
      const result = await tx((u) => {
        const ids: string[] = []
        let skipped = 0
        for (const p of Object.values(u.state.persons).filter(
          (p) => p.member && p.member.status !== "former" && (!input.personId || p.id === input.personId)
        )) {
          const f = fee(p, config, date())
          if (
            !f ||
            !["due", "unpaid"].includes(f.status) ||
            !p.member?.m365Email ||
            (f.lastReminder && now().getTime() - Date.parse(f.lastReminder) < 3 * 86400000)
          ) {
            skipped++
            continue
          }
          const id = `fee-reminder:${p.id}:${f.year}:${date()}`
          queue(u.state, p, id, p.member.m365Email, `PoliNetwork · quota ${f.year}`, feeReminder(f), {
            label: "Apri la tua area",
            url: AREA,
          })
          f.lastReminder = now().toISOString()
          ids.push(id)
          log(p, v.sub, `Queued fee reminder ${f.year}`, now())
        }
        return { ids, skipped }
      })
      await this.deliverPending(result.ids)
      return tx((u) => {
        const sent = result.ids.filter((id) => u.state.outbox[id].status === "sent").length
        return { sent, skipped: result.skipped + result.ids.length - sent }
      })
    },
    async listReceipts(v: Viewer, input: { year: string | null }): Promise<C.ReceiptsPage> {
      requireGeneral(v, "people:members:read")
      return tx((u) => {
        const y = input.year ?? year()
        const officerRef = (id: string | null) => (id && u.state.persons[id] ? ref(u.state.persons[id]) : null)
        return {
          year: y,
          years: [...new Set([year(), ...Object.values(u.state.receipts).map((r) => r.year)])].sort().reverse(),
          viewerSigner: office(u.state, v, config),
          officers: {
            president: officerRef(config.officers.president),
            vicePresident: officerRef(config.officers.vicePresident),
          },
          receipts: Object.values(u.state.receipts)
            .filter((r) => r.year === y)
            .sort(newestReceipts)
            .map((r) => C.receiptSchema.parse(r)),
        }
      })
    },
    async downloadReceipt(v: Viewer, input: { receiptId: string }) {
      requireGeneral(v, "people:members:read")
      return tx((u) => {
        const r = findReceipt(u.state, input.receiptId)
        return filePayload(u, r.signedFileId ?? r.originalFileId)
      })
    },
    async downloadMyReceipt(v: Viewer, input: { receiptId: string }) {
      return tx((u) => {
        const p = requireOwn(u.state, v)
        const r = u.state.receipts[input.receiptId]
        if (!r || r.person.id !== p.id || !["signed", "sent", "failed"].includes(r.status) || !r.signedFileId)
          fail("NOT_FOUND", "Signed receipt not found")
        return filePayload(u, r.signedFileId)
      })
    },
    async prepareReceiptSignatures(v: Viewer, input: C.PrepareReceiptSignaturesInput) {
      C.prepareReceiptSignaturesInputSchema.parse(input)
      return tx(async (u) => {
        const selected = input.receiptIds.map((id) => receiptForOfficer(u.state, v, id, true))
        const signer = own(u.state, v) ?? fail("FORBIDDEN", "Confirmed officer required")
        const result: C.ReceiptSignature[] = []
        for (const r of selected)
          result.push({ receiptId: r.id, ...(await u.prepareRequest(r, v.sub, nameOf(signer))) })
        return result
      })
    },
    async downloadReceiptsToSign(v: Viewer) {
      requireGeneral(v, "people:receipts:sign")
      return tx(async (u) => {
        const signer = office(u.state, v, config)
        if (!signer) fail("FORBIDDEN", "Only a confirmed officer can sign receipts")
        const selected = Object.values(u.state.receipts).filter((r) => r.status === "toSign" && r.signer === signer)
        if (!selected.length) fail("CONFLICT", "No receipts waiting for you")
        const zip: Record<string, Uint8Array> = {}
        for (const r of selected) {
          await u.prepareRequest(r, v.sub, nameOf(own(u.state, v) ?? fail("FORBIDDEN", "Confirmed officer required")))
          const file = await u.getFile(r.originalFileId)
          if (!file) fail("NOT_FOUND", "Receipt PDF missing")
          zip[file.fileName] = file.content
        }
        return {
          fileName: `ricevute-${year().replace("/", "-")}.zip`,
          contentType: "application/zip",
          base64: Buffer.from(zipSync(zip)).toString("base64"),
        }
      })
    },
    async previewSignedReceipts(v: Viewer, input: { files: File[] }) {
      requireGeneral(v, "people:receipts:sign")
      if (
        !input.files.length ||
        input.files.length > C.MAX_SIGNED_FILES ||
        input.files.some((f) => !f.size || f.size > MAX_FILE_BYTES) ||
        input.files.reduce((n, f) => n + f.size, 0) > 50 * 1024 * 1024
      )
        fail("BAD_REQUEST", "Upload 1–100 files, 10 MB each and 50 MB in total")
      const prepared = await tx(async (u) => {
        const signer = office(u.state, v, config)
        if (!signer) fail("FORBIDDEN", "Only a confirmed officer can upload receipts")
        const selected = Object.values(u.state.receipts).filter((r) => r.status === "toSign" && r.signer === signer)
        return Promise.all(
          selected.map(async (r) => ({
            receipt: r,
            request: await u.prepareRequest(
              r,
              v.sub,
              nameOf(own(u.state, v) ?? fail("FORBIDDEN", "Confirmed officer required"))
            ),
          }))
        )
      })
      const id = randomUUID()
      const files: {
        id: string
        fileName: string
        size: number
        receiptId: string | null
        valid: boolean
        signer: string | null
        bytes: Uint8Array
      }[] = []
      for (const file of input.files) {
        const match = prepared.find(({ receipt: r }) =>
          new RegExp(`${r.number.replace("/", "[-_ /]")}(?![0-9])`).test(file.name)
        )
        const bytes = new Uint8Array(await file.arrayBuffer())
        let valid = false
        let signer: string | null = null
        const content = bytes
        try {
          const verified = await options.inspectSigned(v.sub, bytes)
          valid = true
          signer = verified.signer
        } catch {
          /* Invalid files stay visible in the preview and cannot be sent. */
        }
        files.push({
          id: randomUUID(),
          fileName: file.name,
          size: bytes.length,
          receiptId: match?.receipt.id ?? null,
          valid,
          signer,
          bytes: content,
        })
      }
      return tx(async (u) => {
        const expiresAt = new Date(now().getTime() + 86400000).toISOString()
        const batch = { id, owner: v.sub, expiresAt, consumed: false, files: files.map(({ bytes: _, ...f }) => f) }
        u.state.batches[id] = batch
        for (const f of files)
          await u.putFile({
            id: f.id,
            fileName: f.fileName,
            contentType: "application/pdf",
            content: f.bytes,
            expiresAt,
          })
        return {
          uploadId: id,
          files: batch.files.map((f) => ({
            fileId: f.id,
            fileName: f.fileName,
            size: f.size,
            receiptId: f.receiptId,
            signature: { valid: f.valid, signer: f.signer },
          })),
        }
      })
    },
    async sendSignedReceipts(v: Viewer, input: C.SendSignedInput) {
      requireGeneral(v, "people:receipts:sign")
      const planned = await tx(async (u) => {
        const b = u.state.batches[input.uploadId]
        if (!b || b.owner !== v.sub || b.consumed || b.expiresAt < now().toISOString())
          fail("NOT_FOUND", "Signed upload expired or already used")
        const assignments = Object.entries(input.assignments)
        if (!assignments.length || new Set(assignments.map(([, r]) => r)).size !== assignments.length)
          fail("BAD_REQUEST", "Choose distinct receipts")
        const result: { fileId: string; receiptId: string; requestId: string; content: Uint8Array }[] = []
        for (const [fileId, receiptId] of assignments) {
          const f = b.files.find((f) => f.id === fileId)
          if (!f?.valid) fail("BAD_REQUEST", "Every assigned file must contain a verified signature")
          const r = receiptForOfficer(u.state, v, receiptId, false)
          const file = await u.getFile(fileId)
          if (!file || !r.requestId) fail("NOT_FOUND", "Signed file or signature request missing")
          result.push({ fileId, receiptId, requestId: r.requestId, content: file.content })
        }
        return result
      })
      // Validate every corrected assignment before committing any signature.
      for (const p of planned) await options.verifySigned(v.sub, p.requestId, p.content)
      let failed = 0
      for (const p of planned) {
        try {
          await options.completeSigned(v.sub, p.requestId, p.content)
        } catch {
          failed++
        }
      }
      await tx(async (u) => {
        const b = u.state.batches[input.uploadId]
        b.consumed = true
        for (const f of b.files) await u.deleteFile(f.id)
      })
      await this.deliverPending(planned.map((p) => `receipt:${p.receiptId}`))
      // Count actual delivery results, rather than reporting a queued email as sent.
      return tx((u) => {
        const receipts = planned.map((p) => u.state.receipts[p.receiptId])
        return {
          sent: receipts.filter((r) => r.status === "sent").length,
          failed: receipts.filter((r) => r.status !== "sent").length || failed,
        }
      })
    },
    async retryReceipt(v: Viewer, input: { receiptId: string }) {
      requireGeneral(v, "people:fees:write")
      await tx((u) => {
        const r = findReceipt(u.state, input.receiptId)
        if (r.status !== "failed") fail("CONFLICT", "No failed delivery to retry")
        const mail = u.state.outbox[`receipt:${r.id}`]
        if (!mail || mail.status !== "failed") fail("CONFLICT", "Delivery is already running")
        mail.status = "pending"
        mail.attemptedAt = null
        mail.error = null
        r.status = "signed"
        r.failure = null
        log(find(u.state, r.person.id), v.sub, `Retrying receipt ${r.number}`, now())
      })
      await this.deliverPending([`receipt:${input.receiptId}`])
    },
    async voidReceipt(v: Viewer, input: C.VoidReceiptInput) {
      requireGeneral(v, "people:fees:write")
      return tx(async (u) => {
        const r = findReceipt(u.state, input.receiptId)
        if (r.status === "voided") fail("CONFLICT", "Already voided")
        const mail = u.state.outbox[`receipt:${r.id}`]
        if (mail?.status === "sending") fail("CONFLICT", "Delivery is running; wait for its outcome")
        await u.invalidateRequest(r, v.sub)
        r.status = "voided"
        r.voided = { reason: input.reason, by: v.sub, on: date() }
        if (mail?.status === "pending") {
          mail.status = "failed"
          mail.error = "Receipt voided"
        }
        const p = find(u.state, r.person.id)
        if (
          r.year === year() &&
          !Object.values(u.state.receipts).some(
            (other) => other.person.id === p.id && other.year === r.year && other.status !== "voided"
          )
        ) {
          const f = fee(p, config, date())
          if (f) {
            f.status = date() > f.dueOn ? "unpaid" : "due"
            f.payment = null
            if (p.member) p.member.fee = f.status
          }
        }
        log(p, v.sub, `Voided receipt ${r.number}: ${input.reason}`, now())
      })
    },
    async uploadTransferReceipt(v: Viewer, input: { file: File; transferDate: string; amountCents: number }) {
      requireSelf(v)
      if (!input.file.size || input.file.size > MAX_FILE_BYTES)
        fail("BAD_REQUEST", "Transfer receipt must be at most 10 MB")
      if (input.transferDate > date()) fail("BAD_REQUEST", "Transfer date is in the future")
      const bytes = new Uint8Array(await input.file.arrayBuffer())
      const contentType = await options.transferType(bytes)
      return tx(async (u) => {
        const p = requireOwn(u.state, v)
        const f = currentFee(p)
        if (!["due", "unpaid"].includes(f.status)) fail("CONFLICT", "This fee is already paid or awaiting review")
        const id = randomUUID()
        if (f.fileId) await u.deleteFile(f.fileId)
        await u.putFile({ id, fileName: input.file.name.slice(0, 200), contentType, content: bytes, expiresAt: null })
        f.fileId = id
        f.upload = {
          fileName: input.file.name.slice(0, 200),
          size: bytes.length,
          uploadedAt: now().toISOString(),
          transferDate: input.transferDate,
          amountCents: input.amountCents,
        }
        f.status = "receipt"
        f.rejection = null
        if (p.member) p.member.fee = "receipt"
        log(p, v.sub, `Uploaded fee transfer receipt ${f.year}`, now())
      })
    },

    async eligibleReceipt(requestId: string, sub: string, can: Viewer["can"], requireEsign = true) {
      return tx((u) => {
        const r = Object.values(u.state.receipts).find((r) => r.requestId === requestId)
        return !!r && receiptEligible(u.state, r, { sub, telegramId: null, can }, config, requireEsign)
      })
    },
    async canViewReceipt(receiptId: string, sub: string, can: Viewer["can"]) {
      return tx((u) => {
        const r = u.state.receipts[receiptId]
        const v = { sub, telegramId: null, can }
        return !!r && (general(v, "people:members:read") || office(u.state, v, config) === r.signer)
      })
    },
    async deliverPending(onlyIds?: readonly string[]) {
      // Claim and record intent before network I/O. Unknown outcomes require an explicit retry.
      const claimed = await commit((u) => {
        for (const mail of Object.values(u.state.outbox))
          if (
            mail.status === "sending" &&
            mail.attemptedAt &&
            now().getTime() - Date.parse(mail.attemptedAt) > 10 * 60000
          ) {
            mail.status = "failed"
            mail.error = "Delivery outcome unknown after interruption; check the mailbox before retrying"
            if (mail.receiptId) {
              const r = u.state.receipts[mail.receiptId]
              if (r.status !== "voided") {
                r.status = "failed"
                r.failure = mail.error
              }
            }
          }
        const pending = Object.values(u.state.outbox)
          .filter((m) => m.status === "pending" && (!onlyIds || onlyIds.includes(m.id)))
          .slice(0, onlyIds?.length ?? 20)
        for (const mail of pending) {
          mail.status = "sending"
          mail.attemptedAt = now().toISOString()
        }
        return pending.map((mail) => ({
          ...mail,
          firstName: u.state.persons[mail.personId]?.profile.firstName ?? null,
        }))
      })
      for (const mail of claimed) {
        let error: string | null = null
        try {
          const fileId = mail.fileId
          const file = fileId ? await commit((u) => u.getFile(fileId)) : null
          if (mail.fileId && !file) throw new Error("Attachment is missing")
          await options.sendMail({
            id: mail.id,
            to: mail.to,
            subject: mail.subject,
            text: mail.text,
            firstName: mail.firstName,
            action: mail.action ?? null,
            attachment: file,
          })
        } catch (err) {
          error = err instanceof Error ? err.message : String(err)
        }
        await commit((u) => {
          const current = u.state.outbox[mail.id]
          if (current.status !== "sending" || current.attemptedAt !== mail.attemptedAt) return
          current.status = error ? "failed" : "sent"
          current.error = error
          const p = u.state.persons[mail.personId]
          if (error && mail.id.startsWith("fee-reminder:")) {
            const year = mail.id.split(":")[2]
            if (p.feeYears[year]) p.feeYears[year].lastReminder = null
          }
          if (error && mail.id.startsWith("census:")) {
            const campaignId = mail.id.split(":")[1]
            delete p.reminders[campaignId]
            const entry = p.census.find((e) => e.year === u.state.campaigns[campaignId]?.year)
            if (entry) entry.reminders = Math.max(0, entry.reminders - 1)
          }
          if (mail.receiptId) {
            const r = u.state.receipts[mail.receiptId]
            if (r.status !== "voided") {
              r.status = error ? "failed" : "sent"
              r.failure = error
              if (!error) {
                r.sentAt = now().toISOString()
                r.sentTo = mail.to
              }
            }
            log(
              p,
              "system",
              error ? `Receipt ${r.number} email failed: ${error}` : `Emailed receipt ${r.number}`,
              now()
            )
          } else log(p, "system", error ? `Email failed: ${error}` : `Sent email: ${mail.subject}`, now())
        })
      }
    },
    /** Reads PoliNetwork Auth and the Microsoft 365 Soci group now, without the cache, and lays them over the register. */
    async syncSources() {
      const [directory, members] = await Promise.all([readDirectory(true), readMembers(true)])
      await commit((u) => {
        applySources(u.state, directory, members)
        activeCampaign(u.state)
      })
    },
    async sweep() {
      const pending = await commit((u) =>
        Object.values(u.state.persons)
          .filter((p) => p.roleCommand)
          .map((p) => p.id)
      )
      for (const id of pending) await deliverRoleCommand(id)
      // Fee reminders follow the current members: lay the sources over the register when they answer.
      const sources = await Promise.all([readDirectory(), readMembers()]).catch((error: unknown) => {
        console.error(error)
        return null
      })
      await commit(async (u) => {
        if (sources) applySources(u.state, ...sources)
        activeCampaign(u.state)
        for (const [id, batch] of Object.entries(u.state.batches))
          if (batch.expiresAt < now().toISOString()) {
            for (const f of batch.files) await u.deleteFile(f.id)
            delete u.state.batches[id]
          }
        for (const [id, batch] of Object.entries(u.state.imports))
          if (batch.expiresAt < now().toISOString()) delete u.state.imports[id]
        for (const p of Object.values(u.state.persons)) {
          const f = fee(p, config, date())
          if (!f || f.status !== "due" || !p.member?.m365Email || p.importedFeeYear === f.year) continue
          const days = Math.round((Date.parse(f.dueOn) - Date.parse(date())) / 86400000)
          if (![14, 3].includes(days)) continue
          const id = `fee-auto:${p.id}:${f.year}:${days}`
          if (u.state.outbox[id]) continue
          queue(u.state, p, id, p.member.m365Email, `PoliNetwork · quota ${f.year}`, feeReminder(f), {
            label: "Apri la tua area",
            url: AREA,
          })
          f.lastReminder = now().toISOString()
          log(p, "system", `Queued automatic fee reminder ${f.year} (${days} days)`, now())
        }
      })
      await this.deliverPending()
    },
  }
}
export type PeopleService = ReturnType<typeof createPeopleService>
