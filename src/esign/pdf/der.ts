/** Minimal DER encoding and decoding, enough for CMS SignedData and X.509 field extraction. */

export type Tlv = {
  tag: number
  /** The whole element, header included. */
  raw: Uint8Array
  /** The content octets. */
  value: Uint8Array
}

function lengthBytes(n: number): number[] {
  if (n < 0x80) return [n]
  const out: number[] = []
  for (let v = n; v > 0; v = Math.floor(v / 256)) out.unshift(v & 0xff)
  return [0x80 | out.length, ...out]
}

export function tlv(tag: number, ...content: Uint8Array[]): Uint8Array {
  const len = content.reduce((n, c) => n + c.length, 0)
  const header = [tag, ...lengthBytes(len)]
  const out = new Uint8Array(header.length + len)
  out.set(header, 0)
  let pos = header.length
  for (const c of content) {
    out.set(c, pos)
    pos += c.length
  }
  return out
}

export const sequence = (...items: Uint8Array[]) => tlv(0x30, ...items)
export const octetString = (bytes: Uint8Array) => tlv(0x04, bytes)
export const nullValue = () => new Uint8Array([0x05, 0x00])
/** Context-specific constructed `[n]` (IMPLICIT when wrapping the content of a SET/SEQUENCE, EXPLICIT otherwise). */
export const contextTag = (n: number, ...items: Uint8Array[]) => tlv(0xa0 | n, ...items)

export function integer(n: number): Uint8Array {
  const bytes: number[] = []
  let v = n
  do {
    bytes.unshift(v & 0xff)
    v = Math.floor(v / 256)
  } while (v > 0)
  if (bytes[0] & 0x80) bytes.unshift(0)
  return tlv(0x02, new Uint8Array(bytes))
}

export function oid(dotted: string): Uint8Array {
  const parts = dotted.split(".").map(Number)
  const bytes: number[] = [40 * parts[0] + parts[1]]
  for (const part of parts.slice(2)) {
    const chunk: number[] = []
    let v = part
    do {
      chunk.unshift(v & 0x7f)
      v = Math.floor(v / 128)
    } while (v > 0)
    for (let i = 0; i < chunk.length - 1; i++) chunk[i] |= 0x80
    bytes.push(...chunk)
  }
  return tlv(0x06, new Uint8Array(bytes))
}

function compare(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i] - b[i]
  return a.length - b.length
}

/** DER SET OF: elements sorted by their encodings (X.690 §11.6). */
export function setOf(...items: Uint8Array[]): Uint8Array {
  return tlv(0x31, ...[...items].sort(compare))
}

/** Reads one element at `offset`. */
export function read(bytes: Uint8Array, offset = 0): Tlv & { end: number } {
  const tag = bytes[offset]
  if (tag === undefined) throw new Error("DER: unexpected end")
  if ((tag & 0x1f) === 0x1f) throw new Error("DER: high tag numbers are not supported")
  let pos = offset + 1
  let len = bytes[pos++]
  if (len === undefined) throw new Error("DER: unexpected end")
  if (len & 0x80) {
    const count = len & 0x7f
    if (count === 0 || count > 4) throw new Error("DER: unsupported length")
    len = 0
    for (let i = 0; i < count; i++) len = len * 256 + bytes[pos++]
  }
  const end = pos + len
  if (end > bytes.length) throw new Error("DER: element overruns its parent")
  return { tag, raw: bytes.subarray(offset, end), value: bytes.subarray(pos, end), end }
}

/** The children of a constructed element. */
export function children(element: Tlv): Tlv[] {
  const out: Tlv[] = []
  let pos = 0
  while (pos < element.value.length) {
    const child = read(element.value, pos)
    out.push(child)
    pos = child.end
  }
  return out
}

/** Dotted form of an OBJECT IDENTIFIER element. */
export function oidString(element: Tlv): string {
  const v = element.value
  const parts = [Math.floor(v[0] / 40), v[0] % 40]
  let n = 0
  for (const byte of v.subarray(1)) {
    n = n * 128 + (byte & 0x7f)
    if (!(byte & 0x80)) {
      parts.push(n)
      n = 0
    }
  }
  return parts.join(".")
}

/** The issuer Name and serialNumber INTEGER of a certificate, as their original DER encodings. */
export function issuerAndSerial(certDer: Uint8Array): { issuer: Uint8Array; serial: Uint8Array } {
  const tbs = children(children(read(certDer))[0])
  // tbsCertificate: [0] version (optional), serialNumber, signature, issuer, ...
  const fields = tbs[0].tag === 0xa0 ? tbs.slice(1) : tbs
  return { serial: fields[0].raw, issuer: fields[2].raw }
}
