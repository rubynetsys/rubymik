import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { log } from './log.js';

const PREFIX = 'gcm1:';
const IV_LEN = 12;
const TAG_LEN = 16;

/**
 * AES-256-GCM encryption for secrets at rest (device credentials).
 * The key comes from RUBYMIK_ENCRYPTION_KEY, or is generated once on first
 * run and stored at <dataDir>/secret.key (0600).
 */
export class SecretBox {
  private readonly key: Buffer;

  private constructor(key: Buffer) {
    if (key.length !== 32) throw new Error('Encryption key must be 32 bytes');
    this.key = key;
  }

  static load(dataDir: string, envKeyHex: string | undefined): SecretBox {
    if (envKeyHex) {
      log.debug('Using encryption key from RUBYMIK_ENCRYPTION_KEY');
      return new SecretBox(Buffer.from(envKeyHex, 'hex'));
    }
    const keyPath = path.join(dataDir, 'secret.key');
    if (fs.existsSync(keyPath)) {
      const hex = fs.readFileSync(keyPath, 'utf8').trim();
      if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
        throw new Error(`${keyPath} is corrupt — expected 64 hex characters`);
      }
      return new SecretBox(Buffer.from(hex, 'hex'));
    }
    const key = crypto.randomBytes(32);
    fs.writeFileSync(keyPath, key.toString('hex') + '\n', { mode: 0o600 });
    log.info(`Generated new encryption key at ${keyPath}`);
    return new SecretBox(key);
  }

  encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return PREFIX + Buffer.concat([iv, tag, ct]).toString('base64');
  }

  decrypt(boxed: string): string {
    if (!boxed.startsWith(PREFIX)) throw new Error('Unrecognized ciphertext format');
    const raw = Buffer.from(boxed.slice(PREFIX.length), 'base64');
    if (raw.length < IV_LEN + TAG_LEN) throw new Error('Ciphertext too short');
    const iv = raw.subarray(0, IV_LEN);
    const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ct = raw.subarray(IV_LEN + TAG_LEN);
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  }
}
