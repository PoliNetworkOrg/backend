import { env } from "@/env"
import type { PeopleConfig } from "./types"

if (env.PEOPLE_PRESIDENT_ID && env.PEOPLE_PRESIDENT_ID === env.PEOPLE_VICE_PRESIDENT_ID)
  throw new Error("The President and Vice-president must be different People records")

export const peopleConfig: PeopleConfig = {
  officers: { president: env.PEOPLE_PRESIDENT_ID ?? null, vicePresident: env.PEOPLE_VICE_PRESIDENT_ID ?? null },
  feeCents: env.PEOPLE_FEE_CENTS,
  beneficiary: env.PEOPLE_BENEFICIARY,
  iban: env.PEOPLE_IBAN ?? "",
  legalName: env.PEOPLE_LEGAL_NAME ?? "",
  address: env.PEOPLE_ADDRESS ?? "",
  taxCode: env.PEOPLE_TAX_CODE ?? "",
  dashboardUrl: env.ESIGN_DASHBOARD_URL.replace(/\/$/, ""),
}
