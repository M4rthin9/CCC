import { REFRESH_TOKEN_TTL_SECONDS, TABLES } from '../../constants';
import { Env } from '../../types';

export async function insertRefreshToken(
  env: Env,
  username: string,
  tokenHash: string,
  ttlSeconds = REFRESH_TOKEN_TTL_SECONDS
): Promise<string> {
  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  await env.DB.prepare(
    `INSERT INTO ${TABLES.refreshTokens} (id, username, tokenHash, expiresAt, createdAt, revoked)
     VALUES (?, ?, ?, ?, ?, 0)`
  )
    .bind(id, username, tokenHash, expiresAt, createdAt)
    .run();
  return id;
}

export function findRefreshToken(
  env: Env,
  username: string,
  tokenHash: string
): Promise<{
  id: string;
  username: string;
  tokenHash: string;
  expiresAt: string;
  createdAt: string;
  revoked: number;
} | null> {
  return env.DB.prepare(
    `SELECT id, username, tokenHash, expiresAt, createdAt, revoked
     FROM ${TABLES.refreshTokens} WHERE username = ? AND tokenHash = ? LIMIT 1`
  )
    .bind(username, tokenHash)
    .first<{
      id: string;
      username: string;
      tokenHash: string;
      expiresAt: string;
      createdAt: string;
      revoked: number;
    }>();
}

export async function revokeRefreshToken(env: Env, username: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE ${TABLES.refreshTokens} SET revoked = 1 WHERE lower(username) = lower(?) AND revoked = 0`
  )
    .bind(username)
    .run()
    .then(() => undefined);
}

export async function deleteExpiredRefreshTokens(env: Env): Promise<void> {
  await env.DB.prepare(`DELETE FROM ${TABLES.refreshTokens} WHERE expiresAt < ? OR revoked = 1`)
    .bind(new Date().toISOString())
    .run()
    .then(() => undefined);
}
