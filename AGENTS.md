# Agent instructions

## Git commits

Use Conventional Commits for every commit message:

```text
<type>[optional scope][!]: <description>
```

Choose an accurate type such as `feat`, `fix`, `docs`, `refactor`, `test`,
`build`, `ci`, or `chore`. Add a body when the change needs context. Mark
breaking changes with `!` or a `BREAKING CHANGE:` footer.

## Audit log

Every tRPC mutation is recorded in `common_audit_events` by the audit middleware in `src/trpc.ts`; see "Audit log" in
`README.md` and the types in `src/audit/option.ts`. When you add or change a mutation:

- Declare how it is recorded in its procedure meta, next to its policy: `audit.full({ fields?, target? })`,
  `audit.minimal({ target? })` or `audit.none(why)`. A test fails on a mutation without one. Use `minimal` only where
  the area keeps its own history behind its own permissions, and `none` only with a `why` (the bot's ingestion,
  moderation in `tg_audit_log`).
- Keep inputs that carry personal data, free text, file contents or caller-chosen blobs out of the event with a
  `fields` allowlist: only scalar values of the listed fields are kept.
- Name what changed. Call `ctx.audit.set({ target: { type: "<area>.<thing>", id, label }, before, after })` in the
  handler, or pass `target` in the meta when the raw input (unvalidated, possibly `FormData`) or the result is enough.
  Read `before` in the same transaction as the write, and set `after` from what was saved, not from the input.
- Fields named like secrets (`key`, `code`, `token`, `ticket`, `password`, `*Key`, `*Secret`, ...) are stored as
  `(hidden)`. If such a field identifies a record (a document's `key`), name it as the target instead.
- Call `ctx.audit.skip()` when a call changed nothing. A handler that returns `false`, `{ error }` or
  `{ success: false }` is recorded as a failure.
- A new top-level router is a new area: add it to `AUDIT_AREAS` in `src/routers/audit.ts`.
- Changes made outside tRPC (webhooks, cron jobs, workers, socket handlers) are not recorded. If a feature adds one,
  list it under "Audit log" in `README.md`, or record it explicitly.
- Test what the event keeps: mock `@/audit/store` and assert on the target, input and states (see
  `tests/idp-router.test.ts`).
