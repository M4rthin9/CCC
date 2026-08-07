import { PASSWORD_SALT_DEFAULT } from '../lib/constants';

const te = new TextEncoder();

export function bufToHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.length % 2 ? '0' + hex : hex;
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export async function sha256Hex(input: string): Promise<string> {
  const value = input === undefined || input === null ? '' : String(input);
  const digest = await crypto.subtle.digest('SHA-256', te.encode(value));
  return bufToHex(digest);
}

// Legacy parity: 'sha256$' + sha256Hex(PASSWORD_SALT + '|' + username.toLowerCase() + '|' + password)
export async function hashPasswordLegacyAsync(username: string, password: string, salt: string): Promise<string> {
  const digest = await sha256Hex(salt + '|' + String(username).toLowerCase() + '|' + String(password));
  return 'sha256$' + digest;
}

const PBKDF2_ITERATIONS = 120000;

// Format: 'pbkdf2$<salt-hex>$<hash-hex>' — PBKDF2-SHA256, 120k iterations, 16-byte random salt.
export async function hashPasswordNew(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const saltBuf = salt.buffer.slice(salt.byteOffset, salt.byteOffset + salt.byteLength) as ArrayBuffer;
  const key = await crypto.subtle.importKey('raw', te.encode(String(password)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: saltBuf, iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  return 'pbkdf2$' + bufToHex(saltBuf) + '$' + bufToHex(bits);
}

export async function verifyPbkdf2(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'pbkdf2') return false;
  const [, saltHex, hashHex] = parts;
  if (!saltHex || !hashHex) return false;
  const key = await crypto.subtle.importKey('raw', te.encode(String(password)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: hexToBytes(saltHex), iterations: PBKDF2_ITERATIONS },
    key,
    256,
  );
  return bufToHex(bits) === hashHex.toLowerCase();
}

export interface PasswordVerifyResult {
  ok: boolean;
  algo: 'pbkdf2' | 'legacy_sha256' | 'plain';
}

export async function verifyPassword(
  username: string,
  password: string,
  stored: string,
  algo: string | null,
  salt: string | null,
): Promise<PasswordVerifyResult> {
  const s = String(stored || '');
  if (s.startsWith('sha256$') || algo === 'legacy_sha256') {
    const expected = await hashPasswordLegacyAsync(username, password, salt || PASSWORD_SALT_DEFAULT);
    return { ok: expected === s, algo: 'legacy_sha256' };
  }
  if (s.startsWith('pbkdf2$')) {
    const okV = await verifyPbkdf2(password, s);
    return { ok: okV, algo: 'pbkdf2' };
  }
  return { ok: String(password) === s, algo: 'plain' };
}
