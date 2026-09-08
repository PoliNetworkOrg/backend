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

## Audit log input

The bot must send one `tg.auditLog.create` event per audit record. Every event
must include `category`; the backend uses it to select the destination table.
Do not send the old aggregate `{ type: "delete", preDeleteRes: ... }` format.

For `/del`, send one request for each successfully deleted message:

```json
{
   "category": "deleted",
   "messageId": 12345,
   "chatId": -1004404085898,
   "authorId": 402072799,
   "author": {
      "id": 402072799,
      "is_bot": false,
      "first_name": "Invy55",
      "username": "proporre"
   },
   "deletedById": 7298979523,
   "deletedBy": {
      "id": 7298979523,
      "is_bot": false,
      "first_name": "itasimo",
      "username": "itasimo_js",
      "language_code": "it"
   },
   "deletedAt": "2026-09-08T16:58:36.000Z",
   "reason": "Command /del",
   "source": "manual"
}
```

Other events use the same `category` discriminator: `moderation`, `ban_all`,
`exception`, `group_management`, or `grant`. Their category-specific fields
are defined by the `tg.auditLog.create` input schema.
