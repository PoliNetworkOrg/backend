export const EMAIL_HEADERS = {
  "fee-opening": "Quota associativa",
  "fee-reminder": "Promemoria quota associativa",
  "fee-confirmed": "Quota pagata",
  "fee-rejected": "Ricevuta non accettata",
  welcome: "Benvenuto in PoliNetwork APS",
  "member-number-changed": "Il tuo numero socio è cambiato",
  "signature-request": "È richiesta la tua firma",
  "request-update": "Firma rifiutata",
  "request-completed": "Tutte le firme sono state raccolte",
  "request-delivery-failed": "Il PDF firmato non è stato consegnato",
  "signed-document": "Documento firmato",
} as const

export type EmailHeaderKind = keyof typeof EMAIL_HEADERS
export const headerCid = (kind: EmailHeaderKind) => `polinetwork-header-${kind}@polinetwork.org`
