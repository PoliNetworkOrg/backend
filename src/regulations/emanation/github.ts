import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { App, type Octokit } from "octokit"
import { matchesGlob } from "../compile/assets"

/**
 * What the emanation needs from the legal repository on GitHub. The real one is the GitHub App (Octokit); the fake
 * one simulates CI, merge and the release workflow, for development and tests.
 */
export type PullRequestInfo = {
  number: number
  url: string
  state: "open" | "closed"
  merged: boolean
  mergeSha: string | null
  /** Combined result of the checks on the head commit. */
  checks: "pending" | "success" | "failure"
}

export type ReleaseInfo = { id: number; url: string; assets: { id: number; name: string }[] }

export type LegalGitHub = {
  repo: string
  /** Commits the files under `dir` (replacing the sources matching `sourceGlobs`) on a new branch from `base`. */
  commitToBranch(input: {
    branch: string
    base: string
    dir: string
    sourceGlobs: string[]
    files: Record<string, string>
    message: string
  }): Promise<{ sha: string }>
  findPullRequest(branch: string): Promise<PullRequestInfo | null>
  openPullRequest(input: { branch: string; base: string; title: string; body: string }): Promise<PullRequestInfo>
  /** Auto-merge once CI passes (no review: the approval happened in the dashboard). */
  enableAutoMerge(number: number): Promise<void>
  getPullRequest(number: number): Promise<PullRequestInfo>
  tagSha(tag: string): Promise<string | null>
  createTag(tag: string, sha: string): Promise<void>
  releaseByTag(tag: string): Promise<ReleaseInfo | null>
  uploadAsset(releaseId: number, name: string, content: Uint8Array, contentType: string): Promise<void>
  downloadAsset(assetId: number): Promise<Uint8Array>
  /** A file's text at `ref`, or null. */
  readText(path: string, ref: string): Promise<string | null>
  /** Every file path under `dir` at `ref`. */
  listFiles(dir: string, ref: string): Promise<string[]>
  readBytes(path: string, ref: string): Promise<Uint8Array | null>
  headSha(ref: string): Promise<string>
}

const status = (e: unknown) => (e as { status?: number }).status

export function githubAppClient(options: { appId: string; privateKey: string; repo: string }): LegalGitHub {
  const [owner, repo] = options.repo.split("/")
  const app = new App({ appId: options.appId, privateKey: options.privateKey })
  let cached: { octokit: Octokit; at: number } | null = null
  /** Installation tokens last an hour; the App is installed only on the legal repository. */
  async function gh(): Promise<Octokit> {
    if (cached && Date.now() - cached.at < 30 * 60_000) return cached.octokit
    const { data } = await app.octokit.request("GET /repos/{owner}/{repo}/installation", { owner, repo })
    cached = { octokit: await app.getInstallationOctokit(data.id), at: Date.now() }
    return cached.octokit
  }

  async function checksOf(o: Octokit, sha: string): Promise<PullRequestInfo["checks"]> {
    const { data } = await o.request("GET /repos/{owner}/{repo}/commits/{ref}/check-runs", {
      owner,
      repo,
      ref: sha,
      per_page: 100,
    })
    if (
      data.check_runs.some(
        (r) => r.conclusion === "failure" || r.conclusion === "timed_out" || r.conclusion === "cancelled"
      )
    )
      return "failure"
    if (data.check_runs.length && data.check_runs.every((r) => r.status === "completed")) return "success"
    return "pending"
  }

  async function pr(o: Octokit, number: number): Promise<PullRequestInfo> {
    const { data } = await o.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
      owner,
      repo,
      pull_number: number,
    })
    return {
      number: data.number,
      url: data.html_url,
      state: data.state as "open" | "closed",
      merged: data.merged,
      mergeSha: data.merged ? data.merge_commit_sha : null,
      checks: data.merged ? "success" : await checksOf(o, data.head.sha),
    }
  }

  return {
    repo: options.repo,
    async headSha(ref) {
      const o = await gh()
      const { data } = await o.request("GET /repos/{owner}/{repo}/commits/{ref}", { owner, repo, ref })
      return data.sha
    },
    async commitToBranch(input) {
      const o = await gh()
      try {
        const { data } = await o.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
          owner,
          repo,
          ref: `heads/${input.branch}`,
        })
        return { sha: data.object.sha }
      } catch (e) {
        if (status(e) !== 404) throw e
      }
      const { data: baseRef } = await o.request("GET /repos/{owner}/{repo}/git/ref/{ref}", {
        owner,
        repo,
        ref: `heads/${input.base}`,
      })
      const baseSha = baseRef.object.sha
      const { data: baseCommit } = await o.request("GET /repos/{owner}/{repo}/git/commits/{commit_sha}", {
        owner,
        repo,
        commit_sha: baseSha,
      })
      const { data: tree } = await o.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
        owner,
        repo,
        tree_sha: baseCommit.tree.sha,
        recursive: "1",
      })
      const prefix = `${input.dir.replace(/\/$/, "")}/`
      const entries: { path: string; mode: "100644"; type: "blob"; sha: string | null }[] = []
      for (const item of tree.tree) {
        if (item.type !== "blob" || !item.path?.startsWith(prefix)) continue
        const rel = item.path.slice(prefix.length)
        if (input.sourceGlobs.some((g) => matchesGlob(rel, g)) && !(rel in input.files))
          entries.push({ path: item.path, mode: "100644", type: "blob", sha: null })
      }
      for (const [path, content] of Object.entries(input.files)) {
        const { data: blob } = await o.request("POST /repos/{owner}/{repo}/git/blobs", {
          owner,
          repo,
          content,
          encoding: "utf-8",
        })
        entries.push({ path: prefix + path, mode: "100644", type: "blob", sha: blob.sha })
      }
      const { data: newTree } = await o.request("POST /repos/{owner}/{repo}/git/trees", {
        owner,
        repo,
        base_tree: baseCommit.tree.sha,
        tree: entries,
      })
      const { data: commit } = await o.request("POST /repos/{owner}/{repo}/git/commits", {
        owner,
        repo,
        message: input.message,
        tree: newTree.sha,
        parents: [baseSha],
      })
      await o.request("POST /repos/{owner}/{repo}/git/refs", {
        owner,
        repo,
        ref: `refs/heads/${input.branch}`,
        sha: commit.sha,
      })
      return { sha: commit.sha }
    },
    async findPullRequest(branch) {
      const o = await gh()
      const { data } = await o.request("GET /repos/{owner}/{repo}/pulls", {
        owner,
        repo,
        head: `${owner}:${branch}`,
        state: "all",
      })
      return data[0] ? pr(o, data[0].number) : null
    },
    async openPullRequest(input) {
      const o = await gh()
      const { data } = await o.request("POST /repos/{owner}/{repo}/pulls", {
        owner,
        repo,
        head: input.branch,
        base: input.base,
        title: input.title,
        body: input.body,
      })
      return pr(o, data.number)
    },
    async enableAutoMerge(number) {
      const o = await gh()
      const { data } = await o.request("GET /repos/{owner}/{repo}/pulls/{pull_number}", {
        owner,
        repo,
        pull_number: number,
      })
      try {
        await o.graphql(
          `mutation($id: ID!) { enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: SQUASH }) { clientMutationId } }`,
          { id: data.node_id }
        )
      } catch (e) {
        // Checks already passed ("clean status"): nothing to wait for, merge now.
        if (
          !String((e as Error).message)
            .toLowerCase()
            .includes("clean status")
        )
          throw e
        await o.request("PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge", {
          owner,
          repo,
          pull_number: number,
          merge_method: "squash",
        })
      }
    },
    getPullRequest: async (number) => pr(await gh(), number),
    async tagSha(tag) {
      const o = await gh()
      try {
        const { data } = await o.request("GET /repos/{owner}/{repo}/git/ref/{ref}", { owner, repo, ref: `tags/${tag}` })
        return data.object.sha
      } catch (e) {
        if (status(e) === 404) return null
        throw e
      }
    },
    async createTag(tag, sha) {
      const o = await gh()
      // A tag pushed with the installation token starts the release workflow (GITHUB_TOKEN pushes wouldn't).
      await o.request("POST /repos/{owner}/{repo}/git/refs", { owner, repo, ref: `refs/tags/${tag}`, sha })
    },
    async releaseByTag(tag) {
      const o = await gh()
      try {
        const { data } = await o.request("GET /repos/{owner}/{repo}/releases/tags/{tag}", { owner, repo, tag })
        return { id: data.id, url: data.html_url, assets: data.assets.map((a) => ({ id: a.id, name: a.name })) }
      } catch (e) {
        if (status(e) === 404) return null
        throw e
      }
    },
    async uploadAsset(releaseId, name, content, contentType) {
      const o = await gh()
      await o.request("POST /repos/{owner}/{repo}/releases/{release_id}/assets{?name,label}", {
        owner,
        repo,
        release_id: releaseId,
        name,
        data: Buffer.from(content) as unknown as string,
        headers: { "content-type": contentType },
        baseUrl: "https://uploads.github.com",
      })
    },
    async downloadAsset(assetId) {
      const o = await gh()
      const { data } = await o.request("GET /repos/{owner}/{repo}/releases/assets/{asset_id}", {
        owner,
        repo,
        asset_id: assetId,
        headers: { accept: "application/octet-stream" },
      })
      return new Uint8Array(data as unknown as ArrayBuffer)
    },
    async readText(path, ref) {
      const bytes = await this.readBytes(path, ref)
      return bytes ? new TextDecoder().decode(bytes) : null
    },
    async readBytes(path, ref) {
      const o = await gh()
      try {
        const { data } = await o.request("GET /repos/{owner}/{repo}/contents/{path}", {
          owner,
          repo,
          path,
          ref,
          headers: { accept: "application/vnd.github.raw+json" },
        })
        return typeof data === "string"
          ? new TextEncoder().encode(data)
          : new Uint8Array(data as unknown as ArrayBuffer)
      } catch (e) {
        if (status(e) === 404) return null
        throw e
      }
    },
    async listFiles(dir, ref) {
      const o = await gh()
      const { data: commit } = await o.request("GET /repos/{owner}/{repo}/commits/{ref}", { owner, repo, ref })
      const { data: tree } = await o.request("GET /repos/{owner}/{repo}/git/trees/{tree_sha}", {
        owner,
        repo,
        tree_sha: commit.commit.tree.sha,
        recursive: "1",
      })
      const prefix = `${dir.replace(/\/$/, "")}/`
      return tree.tree
        .filter((i) => i.type === "blob" && i.path?.startsWith(prefix))
        .map((i) => (i.path as string).slice(prefix.length))
    },
  }
}

/**
 * An in-memory legal repository. CI passes (or fails, with `failChecks`) `ciDelayMs` after a PR opens, auto-merge then
 * merges it, and a pushed tag gets a release `releaseDelayMs` later with the assets `buildRelease` returns.
 */
export function fakeGitHub(options: {
  repo?: string
  files?: Record<string, string | Uint8Array>
  ciDelayMs?: number
  releaseDelayMs?: number
  failChecks?: boolean
  buildRelease?: (
    tag: string,
    files: Map<string, string | Uint8Array>
  ) => Promise<{ name: string; content: Uint8Array }[]>
  /** Keeps the repository across restarts (development), as JSON. */
  stateFile?: string
}) {
  let counter = 0
  const sha = () => `fake${String(++counter).padStart(36, "0")}`
  type Snapshot = Map<string, string | Uint8Array>
  const commits = new Map<string, Snapshot>()
  const refs = new Map<string, string>()
  const root = sha()
  commits.set(root, new Map(Object.entries(options.files ?? {})))
  refs.set("heads/main", root)
  const prs: (PullRequestInfo & {
    branch: string
    base: string
    autoMerge: boolean
    openedAt: number
    title: string
    body: string
  })[] = []
  const releases: (ReleaseInfo & { tag: string; files: { id: number; name: string; content: Uint8Array }[] })[] = []
  const log: string[] = []

  type Stored = string | { b64: string }
  const encode = (v: string | Uint8Array): Stored =>
    typeof v === "string" ? v : { b64: Buffer.from(v).toString("base64") }
  const decode = (v: Stored) => (typeof v === "string" ? v : new Uint8Array(Buffer.from(v.b64, "base64")))
  function save() {
    if (!options.stateFile) return
    const data = {
      counter,
      refs: [...refs],
      commits: [...commits].map(([id, files]) => [id, [...files].map(([p, c]) => [p, encode(c)])]),
      prs,
      releases: releases.map((r) => ({ ...r, files: r.files.map((f) => ({ ...f, content: encode(f.content) })) })),
    }
    writeFileSync(options.stateFile, JSON.stringify(data))
  }
  function load() {
    if (!options.stateFile || !existsSync(options.stateFile)) return
    const data = JSON.parse(readFileSync(options.stateFile, "utf8"))
    counter = data.counter
    refs.clear()
    for (const [k, v] of data.refs) refs.set(k, v)
    commits.clear()
    for (const [id, files] of data.commits)
      commits.set(id, new Map(files.map(([p, c]: [string, Stored]) => [p, decode(c)])))
    prs.splice(0, prs.length, ...data.prs)
    releases.splice(
      0,
      releases.length,
      ...data.releases.map(
        (r: Omit<(typeof releases)[number], "files"> & { files: { id: number; name: string; content: Stored }[] }) => ({
          ...r,
          files: r.files.map((f) => ({ ...f, content: decode(f.content) })),
        })
      )
    )
  }

  const tick = (pr: (typeof prs)[number]) => {
    if (pr.merged || pr.state === "closed") return
    if (Date.now() - pr.openedAt < (options.ciDelayMs ?? 0)) return
    pr.checks = options.failChecks ? "failure" : "success"
    if (pr.checks === "success" && pr.autoMerge) {
      const head = commits.get(refs.get(`heads/${pr.branch}`) as string) as Snapshot
      const merged = sha()
      commits.set(merged, new Map(head))
      refs.set(`heads/${pr.base}`, merged)
      Object.assign(pr, { merged: true, state: "closed", mergeSha: merged })
      log.push(`merged #${pr.number}`)
    }
  }
  const view = (pr: (typeof prs)[number]): PullRequestInfo => {
    tick(pr)
    const { number, url, state, merged, mergeSha, checks } = pr
    return { number, url, state, merged, mergeSha, checks }
  }

  const client: LegalGitHub = {
    repo: options.repo ?? "PoliNetworkOrg/legal",
    async headSha(ref) {
      const found = refs.get(`heads/${ref}`) ?? (commits.has(ref) ? ref : null)
      if (!found) throw new Error(`no ref ${ref}`)
      return found
    },
    async commitToBranch(input) {
      const existing = refs.get(`heads/${input.branch}`)
      if (existing) return { sha: existing }
      const base = commits.get(refs.get(`heads/${input.base}`) as string) as Snapshot
      const next = new Map(base)
      const prefix = `${input.dir}/`
      for (const path of [...next.keys()]) {
        const rel = path.startsWith(prefix) ? path.slice(prefix.length) : null
        if (rel !== null && input.sourceGlobs.some((g) => matchesGlob(rel, g)) && !(rel in input.files))
          next.delete(path)
      }
      for (const [path, content] of Object.entries(input.files)) next.set(prefix + path, content)
      const id = sha()
      commits.set(id, next)
      refs.set(`heads/${input.branch}`, id)
      log.push(`commit ${input.branch}`)
      return { sha: id }
    },
    async findPullRequest(branch) {
      const pr = prs.find((p) => p.branch === branch)
      return pr ? view(pr) : null
    },
    async openPullRequest(input) {
      const number = prs.length + 1
      const pr = {
        number,
        url: `https://github.com/${client.repo}/pull/${number}`,
        state: "open" as const,
        merged: false,
        mergeSha: null,
        checks: "pending" as const,
        branch: input.branch,
        base: input.base,
        autoMerge: false,
        openedAt: Date.now(),
        title: input.title,
        body: input.body,
      }
      prs.push(pr)
      log.push(`pr #${number}`)
      return view(pr)
    },
    async enableAutoMerge(number) {
      const pr = prs.find((p) => p.number === number)
      if (!pr) throw new Error("no PR")
      pr.autoMerge = true
      log.push(`auto-merge #${number}`)
    },
    async getPullRequest(number) {
      const pr = prs.find((p) => p.number === number)
      if (!pr) throw Object.assign(new Error("Not Found"), { status: 404 })
      return view(pr)
    },
    async tagSha(tag) {
      return refs.get(`tags/${tag}`) ?? null
    },
    async createTag(tag, target) {
      if (refs.has(`tags/${tag}`)) throw Object.assign(new Error("Reference already exists"), { status: 422 })
      refs.set(`tags/${tag}`, target)
      log.push(`tag ${tag}`)
      setTimeout(async () => {
        const assets = (await options.buildRelease?.(tag, commits.get(target) as Snapshot)) ?? []
        const files = assets.map((a, i) => ({ id: releases.length * 100 + i + 1, name: a.name, content: a.content }))
        releases.push({
          id: releases.length + 1,
          tag,
          url: `https://github.com/${client.repo}/releases/tag/${tag}`,
          assets: files.map(({ id, name }) => ({ id, name })),
          files,
        })
        log.push(`release ${tag}`)
        save()
      }, options.releaseDelayMs ?? 0)
    },
    async releaseByTag(tag) {
      const r = releases.find((x) => x.tag === tag)
      return r ? { id: r.id, url: r.url, assets: r.assets.map((a) => ({ ...a })) } : null
    },
    async uploadAsset(releaseId, name, content) {
      const r = releases.find((x) => x.id === releaseId)
      if (!r) throw new Error("no release")
      if (r.assets.some((a) => a.name === name)) throw Object.assign(new Error("already_exists"), { status: 422 })
      const id = r.id * 100 + r.files.length + 50
      r.files.push({ id, name, content })
      r.assets.push({ id, name })
      log.push(`asset ${name}`)
    },
    async downloadAsset(assetId) {
      for (const r of releases) {
        const f = r.files.find((x) => x.id === assetId)
        if (f) return f.content
      }
      throw new Error("no asset")
    },
    async readText(path, ref) {
      const v = commits.get(await client.headSha(ref))?.get(path)
      return v === undefined ? null : typeof v === "string" ? v : new TextDecoder().decode(v)
    },
    async readBytes(path, ref) {
      const v = commits.get(await client.headSha(ref))?.get(path)
      return v === undefined ? null : typeof v === "string" ? new TextEncoder().encode(v) : v
    },
    async listFiles(dir, ref) {
      const prefix = `${dir}/`
      return [...(commits.get(await client.headSha(ref))?.keys() ?? [])]
        .filter((p) => p.startsWith(prefix))
        .map((p) => p.slice(prefix.length))
    },
  }
  load()
  // A tag whose release hadn't been built when the process stopped gets it now.
  for (const [ref, target] of [...refs]) {
    const tag = ref.startsWith("tags/") ? ref.slice(5) : null
    if (tag && !releases.some((r) => r.tag === tag)) {
      refs.delete(ref)
      void client.createTag(tag, target)
    }
  }
  const persisted = Object.fromEntries(
    Object.entries(client).map(([name, fn]) => [
      name,
      typeof fn === "function"
        ? async (...args: unknown[]) => {
            const result = await (fn as (...a: unknown[]) => Promise<unknown>)(...args)
            save()
            return result
          }
        : fn,
    ])
  ) as LegalGitHub
  return {
    client: persisted,
    prs,
    releases,
    log,
    refs,
    files: (ref = "main") => commits.get(refs.get(`heads/${ref}`) as string) as Snapshot,
  }
}
