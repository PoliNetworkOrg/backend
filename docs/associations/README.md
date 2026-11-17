# Association registry API and release

`associationPortal.*` is a user-only `backend:admin` API. Any authenticated user can apply; per-record membership is checked server-side on every mutation. Operators need both `admin:access` and `web:content:write`. No global permissions are granted to representatives.

The registry separates association identity, active membership, review requests and the approved public profile. Registration and access approval do not publish content. Content approval atomically changes the published profile. Invitations are single-use, expire after 14 days and store only token hashes in registry state; accepting binds the actual account but requires operator approval. Notes and other applicants' evidence are filtered from scoped responses. Explicit withdrawal revokes invitation tokens.

Migration `0040_association_portal.sql` backfills existing public associations with distinct UUIDs and preserves numeric catalog IDs, profiles and publication. All imported entries start without representatives. JSON state and its mail outbox are updated within PostgreSQL transactions; row locks serialize decisions, revisions detect stale edits, and per-account command keys support retries. Duplicate registrations can be redirected atomically to access requests on an existing association. No destructive record deletion is exposed.

`web.associations.getAllAssociations` retains the existing public response and adds `extraLinks` for repeated platform links (including Twitch). It reads only published registry snapshots, never private working profiles, notes, membership or evidence. Legacy mutation procedures now return `PRECONDITION_FAILED`; callers must use the reviewed registry.

## Deployment

Coordinate the backend and admin PRs: migrate/deploy backend, then deploy admin. The old admin editor cannot write during the interval. The web PR can precede either because it supports responses without `extraLinks`. Use the normal migration procedure and database backup; these changes do not deploy or migrate production automatically. Rolling back just the application requires care: legacy public rows retain the last approved content even after a registry unpublish, so old readers could expose hidden entries. Restore the coordinated version, not an old reader in isolation.

Keep `ESIGN_DASHBOARD_URL` at `https://admin.polinetwork.org` (shared existing dashboard setting), configure the existing mail transport and Azure Blob storage. The existing cron worker drains the durable outbox every minute; failed messages retry with capped backoff and a stable Message-ID. Sent invite URL bodies are scrubbed. Delivery is at least once. Invites are addressed to the supplied email; approval still targets the account that explicitly accepted.

The admin's `docs/associations/README.md` describes the operator and representative workflow. No Auth repository changes are required: existing OIDC personal accounts and operator permissions are reused.

## Verification

Run `bun run check`, `bun run typecheck`, `bun run test`, `bun run build`. Unit/router tests cover scopes, account isolation, registration versus publication, invitation acceptance, revocation, last-responsible handling, duplicate redirection, revisions and idempotency.

For integration, provide a disposable PostgreSQL server with user/password `seed_test` and `SEED_TEST_DB_PORT`, then run `bun run test tests/associations-postgres.test.ts`. The fixture creates and drops only its own random test database and checks backfill, stable IDs, concurrent create/review, persistence, publication and non-destructive unpublish.

`tests/associations-preview.fixture.ts` is a local browser harness, not an application entrypoint: it trusts synthetic test identities and must never be deployed. Real login, email delivery and Blob upload require a staging smoke test with configured external services.
