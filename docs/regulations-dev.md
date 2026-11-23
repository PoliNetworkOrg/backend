# Regulations editor: local stack

Runs the backend, the collab service, the LaTeX worker, Postgres and a stand-in for PoliNetwork Auth on one machine,
with the documents imported from a clone of the documents repository (PoliNetworkOrg/documents, formerly `legal`). What
the documents are (kinds, procedures, private documents, templates): [regulations-documents.md](regulations-documents.md).

| Service | Where | Port |
| --- | --- | --- |
| Postgres | docker compose | 54329 |
| LaTeX worker (sandboxed like in the cluster) | docker compose | 4200 |
| dev IdP (JWKS, token, access snapshot, directory) | host | 4300 |
| backend (tRPC at `/api/trpc`) | host | 3000 |
| collab service (websocket / internal API) | host | 4100 / 4101 |

## Once

```sh
# A clone of the documents repository with documents.json v2 (any path; the default is ../documents next to this
# repository, or ../legal when only that exists).
git clone https://github.com/PoliNetworkOrg/documents.git /tmp/regs-documents
# Until ghcr.io/polinetworkorg/legal-texlive is published, build it from the repository:
docker build -t ghcr.io/polinetworkorg/legal-texlive:local /tmp/regs-documents/docker/texlive
bun install
```

## Start

```sh
TEXLIVE_IMAGE=ghcr.io/polinetworkorg/legal-texlive:local \
  docker compose -f docker/regulations-dev.compose.yaml up -d --build
REGULATIONS_LEGAL_DIR=/tmp/regs-documents bun run regulations:dev     # idp + backend + collab, logs prefixed
REGULATIONS_LEGAL_DIR=/tmp/regs-documents bun run regulations:seed    # in another terminal, once
```

The seed imports `documents.json`: every document, with its current sources as the first published version. It then creates three drafts, assigns
`dev-editor` (editor) and `dev-commenter` (commenter) to each, and makes A and B change the same comma (a merge
conflict), while C changes another article. It prints the draft ids.

## Accounts and tokens

`scripts/regulations/dev-accounts.json`:

| Account | Permissions |
| --- | --- |
| `dev-segretario` | `regulations:read`, `regulations:write`, `regulations:manage`, `regulations:rectify` |
| `dev-presidente` | `regulations:read`, `regulations:write`, `regulations:manage` |
| `dev-direttivo` | `regulations:read`, `regulations:write` |
| `dev-editor`, `dev-commenter`, `dev-delegato` | none; they only have draft assignments |
| `dev-admin` | `admin:access`, `people:read`, `tg:users:read`; no `regulations:*` and no assignments |

The first three also hold `admin:access`. `dev-admin` is a dashboard admin who sees nothing of the regulations
but the published texts.

```sh
bun run regulations:token dev-segretario              # a bearer token, valid 2 hours (auth-kit's maximum age)
curl 'http://localhost:4300/dev/token?sub=dev-editor'  # the same, over HTTP
```

The in-memory GitHub starts from the checkout's `documents.json`, so `documents.create` with storage `repo` opens a pull
request against it, which its fake CI merges after 3 seconds; publications and emanations get a release whose PDF the
worker compiles. Its state is kept in `.dev-idp/fake-github.json`: delete the file to start over.

Tokens have `aud=https://backend.internal.polinetwork.org`, `scope=backend:admin`, and carry `name` and `email`. The
shim refuses to run with `NODE_ENV=production` and checks no client assertion: never point a deployed backend at it.
