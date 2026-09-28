import Redis from 'ioredis';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

// Two-level persistent store for resolved site IDs (anilistId -> animeheaven/anikoto/desidub slugs).
//   L1: Redis  - shared between every instance that points at the same Redis (optional).
//   L2: SQLite - permanent, survives restarts and Redis flushes (optional).
// Each level is enabled only if its env var is set; nothing is assumed by default.
// Every failure in either level is logged and swallowed: the store may make a lookup
// faster, but it must never make one fail.

const REDIS_URL = process.env.SITEIDS_REDIS_URL || '';
const DB_PATH = process.env.SITEIDS_DB_PATH || '';
const REDIS_TTL = parseInt(process.env.SITEIDS_REDIS_TTL || '604800'); // 7d; L2 is the permanent copy

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

let db: Database.Database | null = null;
if (DB_PATH) {
  try {
    fs.mkdirSync(path.dirname(path.resolve(DB_PATH)), { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.exec(`CREATE TABLE IF NOT EXISTS siteids (
      anilist_id INTEGER PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
  } catch (e: any) {
    db = null;
    console.error(`[siteid-store] SQLite disabled, could not open DB: ${e?.message}`);
  }
}

console.log(`[siteid-store] L1 redis: ${redis ? 'on' : 'off'} | L2 sqlite: ${db ? 'on' : 'off'}`);

function parseRecord(raw: string | null, anilistId: number): StoredSiteIds | null {
  if (!raw) return null;
  try {
    const rec = JSON.parse(raw) as StoredSiteIds;
    if (rec && rec.anilistId === anilistId && typeof rec.title === 'string' && rec.title !== 'Unknown' && rec.siteIds && typeof rec.siteIds === 'object') {
      return rec;
    }
  } catch {}
  return null;
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
  if (db) {
    try {
      const row = db.prepare('SELECT data FROM siteids WHERE anilist_id = ?').get(anilistId) as { data: string } | undefined;
      const rec = parseRecord(row?.data ?? null, anilistId);
      if (rec) {
        if (redis) redis.set(keyFor(anilistId), JSON.stringify(rec), 'EX', REDIS_TTL).catch(() => {});
        return { record: rec, level: 'db' };
      }
    } catch (e: any) {
      logThrottled(`sqlite read failed: ${e?.message}`);
    }
  }
  return null;
}

export async function storeSet(record: StoredSiteIds): Promise<void> {
  if (record.anilistId == null || record.title === 'Unknown') return; // never persist an unresolved title
  const json = JSON.stringify(record);
  if (db) {
    try {
      db.prepare(
        'INSERT INTO siteids (anilist_id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(anilist_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at'
      ).run(record.anilistId, json, Date.now());
    } catch (e: any) {
      logThrottled(`sqlite write failed: ${e?.message}`);
    }
  }
  if (redis) {
    try {
      await redis.set(keyFor(record.anilistId), json, 'EX', REDIS_TTL);
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
  if (db) {
    try { out.db = db.prepare('DELETE FROM siteids WHERE anilist_id = ?').run(anilistId).changes > 0; } catch (e: any) { logThrottled(`sqlite delete failed: ${e?.message}`); }
  }
  return out;
}
