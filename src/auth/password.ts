import { getPasswordSalt } from '../config';

// Mirrors the legacy Apps Script hashing exactly so existing password hashes
// keep working after migration:
//   hash = 'sha256$' + hex(sha256(salt + '|' + username.toLowerCase() + '|' + password))
export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest))
    .map(b => ('0' + b.toString(16)).slice(-2))
    .join('');
}

export async function hashPassword(env: { PASSWORD_SALT?: string }, username: string, password: string): Promise<string> {
  const salt = getPasswordSalt(env);
  return 'sha256$' + await sha256Hex(salt + '|' + String(username).toLowerCase() + '|' + String(password));
}

export async function verifyPassword(
  env: { PASSWORD_SALT?: string },
  username: string,
  password: string,
  stored: string
): Promise<boolean> {
  const s = String(stored || '');
  if (s.indexOf('sha256$') === 0) {
    return (await hashPassword(env, username, password)) === s;
  }
  return String(password) === s;
}
