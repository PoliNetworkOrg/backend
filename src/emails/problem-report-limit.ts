import { createHash } from "node:crypto"

// Returns 0 when a slot is reserved, or the remaining wait in seconds.
export const problemReportLimitScript = `
local emailTTL = redis.call('PTTL', KEYS[1])
local total = tonumber(redis.call('GET', KEYS[2]) or '0')
if total >= 30 then
  local globalTTL = redis.call('PTTL', KEYS[2])
  return math.max(1, math.ceil(math.max(emailTTL, globalTTL) / 1000))
end
if emailTTL ~= -2 then return math.max(1, math.ceil(emailTTL / 1000)) end
redis.call('SET', KEYS[1], '1', 'EX', 60)
local count = redis.call('INCR', KEYS[2])
if count == 1 then redis.call('EXPIRE', KEYS[2], 3600) end
return 0
`
export function problemReportLimitKeys(email: string) {
  const digest = createHash("sha256").update(email.toLowerCase()).digest("hex")
  return [`website:problem-reports:email:${digest}`, "website:problem-reports:hour"]
}
