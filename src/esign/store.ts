import type {
  DeliveryJson,
  EmailJson,
  OutputJson,
  PlaceJson,
  PlacementJson,
  PreparedJson,
  SourceJson,
} from "@/db/schema/esign/esign"

export type { DeliveryJson, EmailJson, OutputJson, PlaceJson, PlacementJson, PreparedJson, SourceJson }

export type Profile = {
  sub: string
  name: string
  email: string | null
  fiscalCode: string | null
  certificateSubject: string | null
}

export type DocumentMeta = {
  id: string
  requestId: string | null
  version: number
  fileName: string
  sha256: string
  size: number
  pages: number
  source: SourceJson
  createdBySub: string
  createdAt: Date
}

export type DocumentRecord = DocumentMeta & { content: Uint8Array }

export type NewDocument = Omit<DocumentRecord, "id" | "createdAt">

export type RequestStatus = "in_progress" | "completed" | "cancelled" | "declined"
export type SignerStatus = "pending" | "signed" | "declined"

export type Signer = {
  id: string
  requestId: string
  position: number
  sub: string
  name: string
  role: string | null
  places: PlaceJson[]
  /** Signature places already signed. */
  signaturesDone: number
  status: SignerStatus
  signedAt: Date | null
  version: number | null
  fiscalCode: string | null
  certificateSubject: string | null
  certificateIssuer: string | null
  declineReason: string | null
}

export type SigningRequest = {
  id: string
  title: string
  status: RequestStatus
  ordered: boolean
  output: OutputJson | null
  email: EmailJson | null
  delivery: DeliveryJson | null
  createdBySub: string
  createdAt: Date
  updatedAt: Date | null
  completedAt: Date | null
  cancelledAt: Date | null
  signers: Signer[]
}

export type NewRequest = {
  title: string
  ordered: boolean
  output: OutputJson | null
  email: EmailJson | null
  createdBySub: string
  documentId: string
  signers: { sub: string; name: string; role: string | null; places: PlaceJson[] }[]
}

export type JobStatus = "pending" | "prepared" | "completed" | "failed" | "cancelled" | "expired"

export type Job = {
  id: string
  ticketHash: string
  requestId: string
  signerId: string
  sub: string
  status: JobStatus
  baseVersion: number
  places: PlaceJson[]
  /** Index of the next signature place to sign, among the signature places. */
  step: number
  expiresAt: Date
  prepared: PreparedJson | null
  errorCode: string | null
  errorMessage: string | null
  /** When the agent first fetched the job: tells "the agent is not running" from "the user is typing the PIN". */
  seenAt: Date | null
  createdAt: Date
  completedAt: Date | null
}

export type NewJob = Pick<
  Job,
  "ticketHash" | "requestId" | "signerId" | "sub" | "baseVersion" | "places" | "step" | "expiresAt"
>

export type RequestEvent = {
  id: number
  requestId: string
  at: Date
  actorSub: string | null
  type: string
  data: Record<string, unknown> | null
}

export type NewEvent = Omit<RequestEvent, "id" | "at">

export type RequestFilter = {
  /** Requests where this subject signs or that it created; all requests when absent. */
  involving?: string
  status?: RequestStatus[]
  limit?: number
}

/** The signature commit: a new document version, the signer's and the job's new state, atomically. */
export type SignatureCommit = {
  jobId: string
  requestId: string
  baseVersion: number
  document: NewDocument
  signer: { id: string; fiscalCode: string | null; certificateSubject: string; certificateIssuer: string }
  /**
   * Set when this is the signer's last signature place: the signer is signed and the job completed. Otherwise the
   * signer's count of signed places grows and the job moves to its next place on the new version.
   */
  final: boolean
  /** Set when this signature completes the request. */
  complete: boolean
  /** Recorded when `final`. */
  event: NewEvent
  /**
   * The signer's CIE identity: checked against the profile's bound fiscal code and bound on first use, in the same
   * transaction, so two prepared signatures with different cards cannot both pass.
   */
  identity: { sub: string; fiscalCode: string | null; certificateSubject: string }
}

/** Persistence for e-signing. Implemented over Postgres, and in memory for tests. */
export interface EsignStore {
  upsertProfile(profile: { sub: string; name: string; email: string | null }): Promise<Profile>
  getProfile(sub: string): Promise<Profile | null>
  listProfiles(): Promise<Profile[]>
  setProfileIdentity(sub: string, identity: { fiscalCode: string; certificateSubject: string } | null): Promise<void>

  insertDocument(doc: NewDocument): Promise<DocumentMeta>
  getDocument(id: string): Promise<DocumentRecord | null>
  getDocumentMeta(id: string): Promise<DocumentMeta | null>
  /** The newest version of a request's document. */
  latestDocument(requestId: string): Promise<DocumentRecord | null>
  listVersions(requestId: string): Promise<DocumentMeta[]>
  /** Deletes staged documents (no request) created before `before`. */
  deleteStaleStaged(before: Date): Promise<number>

  /** Creates the request and its signers and attaches the staged document as version 0. */
  createRequest(input: NewRequest): Promise<SigningRequest>
  getRequest(id: string): Promise<SigningRequest | null>
  listRequests(filter: RequestFilter): Promise<SigningRequest[]>
  updateRequest(id: string, patch: Partial<Pick<SigningRequest, "delivery">>): Promise<void>
  /** Cancels an in-progress request and its open jobs, atomically with signature commits. */
  cancelRequest(id: string, event: NewEvent): Promise<"ok" | "conflict">
  /** Records a pending signer's refusal, which ends the request, atomically with signature commits. */
  declineRequest(id: string, signerId: string, reason: string | null, event: NewEvent): Promise<"ok" | "conflict">
  /**
   * Claims a completed request's delivery for one worker: succeeds when it is pending (or failed with `retry`) and no
   * other attempt started after `staleBefore`.
   */
  claimDelivery(id: string, at: Date, staleBefore: Date, retry: boolean): Promise<boolean>
  /** Completed requests whose delivery is pending and was not attempted after `staleBefore`. */
  pendingDeliveries(staleBefore: Date): Promise<string[]>
  updateSigner(id: string, patch: Partial<Pick<Signer, "status" | "declineReason" | "places">>): Promise<void>

  addEvent(event: NewEvent): Promise<void>
  listEvents(requestId: string): Promise<RequestEvent[]>

  createJob(job: NewJob): Promise<Job>
  getJob(id: string): Promise<Job | null>
  getJobByTicketHash(hash: string): Promise<Job | null>
  getPreparedPdf(jobId: string): Promise<Uint8Array | null>
  /** Jobs of a request that are still pending or prepared. */
  openJobs(requestId: string): Promise<Job[]>
  /** Updates a job if its status is one of `from`; returns whether it did. */
  transitionJob(
    id: string,
    from: JobStatus[],
    patch: Partial<Pick<Job, "status" | "prepared" | "errorCode" | "errorMessage" | "completedAt" | "seenAt">> & {
      preparedPdf?: Uint8Array | null
    }
  ): Promise<boolean>
  /** Applies a signature if the request is still at `baseVersion` and the job is prepared. */
  commitSignature(commit: SignatureCommit): Promise<"ok" | "conflict" | "mismatch">
  /** Marks old open jobs expired and drops prepared PDFs of finished jobs. */
  sweepJobs(now: Date): Promise<void>
}
