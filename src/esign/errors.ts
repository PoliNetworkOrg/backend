export type EsignErrorCode =
  | "not_found"
  | "forbidden"
  | "bad_request"
  | "conflict"
  | "unavailable"
  | "pdf_invalid"
  | "ticket_invalid"
  | "job_expired"
  | "job_done"
  | "job_cancelled"
  | "document_changed"
  | "certificate_invalid"
  | "signer_mismatch"
  | "signature_invalid"

/** HTTP status of each code, for the agent's REST endpoints. */
export const HTTP_STATUS: Record<EsignErrorCode, number> = {
  not_found: 404,
  forbidden: 403,
  bad_request: 400,
  conflict: 409,
  unavailable: 503,
  pdf_invalid: 422,
  ticket_invalid: 404,
  job_expired: 410,
  job_done: 409,
  job_cancelled: 409,
  document_changed: 409,
  certificate_invalid: 422,
  signer_mismatch: 403,
  signature_invalid: 422,
}

/** An expected failure, with a message the dashboard or the agent can show as is. */
export class EsignError extends Error {
  constructor(
    readonly code: EsignErrorCode,
    message: string
  ) {
    super(message)
    this.name = "EsignError"
  }
}
