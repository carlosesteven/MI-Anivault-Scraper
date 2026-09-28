import Redis from 'ioredis';
import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';

// Two-level persistent store for resolved site IDs (anilistId -> animeheaven/anikoto/desidub slugs).
//   L1: Redis    - shared between every instance that points at the same Redis (optional).
//   L2: Postgres - permanent copy in its own table, `anivault_siteids` (optional).
// Each level is enabled only if its env var is set; nothing is assumed by default.
// Every failure in either level is logged and swallowed: the store may make a lookup
// faster, but it must never make one fail.

const REDIS_URL = process.env.SITEIDS_REDIS_URL || '';
const DATABASE_URL = process.env.SITEIDS_DATABASE_URL || '';
const REDIS_TTL = parseInt(process.env.SITEIDS_REDIS_TTL || '604800'); // 7d; L2 is the permanent copy
const DB_BACKOFF_MS = 30_000; // after a DB failure, skip the DB for this long instead of stalling every request

export interface StoredSiteIds {
  anilistId: number | null;
  malId: number | null;
  title: string;
  altTitle?: string | null;
  siteIds: Record<string, string>;
  // Providers searched and NOT found -> unix ms of that search (drives the negative-cache window).
  missing?: Record<string, number>;
}

const keyFor = (anilistId: number) => `anivault:siteids:${anilistId}`;

let lastErrLog = 0;
function logThrottled(msg: string) {
  const now = Date.now();
  if (now - lastErrLog > 60_000) {
    lastErrLog = now;
    console.warn(`[siteid-store] ${msg}`);
  }
}

let redis: Redis | null = null;
if (REDIS_URL) {
  redis = new Redis(REDIS_URL, {
    enableOfflineQueue: false, // fail fast when disconnected instead of queueing
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    commandTimeout: 1500,
    retryStrategy: (times) => Math.min(times * 1000, 30_000),
  });
  redis.on('error', (e: any) => logThrottled(`redis error: ${e?.code || e?.message}`));
}

let pool: Pool | null = null;
let dbDownUntil = 0;
let dbReady: Promise<void> = Promise.resolve();
if (DATABASE_URL) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    max: 4,
    connectionTimeoutMillis: 2000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 3000,
    query_timeout: 3000,
  });
  pool.on('error', (e: any) => logThrottled(`postgres pool error: ${e?.code || e?.message}`));
  // Create the table only if it is missing (idempotent; touches nothing else). The existence
  // check comes first because a role limited to this table has no CREATE on the schema, and
  // even `CREATE TABLE IF NOT EXISTS` is refused for it when the table is already there.
  const ddl = fs.readFileSync(path.resolve(__dirname, '../../migrations/0001_anivault_siteids.sql'), 'utf8');
  dbReady = pool
    .query("SELECT to_regclass('anivault_siteids') AS t")
    .then((r) => (r.rows[0]?.t ? undefined : pool!.query(ddl).then(() => undefined)))
    .then(
    () => undefined,
    (e: any) => {
      dbDownUntil = Date.now() + DB_BACKOFF_MS;
      console.error(`[siteid-store] postgres migration failed, L2 paused: ${e?.code || e?.message}`);
    }
  );
}

console.log(`[siteid-store] L1 redis: ${redis ? 'on' : 'off'} | L2 postgres: ${pool ? 'on' : 'off'}`);

const dbUsable = () => pool !== null && Date.now() >= dbDownUntil;
function dbFailed(op: string, e: any) {
  dbDownUntil = Date.now() + DB_BACKOFF_MS;
  logThrottled(`postgres ${op} failed, skipping L2 for ${DB_BACKOFF_MS / 1000}s: ${e?.code || e?.message}`);
}

function validRecord(rec: any, anilistId: number): rec is StoredSiteIds {
  return Boolean(rec) && rec.anilistId === anilistId && typeof rec.title === 'string' && rec.title !== 'Unknown' && rec.siteIds && typeof rec.siteIds === 'object';
}

function parseRecord(raw: string | null, anilistId: number): StoredSiteIds | null {
  if (!raw) return null;
  try {
    const rec = JSON.parse(raw);
    return validRecord(rec, anilistId) ? rec : null;
  } catch {
    return null;
  }
}

export async function storeGet(anilistId: number): Promise<{ record: StoredSiteIds; level: 'redis' | 'db' } | null> {
  if (redis) {
    try {
      const rec = parseRecord(await redis.get(keyFor(anilistId)), anilistId);
      if (rec) return { record: rec, level: 'redis' };
    } catch (e: any) {
      logThrottled(`redis read failed: ${e?.message}`);
    }
  }
  if (pool) {
    await dbReady;
    if (dbUsable()) {
      try {
        const res = await pool.query(
          'SELECT anilist_id, mal_id, title, alt_title, site_ids, missing FROM anivault_siteids WHERE anilist_id = $1',
          [anilistId]
        );
        const row = res.rows[0];
        if (row) {
          const rec: StoredSiteIds = {
            anilistId: row.anilist_id,
            malId: row.mal_id,
            title: row.title,
            altTitle: row.alt_title,
            siteIds: row.site_ids ?? {},
            missing: row.missing ?? {},
          };
          if (validRecord(rec, anilistId)) {
            if (redis) redis.set(keyFor(anilistId), JSON.stringify(rec), 'EX', REDIS_TTL).catch(() => {});
            return { record: rec, level: 'db' };
          }
        }
      } catch (e: any) {
        dbFailed('read', e);
      }
    }
  }
  return null;
}

export async function storeSet(record: StoredSiteIds): Promise<void> {
  if (record.anilistId == null || record.title === 'Unknown') return; // never persist an unresolved title
  if (pool) {
    await dbReady;
    if (dbUsable()) {
      try {
        // Positives are never lost: site_ids is merged (existing keys are kept unless this write
        // supplies the same key), and a provider that is now known is dropped from `missing`.
        // Two nodes writing the same anime at once can therefore only add information.
        await pool.query(
          `INSERT INTO anivault_siteids (anilist_id, mal_id, title, alt_title, site_ids, missing)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
           ON CONFLICT (anilist_id) DO UPDATE SET
             mal_id     = COALESCE(EXCLUDED.mal_id, anivault_siteids.mal_id),
             title      = EXCLUDED.title,
             alt_title  = COALESCE(EXCLUDED.alt_title, anivault_siteids.alt_title),
             site_ids   = anivault_siteids.site_ids || EXCLUDED.site_ids,
             missing    = EXCLUDED.missing - ARRAY(SELECT jsonb_object_keys(anivault_siteids.site_ids || EXCLUDED.site_ids)),
             updated_at = now()`,
          [
            record.anilistId,
            record.malId ?? null,
            record.title,
            record.altTitle ?? null,
            JSON.stringify(record.siteIds ?? {}),
            JSON.stringify(record.missing ?? {}),
          ]
        );
      } catch (e: any) {
        dbFailed('write', e);
      }
    }
  }
  if (redis) {
    try {
      await redis.set(keyFor(record.anilistId), JSON.stringify(record), 'EX', REDIS_TTL);
    } catch (e: any) {
      logThrottled(`redis write failed: ${e?.message}`);
    }
  }
}

export async function storeDelete(anilistId: number): Promise<{ redis: boolean; db: boolean }> {
  const out = { redis: false, db: false };
  if (redis) {
    try { out.redis = (await redis.del(keyFor(anilistId))) > 0; } catch (e: any) { logThrottled(`redis delete failed: ${e?.message}`); }
  }
  if (pool) {
    await dbReady;
    try {
      out.db = ((await pool.query('DELETE FROM anivault_siteids WHERE anilist_id = $1', [anilistId])).rowCount ?? 0) > 0;
    } catch (e: any) {
      dbFailed('delete', e);
    }
  }
  return out;
}
