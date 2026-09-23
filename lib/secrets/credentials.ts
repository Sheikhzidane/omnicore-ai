import 'server-only'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * Envelope for secrets stored at rest (social OAuth tokens). AES-256-GCM with
 * a random 96-bit IV per value and a key version prefix for rotation:
 *
 *   v1.<iv b64url>.<auth tag b64url>.<ciphertext b64url>
 *
 * The key comes ONLY from CREDENTIALS_ENCRYPTION_KEY (base64, 32 bytes),
 * a server environment secret. Ciphertext is stored in a table clients cannot
 * read; plaintext exists only in server memory for the duration of an API
 * call. Tampering or a wrong key fails authentication and throws.
 */

const VERSION = 'v1'

export class CredentialVaultNotConfiguredError extends Error {
  constructor() {
    super('Credential vault not configured: set CREDENTIALS_ENCRYPTION_KEY (base64-encoded 32 bytes).')
    this.name = 'CredentialVaultNotConfiguredError'
  }
}

export function loadKey(raw: string | undefined = process.env.CREDENTIALS_ENCRYPTION_KEY): Buffer {
  if (!raw) throw new CredentialVaultNotConfiguredError()
  const key = Buffer.from(raw, 'base64')
  if (key.length !== 32) throw new CredentialVaultNotConfiguredError()
  return key
}

export function encryptSecret(plaintext: string, key: Buffer = loadKey()): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.')
}

export function decryptSecret(envelope: string, key: Buffer = loadKey()): string {
  const parts = envelope.split('.')
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error('Unrecognised credential envelope')
  const [, iv, tag, ct] = parts
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'))
  decipher.setAuthTag(Buffer.from(tag, 'base64url'))
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8')
}
