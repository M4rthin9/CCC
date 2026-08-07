import type { Env } from '../types';
import { getVersion, bumpVersion } from '../db/db';

export async function getDataVersion(env: Env): Promise<number> {
  return getVersion(env);
}

export async function bumpDataVersion(env: Env): Promise<number> {
  return bumpVersion(env);
}
