# Contributing to the PoliNetwork backend

This guide gets a development environment ready for the backend. The [README](README.md) explains how the backend
works: authentication, People, the audit log and the e-signing service.

Since RFC v3 Phase 5 every call needs an access token from [PoliNetwork Auth](https://github.com/PoliNetworkOrg/auth):
without one the backend answers `UNAUTHORIZED`. The tests need none of this, but to call the backend yourself, for
example from the [admin dashboard](https://github.com/PoliNetworkOrg/admin), you also run Auth locally and connect the
two ([below](#connect-it-to-auth)).

## Prerequisites

- **Git**.
- **[Bun](https://bun.sh)** 1.x, which runs the backend, its scripts and installs packages.
- **Docker** with Compose, for the local PostgreSQL and Redis.
- **Node** 22, only to generate the key pair when [connecting to Auth](#connect-it-to-auth).

## Set up the backend

```sh
git clone git@github.com:PoliNetworkOrg/backend.git
cd backend
bun install
docker compose up -d --wait
```

`compose.yaml` starts PostgreSQL on `localhost:55433` and Redis on `localhost:56379`, reachable only from your machine.

Create `.env` (Bun loads it automatically). `src/env.ts` is the source of truth for every variable.

```sh
# Local services from compose.yaml
DB_HOST=localhost
DB_PORT=55433
DB_USER=postgres
DB_PASS=postgres
DB_NAME=polinetwork_backend
REDIS_HOST=localhost
REDIS_PORT=56379

# Encrypts stored Telegram data. Generate with: openssl rand -hex 32
ENCRYPTION_KEY=

# Links in signature emails point here instead of the production dashboard.
ESIGN_DASHBOARD_URL=http://localhost:3001
```

Then apply the migrations and start the server:

```sh
bun db:migrate
bun dev
```

The backend listens on **http://localhost:3000**. Without the Auth settings below it starts, logs
`Token authentication is not configured: every request is rejected`, and refuses every call.

Optionally, fill the database with sample data (Telegram users, groups and messages, course groups and labels, website
content, reports, audit log entries and grants):

```sh
bun run seed:db
```

Microsoft 365 is optional: without `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` and `AZURE_CLIENT_SECRET` the Azure routes use a
seeded in-memory directory, reset at every restart, and the e-signing service uses in-memory drives.

## Connect it to Auth

Follow [Connect the local stack](https://github.com/PoliNetworkOrg/auth/blob/main/CONTRIBUTING.md#connect-the-local-stack)
in Auth's guide: it sets up Auth, generates the backend's key pair and registers the backend as an application. Then
add to the backend's `.env`:

```sh
IDP_PUBLIC_URL=http://localhost:3003
# The same identifiers as in Auth's .env.local.
OAUTH_BACKEND_RESOURCE_URI=https://backend.internal.polinetwork.org
OAUTH_INTERNAL_RESOURCE_URI=https://localhost:3003/api/internal
# The backend application registered in Auth, and the private key generated for it.
OAUTH_BACKEND_CLIENT_ID=
OAUTH_BACKEND_PRIVATE_JWK=
```

Restart `bun dev`. The backend now verifies tokens issued by your local Auth and pulls its access snapshot every
30 seconds, so a permission given in Auth applies here within that time (at once if Auth has `OAUTH_BACKEND_EVENTS_URL`
set). To call it with a real user, run the [admin dashboard](https://github.com/PoliNetworkOrg/admin/blob/main/CONTRIBUTING.md)
and sign in there.

## Everyday commands

| Command              | What it does                                                                       |
| -------------------- | ---------------------------------------------------------------------------------- |
| `bun dev`            | Development server on http://localhost:3000, restarted on every change             |
| `bun run test`       | Tests (Vitest). They need neither Docker nor Auth                                  |
| `bun run typecheck`  | TypeScript checks                                                                  |
| `bun run check`      | Formatting and lint (Biome); `bun run check:fix` applies the fixes                 |
| `bun db:generate`    | Generates a Drizzle migration after a change to `src/db/schema`                    |
| `bun db:migrate`     | Applies the migrations                                                             |
| `bun run seed:db`    | Sample data; each table only while empty, `--force` replaces the sample content    |
| `bun run email`      | Previews the email templates on http://localhost:3012                              |
| `docker compose down`| Stops PostgreSQL and Redis; add `-v` to also delete their data                     |

Three PostgreSQL suites (`seed-db`, `people-postgres`, `freshman.integration`) are skipped unless
`SEED_TEST_DB_PORT` or `FRESHMAN_TEST_DB_PORT` points at a disposable test database.

Change the database only through migrations (`db:generate`, then `db:migrate`). `db:push` changes the schema without
recording a migration, so a later `db:migrate` fails on changes that already exist.

## Pull requests

- Run `bun run typecheck`, `bun run test` and `bun run check` before pushing: CI runs the same.
- Every tRPC procedure is built with `policy(...)` from `src/trpc.ts`, which declares who may call it;
  `tests/idp-router.test.ts` fails on a procedure without one.
- A schema change ships with its generated migration in `drizzle/`.
- Use [Conventional Commits](https://www.conventionalcommits.org) for commit messages:
  `<type>[optional scope][!]: <description>`, with an accurate type (`feat`, `fix`, `docs`, `refactor`, `test`, `build`,
  `ci`, `chore`), a body when the change needs context, and `!` or a `BREAKING CHANGE:` footer for breaking changes.
  Releases are cut from these messages.
