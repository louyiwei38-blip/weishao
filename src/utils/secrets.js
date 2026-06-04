import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LEN = 32;
const IV_LEN = 16;
const SALT_LEN = 32;

function deriveKey(password, salt) {
  return scryptSync(password, salt, KEY_LEN);
}

/**
 * Encrypt plaintext with AES-256-GCM.
 * Output format: base64(salt).base64(iv).base64(tag).base64(ciphertext)
 */
export function encryptSecret(plaintext, password) {
  if (!plaintext) throw new Error('plaintext is empty');
  if (!password || password.length < 8) {
    throw new Error('password must be at least 8 characters');
  }

  const salt = randomBytes(SALT_LEN);
  const key = deriveKey(password, salt);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [salt, iv, tag, encrypted]
    .map((buf) => buf.toString('base64'))
    .join('.');
}

/**
 * Decrypt a string produced by encryptSecret().
 */
export function decryptSecret(encryptedBlob, password) {
  if (!encryptedBlob) throw new Error('encrypted blob is empty');
  if (!password) throw new Error('decryption password is empty');

  const parts = encryptedBlob.split('.');
  if (parts.length !== 4) {
    throw new Error('invalid encrypted format (expected salt.iv.tag.data)');
  }

  const [salt, iv, tag, data] = parts.map((p) => Buffer.from(p, 'base64'));
  const key = deriveKey(password, salt);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  return Buffer.concat([
    decipher.update(data),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * Resolve private key: plaintext POLY_PRIVATE_KEY or encrypted blob + password.
 */
export function resolvePrivateKey() {
  const plain = process.env.POLY_PRIVATE_KEY?.trim();
  if (plain && plain !== '0x...') return plain;

  const encrypted = process.env.POLY_PRIVATE_KEY_ENCRYPTED?.trim();
  if (!encrypted) return '';

  const password = process.env.POLY_KEY_PASSWORD?.trim();
  const dryRun = process.env.DRY_RUN?.toLowerCase() === 'true';
  if (!password) {
    if (dryRun) return ''; // dry-run does not sign orders
    throw new Error(
      'POLY_PRIVATE_KEY_ENCRYPTED is set but POLY_KEY_PASSWORD is missing. ' +
        'Set POLY_KEY_PASSWORD via server environment (recommended) or .env.'
    );
  }

  try {
    return decryptSecret(encrypted, password);
  } catch {
    throw new Error('Failed to decrypt POLY_PRIVATE_KEY_ENCRYPTED — wrong password or corrupted blob');
  }
}
