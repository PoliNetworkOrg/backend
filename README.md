# Backend

> [!NOTE]
>
> ### WIP
>
> This is a rewrite currently WIP that will take time. Drink a coffee and join us if you would like to contribute.

Currently we are building a backend which can be reached by other services/repos with a tRPC client.
If you are using another language than TS... then you might fulfill a PR and implement gRPC (are you sure u want pain?).

## Quickstart

Requirements:

- Bun installed
- A Postgres database

> [!NOTE]
> Azure credentials are optional. When `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`, and
> `AZURE_CLIENT_SECRET` are all omitted, the Azure tRPC routes use a seeded in-memory directory.
> Its changes last until the backend restarts. Set all three variables to connect to Microsoft Graph.

1. Install packages
   ```sh
   bun install
   ```
2. Setup environment variables in `.env` (use `.env.example` as template and see `./src/env.ts` as source of truth)
3. Run the DB migration
   ```sh
   bun db:migrate
   ```
4. Run the server
   ```sh
   bun dev
   ```
5. (Optional, for logging into the admin panel locally) Seed a test user with Telegram already linked and the `owner` role:
   ```sh
   bun run seed:user
   ```
   The script sends a sign-in OTP to `test@example.com` and prints a link to a temporary inbox where you can read the code — paste it when prompted. Without this step, logging into admin with `test@example.com` lands on the "Link your Telegram account" onboarding page, since that account has no `telegramId` associated yet. Re-run with `--force` to recreate the test user from scratch.

## Authentication

The backend is moving to the PoliNetwork IdP ([RFC v3](https://github.com/PoliNetworkOrg/auth/blob/main/docs/idp-telegram-integration-rfc-v3.md), Phase 3). Both paths run side by side until every caller sends a token:

- **With a token** (`Authorization: Bearer <IdP access token>`): the token is verified with [`@polinetwork/auth-kit`](https://github.com/PoliNetworkOrg/auth-kit), and the call is fully enforced. Every procedure declares, per actor kind, the scope it needs and, for people, the permission they must hold in the IdP's access snapshot. A token that fails verification is rejected; it never falls back to the legacy path. The bot acts for a Telegram user with `X-PN-Actor: telegram:<id>`, which only a service token with `backend:tg:act-as` may send.
- **Without a token**: the legacy behaviour, while `LEGACY_ANONYMOUS=allow`. Each call is logged as `[AUTH] legacy anonymous call` with its procedure, so callers still on this path can be found. Procedures added for the IdP refuse anonymous calls.

Procedures are built with `policy(...)` or `legacyProcedure` from `src/trpc.ts`; the bare tRPC procedure is not exported, and `tests/idp-router.test.ts` fails if any procedure lacks a policy. `legacyProcedure` marks procedures that the RFC removes, which token callers cannot use.

Actor fields such as `createdBy`, `adderId` or `performerId` are read only from legacy callers. For token callers the author comes from the token: content tables record it in `*_by_sub` columns, and grants made with a token go to `tg_grants_v2`. Until Phase 6 a grant counts as active if it is active in either `tg_grants` or `tg_grants_v2`. The bot records moderation actions with `tg.auditLog.record`, which takes an idempotency key and flags `idp_permission` actions the snapshot does not back.

The bot's socket.io client authenticates with its service token in `auth.token` (scope `backend:tg:events`) and is disconnected when the token expires. Without a token the socket is identified by its `type` query, while `LEGACY_ANONYMOUS=allow`.

The IdP notifies `POST /internal/events` when access changes; the backend also polls the snapshot every 30 s. The last good signing keys and snapshot are stored in `common_idp_state`, so a restart during an IdP outage resumes from them. Permission checks deny once the snapshot is more than an hour old. Configuration is in `.env.example`.
