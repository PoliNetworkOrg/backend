export { TRPC_PATH, WS_PATH } from "./constants"
export type {
  AccountMatch as PeopleAccountMatch,
  AdminSummary as PeopleAdminSummary,
  Assignment as PeopleAssignment,
  CapoArea as PeopleCapoArea,
  CapoSummary as PeopleCapoSummary,
  Invite as PeopleInvite,
  MyArea as PeopleMyArea,
  MyRoles as PeopleMyRoles,
  PersonRecord as PeoplePersonRecord,
  PersonRow as PeoplePersonRow,
  TeamId as PeopleTeamId,
  TeamSummary as PeopleTeamSummary,
} from "./people/contract"
export type { AppRouter } from "./routers"
export type { TelegramSocket } from "./websocket/telegram"
