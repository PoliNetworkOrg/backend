# Backend

> [!NOTE]
>
> ### WIP
>
> This is a rewrite currently WIP that will take time. Drink a coffee and join us if you would like to contribute.

Currently we are building a backend which can be reached by other services/repos with a tRPC client.
If you are using another language than TS... then you might fullfil a PR and implement gRPC (are you sure u want pain?).

## Quickstart

Requirements:

- Bun installed
- A Postgres database
- An Azure App Registration
  NOTE: you can skip this by making `AZURE_*` env optional in `./src/env.ts`
  and by removing all Azure related auth in `./src/azure/`

1. Install packages
   ```sh
   bun install
   ```
2. Setup environment variables (use `.env.example` and `./src/env.ts` for reference)
3. Run the server
   ```sh
   bun dev
   ```
