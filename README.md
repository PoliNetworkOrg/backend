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
