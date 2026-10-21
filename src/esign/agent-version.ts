/**
 * The oldest PoliNetwork eSign that can sign: 0.2.0 introduced protocol 2. An older agent is refused as soon as it
 * loads a job, before anyone types a PIN; raise it to make every signer update.
 */
export const MIN_AGENT_VERSION = "0.2.0"

type Version = [major: number, minor: number, patch: number]

const parse = (text: string): Version | null => {
  const match = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:[-+][0-9A-Za-z.+-]*)?$/.exec(text)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

/**
 * What `git describe --tags --dirty` adds to a tag for a build made from source: commits since the tag
 * (`v0.1.1-6-g0cb0f7b`) or uncommitted changes (`v0.3.0-dirty`). Release builds carry the bare tag.
 */
const SOURCE_BUILD = /-(?:\d+-g[0-9a-f]{4,40}(?:-dirty)?|dirty)$/

const MIN = parse(MIN_AGENT_VERSION) as Version

/**
 * The version an agent's `User-Agent: PoliNetwork-eSign/<version>` names when it is older than the minimum; null
 * otherwise. A missing or different User-Agent, a development or source build (`dev`, `v0.1.1-6-g0cb0f7b`) or
 * anything unparsable is never too old, so the dashboard and the agent can be deployed in any order; preparing a
 * signature still refuses one without protocol 2. A pre-release counts as its release: `v0.2.0-rc.1` is 0.2.0.
 */
export function outdatedAgent(userAgent: string | null): string | null {
  const text = /^PoliNetwork-eSign\/(\S{1,32})$/.exec(userAgent ?? "")?.[1] ?? ""
  const version = SOURCE_BUILD.test(text) ? null : parse(text)
  if (!version) return null
  const [major, minor, patch] = version
  const older = major !== MIN[0] ? major < MIN[0] : minor !== MIN[1] ? minor < MIN[1] : patch < MIN[2]
  return older ? text.replace(/^v/, "") : null
}
