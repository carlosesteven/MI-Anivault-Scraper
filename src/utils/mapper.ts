import axios from 'axios';
import { anilistClient } from './fetch';
import { cacheGet, cacheSet, cacheDel } from './cache';
import { findAnimeHeavenId } from '../scrapers/animeheaven';
import { findAnikotoSlug } from '../scrapers/anikoto';
import { findDesidubSlug } from '../scrapers/desidub';
import { getAnimeDetails } from '../scrapers/mal';
import { fetchAnilistMeta } from './anilistMeta';
import { storeGet, storeSet, storeDelete } from './siteIdStore';

// Forget everything cached for one anime (memory + Redis + SQLite) so the next request
// re-resolves it from scratch. The escape hatch for a wrong/stale permanent mapping.
export async function invalidateSiteIds(anilistId: number) {
  cacheDel(`siteids:${anilistId}`);
  return storeDelete(anilistId);
}

export interface SiteIds {
  anilistId: number | null;
  malId: number | null;
  title: string;
  // Providers searched and not found -> unix ms of that search. Only used by the
  // AniList-id path (getSiteIds) to avoid re-searching a known miss on every call.
  missing?: Record<string, number>;
  // Secondary title candidate (opposite of `title`'s romaji/English choice)
  // used only to retry site-matching (Anikoto/AnimeHeaven/DesiDub) when the primary
  // title doesn't score a good match. Not part of the public /info response
  // (routes.ts only ever destructures the named fields it wants).
  altTitle?: string | null;
  siteIds: {
    zoro?: string;
    gogoanime?: string;
    animeheaven?: string;
    anidao?: string;
    anikoto?: string;
    desidub?: string;
  };
}

async function enrichAnimeHeaven(result: SiteIds, altTitle?: string | null): Promise<SiteIds> {
  if (result.siteIds.animeheaven || result.title === 'Unknown') return result;
  const id = await findAnimeHeavenId(result.title).catch(() => null);
  if (id) {
    result.siteIds.animeheaven = id;
    return result;
  }
  if (altTitle && altTitle !== result.title) {
    const altId = await findAnimeHeavenId(altTitle).catch(() => null);
    if (altId) result.siteIds.animeheaven = altId;
  }
  return result;
}

// Anikoto's own site displays/searches by the localized English title, not
// the JP romaji — so callers whose `result.title` is romaji (e.g. the
// MAL-fallback path) MUST also pass the English title here, or every match
// will legitimately score too low and get rejected (see findAnikotoSlug's
// MIN_MATCH_SCORE). Tries `result.title` first, falls back to `altTitle`.
async function enrichAnikoto(result: SiteIds, altTitle?: string | null): Promise<SiteIds> {
  if (result.siteIds.anikoto || result.title === 'Unknown') return result;
  const slug = await findAnikotoSlug(result.title).catch(() => null);
  if (slug) {
    result.siteIds.anikoto = slug;
    return result;
  }
  if (altTitle && altTitle !== result.title) {
    const altSlug = await findAnikotoSlug(altTitle).catch(() => null);
    if (altSlug) result.siteIds.anikoto = altSlug;
  }
  return result;
}

async function enrichDesidub(result: SiteIds, altTitle?: string | null): Promise<SiteIds> {
  if (result.siteIds.desidub || result.title === 'Unknown') return result;
  const slug = await findDesidubSlug(result.title).catch(() => null);
  if (slug) {
    result.siteIds.desidub = slug;
    return result;
  }
  if (altTitle && altTitle !== result.title) {
    const altSlug = await findDesidubSlug(altTitle).catch(() => null);
    if (altSlug) result.siteIds.desidub = altSlug;
  }
  return result;
}

// MAL ID → AniList ID
// Returns null (never throws) if AniList is down/unreachable -- callers use
// that as the signal to fall back to the MAL-only path (getSiteIdsByMal).
export async function malToAnilist(malId: number): Promise<number | null> {
  const cacheKey = `mal2al:${malId}`;
  const cached = cacheGet<number>(cacheKey);
  if (cached) return cached;

  try {
    const query = `query ($malId: Int) {
      Media(idMal: $malId, type: ANIME) { id idMal title { romaji english } }
    }`;
    const res = await anilistClient.post('', { query, variables: { malId } });
    const id = res.data?.data?.Media?.id ?? null;
    if (id) cacheSet(cacheKey, id);
    return id;
  } catch {
    return null;
  }
}

// Fetch title from AniList for a given anilistId
async function getAnilistTitle(anilistId: number): Promise<{ title: string; altTitle: string | null; malId: number | null }> {
  // Optional self-hosted metadata service first (env-configured); any failure falls through
  // to AniList's GraphQL API below, which is the unchanged original behavior.
  const viaMeta = await fetchAnilistMeta(anilistId);
  if (viaMeta) return viaMeta;

  const query = `query ($id: Int) {
    Media(id: $id, type: ANIME) { idMal title { romaji english } }
  }`;
  const res = await anilistClient.post('', { query, variables: { id: anilistId } });
  const media = res.data?.data?.Media;
  const english: string | null = media?.title?.english ?? null;
  const romaji: string | null = media?.title?.romaji ?? null;
  return {
    title: english ?? romaji ?? 'Unknown',
    altTitle: english && romaji && english !== romaji ? romaji : null,
    malId: media?.idMal ?? null,
  };
}

// A provider that was searched and not found is not searched again for this long (seconds).
// Without this, every request re-ran the full title search for every missing provider.
const NEGATIVE_TTL_MS = parseInt(process.env.SITEIDS_NEGATIVE_TTL || '1800') * 1000;

// Optional legacy mapping source (only yields zoro/gogoanime ids, which no route here uses).
// Disabled unless a base URL is configured: "<base>/<anilistId>?fields=mappings".
const ANIFY_MAPPINGS_URL = (process.env.ANIFY_MAPPINGS_URL || '').replace(/\/+$/, '');

const PROVIDERS = ['animeheaven', 'anikoto', 'desidub'] as const;
type Provider = typeof PROVIDERS[number];
const ENRICHERS: Record<Provider, (r: SiteIds, alt?: string | null) => Promise<SiteIds>> = {
  animeheaven: enrichAnimeHeaven,
  anikoto: enrichAnikoto,
  desidub: enrichDesidub,
};

// Re-search only the providers that are missing AND whose last miss is older than the
// negative window. Sequential on purpose (the provider sites rate-limit bursts).
async function refreshMissing(record: SiteIds): Promise<boolean> {
  record.missing = record.missing ?? {};
  let changed = false;
  for (const p of PROVIDERS) {
    if (record.siteIds[p]) continue;
    const lastMiss = record.missing[p];
    if (lastMiss !== undefined && Date.now() - lastMiss < NEGATIVE_TTL_MS) continue;
    await ENRICHERS[p](record, record.altTitle);
    if (record.siteIds[p]) delete record.missing[p];
    else record.missing[p] = Date.now();
    changed = true;
  }
  return changed;
}

// Never keep a record whose title could not be resolved - in memory or on disk - or a
// transient AniList failure would freeze "Unknown" (and zero providers) for that anime.
async function persist(record: SiteIds): Promise<void> {
  if (record.anilistId == null || record.title === 'Unknown') return;
  cacheSet(`siteids:${record.anilistId}`, record);
  await storeSet(record as any);
}

async function resolveAnilistSiteIds(anilistId: number): Promise<SiteIds | null> {
  const memKey = `siteids:${anilistId}`;
  let record = cacheGet<SiteIds>(memKey);
  let fromMemory = Boolean(record);
  if (!record) {
    const stored = await storeGet(anilistId);
    if (stored) record = stored.record as SiteIds;
  }

  if (record) {
    if (await refreshMissing(record)) await persist(record);
    else if (!fromMemory) cacheSet(memKey, record);
    return record;
  }

  // Cold: nothing known about this anime yet.
  const alInfo = await getAnilistTitle(anilistId).catch(() => ({ title: 'Unknown', altTitle: null, malId: null }));

  const result: SiteIds = {
    anilistId,
    malId: alInfo.malId,
    title: alInfo.title,
    altTitle: alInfo.altTitle,
    siteIds: {},
    missing: {},
  };

  if (ANIFY_MAPPINGS_URL) {
    try {
      const res = await axios.get(`${ANIFY_MAPPINGS_URL}/${anilistId}`, {
        params: { fields: 'mappings' },
        timeout: 8000,
      });
      const mappings: any[] = res.data?.mappings ?? [];
      for (const m of mappings) {
        if (m.providerId === 'zoro')      result.siteIds.zoro = m.id;
        if (m.providerId === 'gogoanime') result.siteIds.gogoanime = m.id;
        if (m.providerId === 'mal' && !result.malId) result.malId = parseInt(m.id);
      }
    } catch {
      // mapping source down or missing - fall through to the direct scrapers below
    }
  }

  await refreshMissing(result);

  // If still no zoro ID, try a slug guess (title-anilistId format common on HiAnime clones)
  // This is a heuristic and may not always work
  if (!result.siteIds.zoro && result.title !== 'Unknown') {
    const slug = result.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    result.siteIds.zoro = `${slug}-${anilistId}`;
  }

  await persist(result);
  return result;
}

// Concurrent requests for the same anime share ONE resolution instead of each running its
// own full search (a burst of users opening the same new anime would otherwise multiply
// the load on the provider sites).
const inflight = new Map<number, Promise<SiteIds | null>>();

// AniList ID → metadata + site-specific IDs
export function getSiteIds(anilistId: number): Promise<SiteIds | null> {
  const running = inflight.get(anilistId);
  if (running) return running;
  const p = resolveAnilistSiteIds(anilistId).finally(() => inflight.delete(anilistId));
  inflight.set(anilistId, p);
  return p;
}

// AniList-free fallback: build SiteIds from a MAL ID alone (title comes from
// your own MAL scraper instead of AniList's getAnilistTitle). Used when
// malToAnilist can't resolve an AniList ID (AniList down/blocked). Note:
// zoro/gogoanime via Anify both key off anilistId, so
// those stay unavailable here -- everything keyed off title (animeheaven,
// anikoto, desidub) still works normally.
export async function getSiteIdsByMal(malId: number): Promise<SiteIds | null> {
  const cacheKey = `siteids:mal:${malId}`;
  const cached = cacheGet<SiteIds>(cacheKey);
  if (cached) {
    const wasMissingAnimeHeaven = !cached.siteIds.animeheaven;
    const wasMissingAnikoto = !cached.siteIds.anikoto;
    const wasMissingDesidub = !cached.siteIds.desidub;
    const enriched = await enrichDesidub(await enrichAnikoto(await enrichAnimeHeaven(cached, cached.altTitle), cached.altTitle), cached.altTitle);
    if ((wasMissingAnimeHeaven && enriched.siteIds.animeheaven) || (wasMissingAnikoto && enriched.siteIds.anikoto) || (wasMissingDesidub && enriched.siteIds.desidub)) {
      cacheSet(cacheKey, enriched);
    }
    return enriched;
  }

  const details = await getAnimeDetails(malId).catch(() => null);
  if (!details) return null;

  // details.title is MAL's romaji/native title; details.titleEnglish is the
  // localized one. Anikoto (and most streaming clones) index by the English
  // title, so that has to be tried too, not just whichever MAL calls
  // "the" title.
  const romajiTitle = details.title || null;
  const englishTitle = details.titleEnglish || null;

  const result: SiteIds = {
    anilistId: null,
    malId,
    title: romajiTitle || englishTitle || 'Unknown',
    altTitle: englishTitle && romajiTitle && englishTitle !== romajiTitle ? englishTitle : null,
    siteIds: {},
  };

  await enrichAnimeHeaven(result, result.altTitle);
  await enrichAnikoto(result, result.altTitle);
  await enrichDesidub(result, result.altTitle);

  cacheSet(cacheKey, result);
  return result;
}

// Search AniList by title
export async function searchAnilist(query: string): Promise<{
  id: number; malId: number | null; title: string; coverImage: string; episodes: number | null; status: string; format: string;
}[]> {
  const cacheKey = `alsearch:${query.toLowerCase().trim()}`;
  const cached = cacheGet<any[]>(cacheKey);
  if (cached) return cached;

  const gql = `query ($search: String) {
    Page(page: 1, perPage: 10) {
      media(search: $search, type: ANIME, sort: SEARCH_MATCH) {
        id idMal episodes
        title { romaji english }
        coverImage { large medium }
        status format
      }
    }
  }`;

  const res = await anilistClient.post('', { query: gql, variables: { search: query } });
  const list = res.data?.data?.Page?.media ?? [];

  const results = list.map((m: any) => ({
    id: m.id,
    malId: m.idMal ?? null,
    title: m.title?.english ?? m.title?.romaji,
    coverImage: m.coverImage?.large ?? m.coverImage?.medium ?? '',
    episodes: m.episodes ?? null,
    status: m.status,
    format: m.format,
  }));

  cacheSet(cacheKey, results, 'episodes');
  return results;
}
