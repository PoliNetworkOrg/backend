import { type CipherGCMTypes, createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto"
import { env } from "@/env"

// Define your encryption algorithm and key size
const ALGORITHM: CipherGCMTypes = "aes-256-gcm" // Using AES-256 in GCM mode
const KEY_SIZE = 32 // 256 bits for AES-256
const IV_SIZE = 12 // Standard size for AES-GCM IV

// Ensure the key is the correct size and in a usable format (Buffer)
const ENCRYPTION_KEY_BUFFER = Buffer.from(env.ENCRYPTION_KEY, "hex")

export class DecryptError extends Error { }

export class Cipher {
  private key: Buffer
  private static usedSalts: Set<string> = new Set()

  constructor(salt: string) {
    if (Cipher.usedSalts.has(salt)) throw new Error("This salt is already chosen, use another one, stupid!")
    this.key = Cipher.saltKey(salt)

    if (this.key.length !== KEY_SIZE) {
      // this should NEVER NEVER happen, but I dont trust them
      throw new Error("Invalid encryption key size.")
    }

    Cipher.usedSalts.add(salt)
  }

  private static saltKey(salt: string): Buffer {
    return pbkdf2Sync(ENCRYPTION_KEY_BUFFER, salt, 100_000, KEY_SIZE, "sha256")
  }

  /**
   * Encrypts a string with aes-256-gcm.
   *
   * @param text The message content to encrypt.
   * @returns A promise that resolves with the encrypted string (hexadecimal).
   * @throws Error if encryption fails
   */
  async encrypt(text: string): Promise<string> {
    if (!text) return "" // Handle empty strings gracefully

    const iv = randomBytes(IV_SIZE)
    const cipher = createCipheriv(ALGORITHM, this.key, iv)

    let encrypted = cipher.update(text, "utf8", "hex")
    encrypted += cipher.final("hex")

    // Get the authentication tag (required for GCM)
    const tag = cipher.getAuthTag()

    // Combine IV, encrypted text, and tag for storage.
    // We use a separator to easily split them during decryption.
    return `${iv.toString("hex")}:${encrypted}:${tag.toString("hex")}`
  }

  /**
   * Decrypts an encrypted string.
   *
   * @param encryptedPayload The encrypted content string (hexadecimal).
   * @returns A promise that resolves with the decrypted message content.
   * @throws Error if decryption fails.
   */
  async decrypt(encryptedPayload: string): Promise<string> {
    if (!encryptedPayload) {
      return "" // Handle empty strings gracefully
    }

    const parts = encryptedPayload.split(":")
    if (parts.length !== 3) {
      throw new DecryptError("Invalid encrypted payload format.")
    }

    const iv = Buffer.from(parts[0], "hex")
    const encryptedText = parts[1]
    const tag = Buffer.from(parts[2], "hex")

    if (iv.length !== IV_SIZE) {
      throw new DecryptError("Invalid IV size during decryption.")
    }

    const decipher = createDecipheriv(ALGORITHM, this.key, iv)
    decipher.setAuthTag(tag) // Set the authentication tag

    let decrypted = decipher.update(encryptedText, "hex", "utf8")
    decrypted += decipher.final("utf8")

    return decrypted
  }
}
