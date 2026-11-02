import assert from "node:assert/strict"
import { generateKeyPairSync } from "node:crypto"
import { githubAppClient } from "@/regulations/emanation/github"

/**
 * The real GitHub App client against a local imitation of the GitHub REST and GraphQL API: App JWT → installation
 * token, git data API commit with deletions, PR, auto-merge, checks, tag, release asset upload and download.
 */
const requests: { method: string; path: string; body: unknown; auth: string }[] = []
let mergedAt = 0
const state = {
  refs: new Map<string, string>([["heads/main", "c0"]]),
  trees: new Map<string, { path: string; type: string; sha: string }[]>([
    [
      "t0",
      [
        { path: "rri/latex/RRI.tex", type: "blob", sha: "b1" },
        { path: "rri/latex/regolamenti/a.tex", type: "blob", sha: "b2" },
        { path: "rri/latex/regolamenti/old.tex", type: "blob", sha: "b3" },
        { path: "rri/latex/fonts/x.ttf", type: "blob", sha: "b4" },
      ],
    ],
  ]),
  commits: new Map<string, { tree: string }>([["c0", { tree: "t0" }]]),
  pulls: [] as { number: number; head: string; merged: boolean; node_id: string }[],
  assets: [] as { id: number; name: string; content: Uint8Array }[],
}

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url)
    const path = decodeURIComponent(url.pathname)
    const raw = req.method === "GET" ? null : new Uint8Array(await req.arrayBuffer())
    let body: unknown = null
    if (raw && (req.headers.get("content-type") ?? "").includes("json"))
      body = JSON.parse(new TextDecoder().decode(raw))
    requests.push({ method: req.method, path: path + url.search, body, auth: req.headers.get("authorization") ?? "" })
    const json = (data: unknown, status = 200) => Response.json(data, { status })
    const repo = "/repos/PoliNetworkOrg/legal"
    if (path === `${repo}/installation`) return json({ id: 42 })
    if (path === "/app/installations/42/access_tokens")
      return json(
        { token: "ghs_installation", expires_at: new Date(Date.now() + 3600_000).toISOString(), permissions: {} },
        201
      )
    let m = new RegExp(`^${repo}/git/ref/(.+)$`).exec(path)
    if (m && req.method === "GET") {
      const sha = state.refs.get(m[1])
      return sha ? json({ ref: `refs/${m[1]}`, object: { sha } }) : json({ message: "Not Found" }, 404)
    }
    m = new RegExp(`^${repo}/git/commits/(.+)$`).exec(path)
    if (m) return json({ sha: m[1], tree: { sha: state.commits.get(m[1])?.tree } })
    m = new RegExp(`^${repo}/git/trees/(.+)$`).exec(path)
    if (m && req.method === "GET") return json({ sha: m[1], tree: state.trees.get(m[1]) ?? [] })
    if (path === `${repo}/git/blobs`) return json({ sha: `blob${requests.length}` }, 201)
    if (path === `${repo}/git/trees`) return json({ sha: "t1" }, 201)
    if (path === `${repo}/git/commits`) {
      state.commits.set("c1", { tree: "t1" })
      return json({ sha: "c1" }, 201)
    }
    if (path === `${repo}/git/refs`) {
      const b = body as { ref: string; sha: string }
      state.refs.set(b.ref.replace(/^refs\//, ""), b.sha)
      return json({ ref: b.ref, object: { sha: b.sha } }, 201)
    }
    if (path === `${repo}/pulls` && req.method === "GET")
      return json(state.pulls.filter((p) => url.searchParams.get("head") === `PoliNetworkOrg:${p.head}`))
    if (path === `${repo}/pulls` && req.method === "POST") {
      const pr = { number: 7, head: (body as { head: string }).head, merged: false, node_id: "PR_node7" }
      state.pulls.push(pr)
      return json({ number: 7 }, 201)
    }
    m = new RegExp(`^${repo}/pulls/(\\d+)$`).exec(path)
    if (m) {
      const pr = state.pulls.find((p) => p.number === Number(m?.[1]))
      if (!pr) return json({}, 404)
      if (mergedAt && Date.now() > mergedAt) pr.merged = true
      return json({
        number: pr.number,
        node_id: pr.node_id,
        html_url: `https://github.com/PoliNetworkOrg/legal/pull/${pr.number}`,
        state: pr.merged ? "closed" : "open",
        merged: pr.merged,
        merge_commit_sha: pr.merged ? "m1" : null,
        head: { sha: "c1" },
      })
    }
    if (path === `${repo}/commits/c1/check-runs`)
      return json({ total_count: 1, check_runs: [{ status: "completed", conclusion: "success" }] })
    if (path === "/graphql") {
      mergedAt = Date.now() + 50
      return json({ data: { enablePullRequestAutoMerge: { clientMutationId: null } } })
    }
    m = new RegExp(`^${repo}/releases/tags/(.+)$`).exec(path)
    if (m)
      return m[1] === "rri-v2026.11.20"
        ? json({
            id: 9,
            html_url: "https://github.com/x/releases/9",
            assets: state.assets.map(({ id, name }) => ({ id, name })),
          })
        : json({}, 404)
    if (path === `${repo}/releases/9/assets` && req.method === "POST") {
      state.assets.push({
        id: 100 + state.assets.length,
        name: url.searchParams.get("name") ?? "",
        content: raw ?? new Uint8Array(),
      })
      return json({ id: 100 }, 201)
    }
    m = new RegExp(`^${repo}/releases/assets/(\\d+)$`).exec(path)
    if (m)
      return new Response(state.assets.find((a) => a.id === Number(m?.[1]))?.content as BodyInit | undefined, {
        headers: { "content-type": "application/octet-stream" },
      })
    return json({ message: `unhandled ${req.method} ${path}` }, 501)
  },
})

const checked: string[] = []
try {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
  const gh = githubAppClient({
    appId: "123",
    privateKey: privateKey.export({ type: "pkcs1", format: "pem" }).toString(),
    repo: "PoliNetworkOrg/legal",
    baseUrl: `http://127.0.0.1:${server.port}`,
  })

  const { sha } = await gh.commitToBranch({
    branch: "regolamenti/rri-abc123",
    base: "main",
    dir: "rri/latex",
    sourceGlobs: ["RRI.tex", "regolamenti/*.tex"],
    files: {
      "RRI.tex": "\\approvazione{direttivo}{2026-11-20}\n",
      "regolamenti/a.tex": "A\n",
      "regolamenti/new.tex": "N\n",
    },
    message: "rri: Prova",
  })
  assert.equal(sha, "c1")
  const appCall = requests.find((r) => r.path.endsWith("/installation"))
  assert.match(appCall?.auth ?? "", /^bearer eyJ/i)
  assert.ok(requests.filter((r) => r.path.includes("/git/")).every((r) => r.auth === "token ghs_installation"))
  const tree = requests.find((r) => r.method === "POST" && r.path.endsWith("/git/trees"))?.body as {
    base_tree: string
    tree: { path: string; sha: string | null }[]
  }
  assert.equal(tree.base_tree, "t0")
  assert.deepEqual(tree.tree.map((e) => [e.path, e.sha === null ? "delete" : "write"]).sort(), [
    ["rri/latex/RRI.tex", "write"],
    ["rri/latex/regolamenti/a.tex", "write"],
    ["rri/latex/regolamenti/new.tex", "write"],
    ["rri/latex/regolamenti/old.tex", "delete"],
  ])
  const commit = requests.find((r) => r.method === "POST" && r.path.endsWith("/git/commits"))?.body as {
    parents: string[]
  }
  assert.deepEqual(commit.parents, ["c0"])
  // Again: the branch exists, nothing is committed twice.
  const before = requests.length
  await gh.commitToBranch({
    branch: "regolamenti/rri-abc123",
    base: "main",
    dir: "rri/latex",
    sourceGlobs: [],
    files: {},
    message: "x",
  })
  assert.equal(requests.slice(before).filter((r) => r.method === "POST").length, 0)
  checked.push("commits the generated sources on a branch with the git data API, deleting removed sources, once")

  assert.equal(await gh.findPullRequest("regolamenti/rri-abc123"), null)
  const pr = await gh.openPullRequest({
    branch: "regolamenti/rri-abc123",
    base: "main",
    title: "RRI: Prova",
    body: "…",
  })
  assert.deepEqual([pr.number, pr.merged, pr.checks], [7, false, "success"])
  assert.equal((await gh.findPullRequest("regolamenti/rri-abc123"))?.number, 7)
  await gh.enableAutoMerge(7)
  const graphql = requests.find((r) => r.path === "/graphql")?.body as { query: string; variables: { id: string } }
  assert.match(graphql.query, /enablePullRequestAutoMerge\(input: \{ pullRequestId: \$id, mergeMethod: SQUASH \}\)/)
  assert.equal(graphql.variables.id, "PR_node7")
  await Bun.sleep(80)
  const merged = await gh.getPullRequest(7)
  assert.deepEqual([merged.merged, merged.mergeSha], [true, "m1"])
  checked.push("opens the PR, enables squash auto-merge through GraphQL, and sees the merge")

  assert.equal(await gh.tagSha("rri-v2026.11.20"), null)
  await gh.createTag("rri-v2026.11.20", "m1")
  assert.equal(await gh.tagSha("rri-v2026.11.20"), "m1")
  assert.equal(await gh.releaseByTag("rri-v2026.11.21"), null)
  const release = await gh.releaseByTag("rri-v2026.11.20")
  assert.equal(release?.id, 9)
  const pdf = new TextEncoder().encode("%PDF-1.7 differenze")
  await gh.uploadAsset(9, "differenze-rri-v2026.11.20.pdf", pdf, "application/pdf")
  const upload = requests.find((r) => r.path.includes("/releases/9/assets"))
  assert.ok(upload?.path.includes("name=differenze-rri-v2026.11.20.pdf"))
  const listed = await gh.releaseByTag("rri-v2026.11.20")
  const asset = listed?.assets.find((a) => a.name === "differenze-rri-v2026.11.20.pdf")
  assert.deepEqual(await gh.downloadAsset(asset?.id as number), pdf)
  checked.push("creates the tag, finds the release, uploads and downloads assets byte for byte")
  console.log(JSON.stringify({ checked }))
} finally {
  server.stop(true)
}
