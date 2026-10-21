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
5. (Optional) Fill the database with sample data: Telegram users, groups and messages, course groups and labels, projects, associations, FAQs, freshman guides, group link reports, audit log entries, grants and staff roles:
   ```sh
   bun run seed:db
   ```
   Each table is seeded only while it is empty. New Telegram messages reference retained users and groups, and missing sample FAQ categories are added when the FAQ table is empty. Staff roles, group-admin assignments, and grants are only added for Telegram users created by the current run; group-admin assignments also require groups created by the run.

   `--force` replaces the Telegram activity tables, sample web content, audit logs, and `tg_grants_v2` grants. Existing staff roles and group-admin assignments are preserved.
6. (Optional, for logging into the admin panel locally) Seed a test user with Telegram already linked and the `owner` role:
   ```sh
   bun run seed:user
   ```
   The script sends a sign-in OTP to `test@example.com` and prints a link to a temporary inbox where you can read the code — paste it when prompted. Without this step, logging into admin with `test@example.com` lands on the "Link your Telegram account" onboarding page, since that account has no `telegramId` associated yet. Re-run with `--force` to recreate the test user from scratch.

## Authentication

Every caller authenticates with a PoliNetwork IdP token ([RFC v3](https://github.com/PoliNetworkOrg/auth/blob/main/docs/idp-telegram-integration-rfc-v3.md), Phase 5):

- **With a token** (`Authorization: Bearer <IdP access token>`): the token is verified with [`@polinetwork/auth-kit`](https://github.com/PoliNetworkOrg/auth-kit), and the call is fully enforced. Every procedure declares, per actor kind, the scope it needs and, for people, the permission they must hold in the IdP's access snapshot. A token that fails verification is rejected. The bot acts for a Telegram user with `X-PN-Actor: telegram:<id>`, which only a service token with `backend:tg:act-as` may send.
- **Without a token**: refused (`UNAUTHORIZED`). `LEGACY_ANONYMOUS=allow` is only a rollback switch: it lets anonymous requests run procedures that do not record who acted, with a null actor and no permissions, and logs each call as `[AUTH] legacy anonymous call`. Writes that record their actor (grants, `tg.groups.leaveChat`, label and web content writes) and the IdP procedures are token-only and refuse anonymous calls either way.

Procedures are built with `policy(...)` from `src/trpc.ts`; the bare tRPC procedure is not exported, and `tests/idp-router.test.ts` fails if any procedure lacks a policy. `policy(rules, { tokenOnly: true })` refuses anonymous calls and gives the handler a non-null `ctx.actor`.

Who acted always comes from the token, never from the input: procedures take no actor fields (`createdBy`, `modifiedBy`, `updatedBy`, `adderId`, `interruptedById`, `performerId`, `adminId`). Inputs are plain zod objects, so a key an older client still sends is stripped, not rejected. Content tables record the author in `*_by_sub` columns, and grants go to `tg_grants_v2`. Until Phase 6 a grant counts as active if it is active in either `tg_grants` or `tg_grants_v2`. The bot records moderation actions with `tg.auditLog.record`, which takes an idempotency key and flags `idp_permission` actions the snapshot does not back.

The bot's socket.io client authenticates with its service token in `auth.token` (scope `backend:tg:events`) and is disconnected when the token expires; a socket without a token is refused. Set `OAUTH_BOT_CLIENT_ID` on the backend to the same registered OAuth client ID used by the bot. This is the actual client ID, not its display name. Sockets are rejected if this setting is absent, the client ID differs, the token is not a service token or the scope is missing.

The IdP notifies `POST /internal/events` when access changes; the backend also polls the snapshot every 30 s. The last good signing keys and snapshot are stored in `common_idp_state`, so a restart during an IdP outage resumes from them. Permission checks deny once the snapshot is more than an hour old. Configuration is in `.env.example`.

## E-signing with the CIE

The `esign` router and `/esign/agent/*` endpoints let dashboard users sign PDFs with the Italian identity card
(CIE). The backend prepares a PAdES baseline B-B signature (incremental update with a visible stamp), the user's
[PoliNetwork Sign Agent](https://github.com/PoliNetworkOrg/sign-agent) signs the digest with the card, and the backend
embeds the CMS, then saves the signed PDF to OneDrive and emails it. See the admin repository's
`docs/esign/contracts.md` for the flow.

| Variable                        | Meaning                                                                                                                      |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `ESIGN_DRIVES`                  | JSON array of the OneDrive/SharePoint libraries the dashboard offers, see below. Without Azure credentials in-memory drives are used. |
| `ESIGN_DASHBOARD_URL`           | Dashboard origin for links in emails (default `https://admin.polinetwork.org`).                                               |
| `ESIGN_ALLOW_TEST_CERTIFICATES` | `true` accepts certificates not issued by the CIE CAs (the agent's development key). Defaults to `true` outside production. |

`ESIGN_DRIVES` lists one entry per library; `id` is a stable key stored with each request (lowercase letters, digits
and dashes, keep it when changing the rest), `label` is shown in the dashboard, `driveId` is the Graph drive ID and
`rootId` the item ID of the folder the dashboard may browse and write (default `root`, the whole drive):

```sh
ESIGN_DRIVES='[{"id":"segreteria","label":"Segreteria","driveId":"b!…"},{"id":"tesoreria","label":"Tesoreria","driveId":"b!…","rootId":"01…"}]'
```

Requirements:

- IdP permissions `esign:sign` (sign and see one's requests) and `esign:requests:manage` (create and manage requests).
  `esign:drives:manage` sets which roles and permissions may use each drive (dashboard: Signatures › Drives).
- Graph application permission `Files.ReadWrite.All` (or `Sites.Selected` with write access to the site), with admin
  consent, for the drive; emails use the existing `Mail.Send` sender.
- The dashboard proxies `/api/esign/agent/*` to this backend's `/esign/agent/*`; the agent never calls the backend
  directly. Those endpoints are authenticated only by the job's single-use ticket.

Signatures are checked against the CIE certification authorities of the Ministero dell'Interno bundled in
`src/esign/trust`. Tests: `bunx vitest run tests/esign-*.test.ts` (validated with poppler `pdfsig` when installed).
