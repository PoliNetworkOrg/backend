import { env } from '@/env';
import { createCipheriv, createDecipheriv, randomBytes, CipherGCMTypes } from 'crypto';

// Define your encryption algorithm and key size
const ALGORITHM: CipherGCMTypes = 'aes-256-gcm'; // Using AES-256 in GCM mode
const KEY_SIZE = 32; // 256 bits for AES-256
const IV_SIZE = 12; // Standard size for AES-GCM IV

// Ensure the key is the correct size and in a usable format (Buffer)
const ENCRYPTION_KEY_BUFFER = Buffer.from(env.ENCRYPTION_KEY, 'hex');
if (ENCRYPTION_KEY_BUFFER.length !== KEY_SIZE) {
  throw new Error('Invalid encryption key size.');
}

/**
 * Encrypts a string with aes-256-gcm.
 *
 * @param text The message content to encrypt.
 * @returns A promise that resolves with the encrypted string (hexadecimal).
 * @throws Error if encryption fails
 */
export async function encrypt(text: string): Promise<string> {
  if (!text) {
    return ''; // Handle empty strings gracefully
  }

  try {
    const iv = randomBytes(IV_SIZE);
    const cipher = createCipheriv(ALGORITHM, ENCRYPTION_KEY_BUFFER, iv);

    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    // Get the authentication tag (required for GCM)
    const tag = cipher.getAuthTag();

    // Combine IV, encrypted text, and tag for storage.
    // We use a separator to easily split them during decryption.
    const encryptedPayload = iv.toString('hex') + ':' + encrypted + ':' + tag.toString('hex');
    return encryptedPayload;

  } catch (error) {
    console.error('Encryption failed:', error);
    throw new Error('Failed to encrypt message.');
  }
}

/**
 * Decrypts an encrypted string.
 *
 * @param encryptedPayload The encrypted content string (hexadecimal).
 * @returns A promise that resolves with the decrypted message content.
 * @throws Error if decryption fails.
 */
export async function decrypt(encryptedPayload: string): Promise<string> {
  if (!encryptedPayload) {
    return ''; // Handle empty strings gracefully
  }

  try {
    const parts = encryptedPayload.split(':');
    if (parts.length !== 3) {
      throw new Error('Invalid encrypted payload format.');
    }

    const iv = Buffer.from(parts[0], 'hex');
    const encryptedText = parts[1];
    const tag = Buffer.from(parts[2], 'hex');

    if (iv.length !== IV_SIZE) {
      throw new Error('Invalid IV size during decryption.');
    }

    const decipher = createDecipheriv(ALGORITHM, ENCRYPTION_KEY_BUFFER, iv);
    decipher.setAuthTag(tag); // Set the authentication tag

    let decrypted = decipher.update(encryptedText, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;

  } catch (error: any) {
    console.error('Decryption failed:', error.message);
    throw new Error('Failed to decrypt message.');
  }
}
