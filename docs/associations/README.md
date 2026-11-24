# Association registry API and release

`associationPortal.*` is a user-only `backend:admin` API. Any authenticated user can apply; per-record membership is checked server-side on every mutation. Operators need both `admin:access` and `web:content:write`. No global permissions are granted to representatives.

The registry separates association identity, active membership, review requests and the approved public profile. Registration and access approval do not publish content. Content approval atomically changes the published profile. Invitations are single-use, expire after 14 days and store only token hashes in registry state; accepting binds the actual account but requires operator approval. Notes and other applicants' evidence are filtered from scoped responses. Explicit withdrawal revokes invitation tokens.

Migration `0040_association_portal.sql` backfills existing public associations with distinct UUIDs and preserves numeric catalog IDs, profiles and publication. All imported entries start without representatives. JSON state and its mail outbox are updated within PostgreSQL transactions; row locks serialize decisions, revisions detect stale edits, and per-account command keys support retries. Duplicate registrations can be redirected atomically to access requests on an existing association. No destructive record deletion is exposed.

`web.associations.getAllAssociations` retains the existing public response and adds `extraLinks` for repeated platform links (including Twitch). It reads only published registry snapshots, never private working profiles, notes, membership or evidence. Legacy mutation procedures now return `PRECONDITION_FAILED`; callers must use the reviewed registry.

## Portal extras (programmes, contacts, promotions, home, events, handover, credits)

### Data model

What changes together with membership and review stays in the registry's JSON aggregate; what grows per association, is queried across associations, or needs database-enforced invariants has its own table with a foreign key to `web_association_registry.id`.

| Data | Where | Why |
| --- | --- | --- |
| Programmes, campuses, cross-programme flag, public contacts | `profile` in the aggregate | Part of the public profile: reviewed and published with it |
| Non-public contacts, collaboration flag, handover | Aggregate (`contacts`, `collaboration`, `handover`) | Saved at once but must change atomically with membership (revocation flags contacts, closes a handover) |
| Programme and campus catalogue | `web_association_catalogue` (0042) | Shared by all associations, managed by operators; programme keys are the group-label paths |
| Promotion requests | `web_association_promotion` + append-only `web_association_promotion_transition` (0043) | Many per association, an operator queue across associations by status and date |
| Calendar events | `web_association_event` + append-only `web_association_event_transition` (0044) | Same, plus the public calendar query |
| Credits | Append-only `web_association_credit_entry` + `web_association_credit_config` (0045) | A ledger, never a JSON field: unique indexes forbid a second debit per request, a second reversal per debit and a second grant per period |
| Retry keys for the tables above | `web_association_command_key` (0043) | Per-account command keys outside the aggregate, purged after 30 days by the cron worker |

Older records gain the new aggregate fields through 0042/0044 backfills and `normalizeRecord` on every read. Migration 0041 also repairs rows that the first release stored as jsonb strings (see below).

### Concurrency

Writes to promotion requests, events and the ledger take a shared lock on the association's registry row (a revocation waits for them, and they recheck membership under it), then an exclusive lock on the request. Credit postings additionally take a per-association advisory lock, so two approvals cannot spend the same balance. Revisions reject stale edits; per-account command keys are rechecked after locking, so a concurrent retry returns the first result instead of applying twice.

### Flows

- **Programmes, campuses, contacts.** `save` validates catalogue entries (retired ones may stay where already listed). `contacts` saves non-public contacts at once and puts public ones into the working profile; history records labels and visibility, never names or phones. `directory` filters contacts per viewer: public for everyone, `associations` for representatives of active associations, all for the association's own representatives and operators.
- **Promotion requests** (`associationPortal.promotions.*`). `draft → submitted → changes_requested → approved → scheduled → published`, exits `rejected` and `withdrawn`. Channels follow RRI art. 4.7. Only the responsible submits. Operators comment (optionally internal), request changes, approve, reject, schedule and mark published with a link; publishing stays manual. Every transition queues the `association-promotion` email.
- **Home** (`associationPortal.home`). Pending actions computed from current state; operator counters for profiles, access, promotions, events and handovers.
- **Events** (`associationPortal.events.*`). `draft → submitted → (changes_requested) → approved`, exits `rejected` and `withdrawn`; public only once approved. `web.associations.getUpcomingEvents` returns approved events not yet over, only for published associations. A promotion request can reference its association's own event.
- **Handover.** `handoverStart`, `handoverConfirm`, `handoverComplete` (optionally leaving), `handoverCancel`; closed automatically when the outgoing responsible leaves or is revoked.
- **Credits** (`associationPortal.credits.*`). Off by default. Rules seeded from RRI art. 4.7 (amounts in hundredths). Approval debits, rejection or withdrawal after approval reverses. Operators grant, adjust and run the semester grant.

### Fixes to the first release

Migration 0041 and the `jsonObject` column type fix a bug in #150: Drizzle's `jsonb()` with Bun SQL stored every app-written registry row as a jsonb *string*, so `published()` dropped changed associations from the website, invitation tokens were never found, and request limits did not count. The invitation lookup also double-encoded its parameter.

### Release notes and deploy order

1. Back up the database. Stop old backend instances, as for #150.
2. Deploy this backend: it runs migrations 0041–0045 on start. 0041 repairs existing rows; 0042 seeds programmes from the group labels (review their humanised names in Associazioni › Corsi e sedi) and the six campuses; 0045 seeds the credit rules **turned off**.
3. Deploy the admin. It parses older responses with defaults, but its new screens need this backend.
4. Deploy the website at any point: it works with the current backend (no filters, no events) and with this one.
5. After release: check one association's public page, an invitation acceptance (the jsonb fix), the catalogue names, and the email outbox with a promotion request in staging.

Nothing here deploys or migrates production automatically. No PoliNetwork Auth change is needed: operators keep `admin:access` + `web:content:write`. A dedicated credits permission is an open proposal.

## Deployment

Coordinate the backend and admin PRs: migrate/deploy backend, then deploy admin. The old admin editor cannot write during the interval. The web PR can precede either because it supports responses without `extraLinks`. Use the normal migration procedure and database backup; these changes do not deploy or migrate production automatically. The migration normalises legacy values to the registry contract (only http(s) links and logos, valid emails). Stop all old backend instances before migrating: writes they make to `web_associations` afterwards are not seen by the registry. Representative names and emails come from the IdP directory, cached for one minute with a fallback to the bare subject. Revoking or leaving cancels that account's pending requests. Rolling back just the application requires care: legacy public rows retain the last approved content even after a registry unpublish, so old readers could expose hidden entries. Restore the coordinated version, not an old reader in isolation.

Keep `ESIGN_DASHBOARD_URL` at `https://admin.polinetwork.org` (shared existing dashboard setting), configure the existing mail transport and Azure Blob storage. The existing cron worker drains the durable outbox every minute; failed messages retry with capped backoff and a stable Message-ID. Sent invite URL bodies are scrubbed. Delivery is at least once: a row is leased briefly, sent outside any transaction, closed as undeliverable (text scrubbed) after 20 attempts, and purged 30 days after delivery. Invites are addressed to the supplied email; approval still targets the account that explicitly accepted.

The admin's `docs/associations/README.md` describes the operator and representative workflow. No Auth repository changes are required: existing OIDC personal accounts and operator permissions are reused.

## Verification

Run `bun run check`, `bun run typecheck`, `bun run test`, `bun run build`. Unit/router tests cover scopes, account isolation, registration versus publication, invitation acceptance, revocation, last-responsible handling, duplicate redirection, revisions and idempotency.

For integration, provide a disposable PostgreSQL server with user/password `seed_test` and `SEED_TEST_DB_PORT`, then run `bun run test tests/associations-postgres.test.ts`. The fixture creates and drops only its own random test database and checks backfill, stable IDs, concurrent create/review, persistence, publication, non-destructive unpublish, the jsonb repair and invitation lookup, the catalogue seed and registry backfill, contact visibility, promotion idempotency and concurrent decisions, event publication with append-only transitions, and concurrent debits with an append-only ledger. `tests/seed-db.test.ts` also needs a `seed_review_test` database on the same server.

`tests/associations-preview.fixture.ts` is a local browser harness, not an application entrypoint: it trusts synthetic test identities and must never be deployed. Real login, email delivery and Blob upload require a staging smoke test with configured external services.
