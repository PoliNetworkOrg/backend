import { createHash } from "node:crypto"

// Shared across backend instances. Rejected requests do not extend either window.
export const problemReportLimitScript = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
local total = tonumber(redis.call('GET', KEYS[2]) or '0')
if total >= 30 then return 0 end
redis.call('SET', KEYS[1], '1', 'EX', 60)
local count = redis.call('INCR', KEYS[2])
if count == 1 then redis.call('EXPIRE', KEYS[2], 3600) end
return 1
`
export function problemReportLimitKeys(email: string) {
  const digest = createHash("sha256").update(email.toLowerCase()).digest("hex")
  return [`website:problem-reports:email:${digest}`, "website:problem-reports:hour"]
}
