-- Permanent store for resolved site ids (anilistId -> animeheaven/anikoto/desidub slugs).
-- Deliberately self-contained: one table, prefixed name, no foreign keys, no enum types,
-- no extensions. It never reads or alters any other table in the database.
-- Idempotent: the app runs this file at startup, and it is safe to run by hand.

CREATE TABLE IF NOT EXISTS anivault_siteids (
  anilist_id  INTEGER     PRIMARY KEY,
  mal_id      INTEGER,
  title       TEXT        NOT NULL CHECK (title <> '' AND title <> 'Unknown'),
  alt_title   TEXT,
  site_ids    JSONB       NOT NULL DEFAULT '{}'::jsonb,  -- {"animeheaven": "...", "anikoto": "...", "desidub": "...", ...}
  missing     JSONB       NOT NULL DEFAULT '{}'::jsonb,  -- provider -> unix ms of the last search that found nothing
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
