import axios from 'axios';

// Optional: resolve an AniList title/malId through a self-hosted metadata service instead of
// hitting graphql.anilist.co directly. Configured ONLY through env; with no URL set this is
// a no-op and the caller falls back to AniList's GraphQL API exactly as before.
//   ANILIST_META_BASE_URL   base URL; "<base>/<anilistId>" must return
//                           { id, title: { romaji, english }, malId }
//   ANILIST_META_TIMEOUT_MS request timeout (default 5000)
const BASE = (process.env.ANILIST_META_BASE_URL || '').replace(/\/+$/, '');
const TIMEOUT = parseInt(process.env.ANILIST_META_TIMEOUT_MS || '5000');

export interface AnilistMeta {
  title: string;
  altTitle: string | null;
  malId: number | null;
}

export async function fetchAnilistMeta(anilistId: number): Promise<AnilistMeta | null> {
  if (!BASE) return null;
  try {
    const res = await axios.get(`${BASE}/${anilistId}`, {
      timeout: TIMEOUT,
      headers: { Accept: 'application/json' },
    });
    const d = res.data;
    if (!d || String(d.id) !== String(anilistId)) return null;
    const english: string | null = d.title?.english ?? null;
    const romaji: string | null = d.title?.romaji ?? null;
    const title = english ?? romaji;
    if (!title) return null;
    const mal = d.malId != null ? Number(d.malId) : NaN;
    return {
      title,
      altTitle: english && romaji && english !== romaji ? romaji : null,
      malId: Number.isFinite(mal) ? mal : null,
    };
  } catch (e: any) {
    // Deliberately log only a status/code: never the URL or host.
    console.warn(`[anilist-meta] unavailable (${e?.response?.status || e?.code || 'error'}), falling back to direct AniList`);
    return null;
  }
}
