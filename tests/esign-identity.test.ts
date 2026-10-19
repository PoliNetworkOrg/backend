import { describe, expect, it } from "vitest"
import { fiscalCodeOf } from "@/esign/identity"

describe("fiscalCodeOf", () => {
  it("reads a CIE authentication certificate's CN", () => {
    // The subject of a real CIE 3.0 authentication certificate (SUBCA003), with another person's data.
    const dn = "C=IT\nSN=ROSSI\nGN=MARIO\nserialNumber=IDCIT-CA00000AA\nCN=RSSMRA80A01F205X/041001234567"
    expect(fiscalCodeOf(dn)).toBe("RSSMRA80A01F205X")
  })

  it("reads serialNumber TINIT-", () => {
    expect(fiscalCodeOf("C=IT\nserialNumber=TINIT-RSSMRA80A01F205X\nCN=MARIO ROSSI")).toBe("RSSMRA80A01F205X")
  })

  it("accepts an omocodic code", () => {
    expect(fiscalCodeOf("CN=RSSMRA80A01F20RX/041001234567")).toBe("RSSMRA80A01F20RX")
  })

  it("ignores anything that is not a fiscal code", () => {
    expect(fiscalCodeOf("serialNumber=IDCIT-CA00000AA\nCN=MARIO ROSSI")).toBeNull()
    expect(fiscalCodeOf("CN=041001234567/RSSMRA80A01F205X")).toBeNull()
    expect(fiscalCodeOf("serialNumber=TINIT-12345")).toBeNull()
  })
})
