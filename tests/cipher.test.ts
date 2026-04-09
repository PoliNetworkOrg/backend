import { beforeAll, beforeEach, describe, expect, it } from "vitest"

let Cipher: typeof import("@/utils/cipher").Cipher
let DecryptError: typeof import("@/utils/cipher").DecryptError

const TEST_ENV: Record<string, string> = {
	NODE_ENV: "test",
	BETTER_AUTH_SECRET: "test-secret-with-at-least-thirty-two-characters",
	ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
	DB_HOST: "localhost",
	DB_PORT: "5432",
	DB_USER: "postgres",
	DB_PASS: "postgres",
	DB_NAME: "polinetwork_backend_test",
	AZURE_TENANT_ID: "tenant",
	AZURE_CLIENT_ID: "client",
	AZURE_CLIENT_SECRET: "secret",
	AZURE_EMAIL_SENDER: "noreply@example.com",
}

const DETERMINISTIC_PAYLOAD =
	"000000000000000000000000:092f3bf7c5a35fdd138797a99288c13436fd3bc2ef2e8a56e788:67e19f6b04eadf1f3dc0ee7c39221318"

function setRequiredEnvVars() {
	for (const [key, value] of Object.entries(TEST_ENV)) {
		process.env[key] = value
	}
}

function resetUsedSalts() {
	;(Cipher as unknown as { usedSalts: Set<string> }).usedSalts.clear()
}

beforeAll(async () => {
	setRequiredEnvVars()
	const mod = await import("@/utils/cipher")
	Cipher = mod.Cipher
	DecryptError = mod.DecryptError
})

beforeEach(() => {
	resetUsedSalts()
})

describe("Cipher", () => {
	it("encrypts and decrypts text correctly", () => {
		const cipher = new Cipher("roundtrip-salt")
		const plainText = "The quick brown fox jumps over 13 lazy dogs"

		const encrypted = cipher.encrypt(plainText)
		const decrypted = cipher.decrypt(encrypted)

		expect(decrypted).toBe(plainText)
	})

	it("returns empty string for empty input in both directions", () => {
		const cipher = new Cipher("empty-salt")

		expect(cipher.encrypt("")).toBe("")
		expect(cipher.decrypt("")).toBe("")
	})

	it("is deterministic for same salt and plaintext", () => {
		const cipher = new Cipher("deterministic-salt")
		const plainText = "hello deterministic cipher"

		const first = cipher.encrypt(plainText)
		const second = cipher.encrypt(plainText)

		expect(first).toBe(second)
		expect(first).toBe(DETERMINISTIC_PAYLOAD)
	})

	it("produces different ciphertext for different plaintext", () => {
		const cipher = new Cipher("different-text-salt")

		const first = cipher.encrypt("message one")
		const second = cipher.encrypt("message two")

		expect(first).not.toBe(second)
	})

	it("has stable payload format iv:ciphertext:tag", () => {
		const cipher = new Cipher("payload-format-salt")
		const encrypted = cipher.encrypt("format-check")
		const parts = encrypted.split(":")

		expect(parts).toHaveLength(3)
		expect(parts[0]).toBe("000000000000000000000000")
		expect(parts[1]).toMatch(/^[a-f0-9]+$/)
		expect(parts[2]).toMatch(/^[a-f0-9]{32}$/)
	})

	it("throws when reusing the same salt", () => {
		new Cipher("duplicate-salt")

		expect(() => new Cipher("duplicate-salt")).toThrow(
			"This salt is already chosen, use another one, stupid!"
		)
	})

	it("throws DecryptError on invalid payload format", () => {
		const cipher = new Cipher("invalid-format-salt")

		expect(() => cipher.decrypt("not-a-valid-payload")).toThrow(DecryptError)
		expect(() => cipher.decrypt("not-a-valid-payload")).toThrow("Invalid encrypted payload format.")
	})

	it("throws DecryptError on invalid iv size", () => {
		const cipher = new Cipher("invalid-iv-salt")

		expect(() => cipher.decrypt("00:abcd:00112233445566778899aabbccddeeff")).toThrow(DecryptError)
		expect(() => cipher.decrypt("00:abcd:00112233445566778899aabbccddeeff")).toThrow(
			"Invalid IV size during decryption."
		)
	})

	it("throws when ciphertext is tampered", () => {
		const cipher = new Cipher("tamper-salt")
		const encrypted = cipher.encrypt("sensitive-data")
		const [iv, ciphertext, tag] = encrypted.split(":")
		const tamperedCiphertext = `${iv}:${ciphertext.slice(0, -2)}aa:${tag}`

		expect(() => cipher.decrypt(tamperedCiphertext)).toThrow()
	})

	it("throws when decrypting with a different salt", () => {
		const encryptingCipher = new Cipher("encryption-salt")
		const encrypted = encryptingCipher.encrypt("same message")

		resetUsedSalts()
		const wrongCipher = new Cipher("different-salt")

		expect(() => wrongCipher.decrypt(encrypted)).toThrow()
	})
})
