import { constants, createPrivateKey, sign as rsaSign, webcrypto, X509Certificate } from "node:crypto"
import { describe, expect, it } from "vitest"
import { children, contextTag, integer, nullValue, octetString, oid, read, sequence, tlv } from "@/esign/pdf/der"
import { buildOcspRequest, checkRevocation, parseOcspResponse } from "@/esign/trust/ocsp"
import { createTestCa } from "./esign-fixtures"

const ca = await createTestCa()
const leaf = await ca.issue("ROSSI MARIO", "RSSMRA80A01F205X")
const issuer = new X509Certificate(Buffer.from(ca.cert.rawData))
const cert = new X509Certificate(Buffer.from(leaf.cert))
const caKey = createPrivateKey({
  key: Buffer.from(await webcrypto.subtle.exportKey("pkcs8", ca.keys.privateKey)),
  format: "der",
  type: "pkcs8",
})

const time = (d: Date) => tlv(0x18, new TextEncoder().encode(`${d.toISOString().replace(/[-:T]/g, "").slice(0, 14)}Z`))
const now = new Date()

/** A BasicOCSPResponse for the request's CertID, signed by the test CA. */
function response(
  opts: { status?: "good" | "revoked"; nextUpdate?: Date; serialDelta?: boolean; tamper?: boolean } = {}
) {
  // OCSPRequest → tbsRequest → requestList → Request → CertID
  const [tbsRequest] = children(read(buildOcspRequest(cert, issuer)))
  let certId: Uint8Array = children(children(children(tbsRequest)[0])[0])[0].raw
  if (opts.serialDelta)
    certId = sequence(
      sequence(oid("1.3.14.3.2.26"), nullValue()),
      octetString(new Uint8Array(20)),
      octetString(new Uint8Array(20)),
      integer(42)
    )
  const status =
    opts.status === "revoked" ? contextTag(1, time(new Date(now.getTime() - 86_400_000))) : new Uint8Array([0x80, 0x00])
  const single = sequence(
    certId,
    status,
    time(new Date(now.getTime() - 60_000)),
    ...(opts.nextUpdate ? [contextTag(0, time(opts.nextUpdate))] : [])
  )
  const tbs = sequence(contextTag(1, sequence()), time(now), sequence(single))
  const signature = rsaSign("sha256", tbs, { key: caKey, padding: constants.RSA_PKCS1_PADDING })
  if (opts.tamper) signature[0] ^= 1
  const basic = sequence(
    tbs,
    sequence(oid("1.2.840.113549.1.1.11"), nullValue()),
    tlv(0x03, new Uint8Array([0]), signature)
  )
  return sequence(
    tlv(0x0a, new Uint8Array([0])),
    contextTag(0, sequence(oid("1.3.6.1.5.5.7.48.1.1"), octetString(basic)))
  )
}

describe("OCSP", () => {
  it("reads good and revoked statuses signed by the issuer", () => {
    const result = parseOcspResponse(response(), cert, issuer, now)
    expect(result.detail).toBe(null)
    expect(result).toMatchObject({ status: "good" })
    expect(parseOcspResponse(response({ status: "revoked" }), cert, issuer, now).status).toBe("revoked")
  })

  it("treats forged, stale or foreign responses as unknown", () => {
    expect(parseOcspResponse(response({ tamper: true }), cert, issuer, now).status).toBe("unknown")
    expect(
      parseOcspResponse(response({ nextUpdate: new Date(now.getTime() - 3_600_000) }), cert, issuer, now).status
    ).toBe("unknown")
    expect(parseOcspResponse(response({ serialDelta: true }), cert, issuer, now).status).toBe("unknown")
  })

  it("posts the request and survives network failures", async () => {
    let posted: Uint8Array | null = null
    const ok = await checkRevocation(cert, issuer, {
      now,
      defaultUrl: "https://ocsp.example",
      fetch: (async (_url: string, init: RequestInit) => {
        posted = new Uint8Array(init.body as Buffer)
        return new Response(Buffer.from(response()))
      }) as unknown as typeof fetch,
    })
    expect(ok.status).toBe("good")
    expect(posted).toEqual(buildOcspRequest(cert, issuer))
    const down = await checkRevocation(cert, issuer, {
      now,
      defaultUrl: "https://ocsp.example",
      fetch: (async () => {
        throw new Error("ECONNREFUSED")
      }) as unknown as typeof fetch,
    })
    expect(down).toMatchObject({ status: "unknown", detail: "ECONNREFUSED" })
  })
})
