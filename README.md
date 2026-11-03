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
5. (Optional) Fill the database with sample data: Telegram users, groups and messages, course groups and labels, projects, associations, FAQs, freshman guides, group link reports, audit log entries and grants:
   ```sh
   bun run seed:db
   ```
   Each table is seeded only while it is empty. New Telegram messages reference retained users and groups, and missing sample FAQ categories are added when the FAQ table is empty. Grants are only added for Telegram users created by the current run.

   `--force` replaces the Telegram activity tables, sample web content, audit logs, and grants.

## Authentication

Every caller authenticates with a PoliNetwork IdP token ([RFC v3](https://github.com/PoliNetworkOrg/auth/blob/main/docs/idp-telegram-integration-rfc-v3.md), Phase 5):

- **With a token** (`Authorization: Bearer <IdP access token>`): the token is verified with [`@polinetwork/auth-kit`](https://github.com/PoliNetworkOrg/auth-kit), and the call is fully enforced. Every procedure declares, per actor kind, the scope it needs and, for people, the permission they must hold in the IdP's access snapshot. A token that fails verification is rejected. The bot acts for a Telegram user with `X-PN-Actor: telegram:<id>`, which only a service token with `backend:tg:act-as` may send.
- **Without a token**: refused (`UNAUTHORIZED`). There is no anonymous access, and handlers always receive the token's actor in `ctx.actor`.

Procedures are built with `policy(...)` from `src/trpc.ts`; the bare tRPC procedure is not exported, and `tests/idp-router.test.ts` fails if any procedure lacks a policy.

Who acted always comes from the token, never from the input: procedures take no actor fields (`createdBy`, `modifiedBy`, `updatedBy`, `adderId`, `interruptedById`, `performerId`, `adminId`). Inputs are plain zod objects, so a key an older client still sends is stripped, not rejected. Content tables record the author in `*_by_sub` columns; rows written before the IdP migration keep their author's Telegram ID in `legacy_*_by_tg_id`. Grants are in `tg_grants` and record the grantor's IdP subject. People sign in only through the IdP: the backend has no login of its own. The bot records moderation actions with `tg.auditLog.record`, which takes an idempotency key and flags `idp_permission` actions the snapshot does not back.

The bot's socket.io client authenticates with its service token in `auth.token` (scope `backend:tg:events`) and is disconnected when the token expires; a socket without a token is refused. Set `OAUTH_BOT_CLIENT_ID` on the backend to the same registered OAuth client ID used by the bot. This is the actual client ID, not its display name. Sockets are rejected if this setting is absent, the client ID differs, the token is not a service token or the scope is missing.

The IdP notifies `POST /internal/events` when access changes; the backend also polls the snapshot every 30 s. The last good signing keys and snapshot are stored in `common_idp_state`, so a restart during an IdP outage resumes from them. Permission checks deny once the snapshot is more than an hour old. Configuration is in `.env.example`.

## People

The `people` router is the admin dashboard's register of Group Admins, Capo Admins and team members. Each person
is one record in `people_persons`; their roles are rows in `people_assignments`, with an append-only history in
`people_activity`.

- **A record linked to a login account** (`account_sub`): PoliNetwork Auth is the source of truth. People reads
  who holds the roles bound to People from `GET /api/internal/people-roles` (15 s cache, the last answer during an
  outage of up to an hour) and creates linked records for people given a bound role by hand in Auth. Changes go to
  `POST /api/internal/people-roles` through the `people_role_commands` outbox: each command has an ID Auth applies at
  most once, so the cron sends it again until Auth answers. The assignment shows `sent` until Auth confirms it, and
  Auth's reason when it refuses.
- **A record that isn't linked yet**: its assignments stay `pending` in the backend, and are sent when the record is
  linked, acting as whoever links it by hand or, for an invite, as whoever made each assignment.

A record is linked to a login account in exactly two ways, never by matching emails, names or Telegram:

- **Email invite** (`people:write`, or the Lead of one of the person's teams): a single-use link to the contact
  email, stored hashed, valid for 14 days; a new invite revokes the previous one. Any signed-in account can open it
  (`me.invite`) and accept it (`me.acceptInvite`), with no People permission and whatever its email.
- **By hand** (`admin:access` + `people:link`): search the IdP directory and link an account; nobody links their own.

Unlinking (`people:link`) takes the record's roles back in Auth with a role command, then detaches the account; its
assignments go back to `pending`. `linking.recent` lists the links of the last 30 days, with method, date and who
made them, so a mistake or a forwarded invite is easy to spot and undo.

The backend checks every role change with the same rules as Auth (`src/people/rules.ts`, shaped like Auth's
`src/auth/people-binding.ts`): no self-grants, the right permission per kind, and bounded delegation against the
role's permissions. A concept with no role bound in Auth, or with more than one, can't be assigned. Writes are
serialized by one transaction lock. Grant `idp:people:roles` to the backend's OAuth client to let it change roles.

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
- The proxy passes on the agent's `User-Agent: PoliNetwork-eSign/<version>` (`PoliNetwork-Sign-Agent/<version>` for
  0.1.x, released before the rename). An agent older than `MIN_AGENT_VERSION` (`src/esign/agent-version.ts`) gets 426
  `agent_outdated` when it loads a job, before the PIN, and the job fails so the dashboard can say why. No User-Agent,
  a development or source build (`dev`, `v0.1.1-6-g0cb0f7b`) or an unreadable version passes; preparing a signature
  still refuses an agent without protocol 2.

Emails (`src/emails/templates`, preview with `bun run email`):

- "Signature needed" tells signers their turn started.
- "Documento firmato" sends the signed PDF to the addresses the request names, in Italian since they are often outside
  PoliNetwork. The PDF is attached up to 2 MB, otherwise linked from OneDrive; replies go to whoever sent the request.
- "Request update" tells a request's creator that a signer declined, with the reason, or that everyone signed, unless
  the creator saw it by signing last or retrying the delivery. When saving or emailing the signed PDF fails, it tells
  the creator and every manager who may retry (`esign:sign` and `esign:requests:manage`, allowed on the request's
  drives), the last signer included: the delivery runs once they have signed. Nobody is emailed about what they just
  did, each outcome is emailed once, and an email that fails is only logged.

Signatures are checked against the CIE certification authorities of the Ministero dell'Interno bundled in
`src/esign/trust`. Tests: `bunx vitest run tests/esign-*.test.ts` (validated with poppler `pdfsig` when installed).

## Freshman content

`web.freshman` exposes fixed-slot content for the website and authorized admin editors. Migration
`0026_freshman_content` initializes 10 resources, 8 Telegram links and 5 existing/new FAQs, preserving matching
catalog entries. Selected FAQs/categories must be replaced in Freshman before deleting them from the catalog.
The development seed also initializes the card slots and selections; `--force` clears those selections before
replacing the sample FAQ catalog.
