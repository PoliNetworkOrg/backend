import { describe, expect, it } from "vitest"
import { CIE_ISSUING_CAS } from "@/esign/trust"
import { CIE_CA_PEM } from "@/esign/trust/cie-ca"

describe("CIE trust anchors", () => {
  it("pins the published issuing CAs", () => {
    const names = CIE_ISSUING_CAS.map((c) => /CN=([^\n]+)/.exec(c.subject)?.[1])
    expect(names).toEqual(
      expect.arrayContaining([
        expect.stringContaining("SUBCA1"),
        expect.stringContaining("SUBCA002"),
        expect.stringContaining("SUBCA003"),
      ])
    )
    expect(CIE_CA_PEM).toContain("NationalrootCAfortheItalianElectronicIdentityCard")
  })
})
