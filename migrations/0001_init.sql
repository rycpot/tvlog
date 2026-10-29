-- Shows you track. id is the TVmaze show id.
CREATE TABLE IF NOT EXISTS shows (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  poster TEXT,
  poster_large TEXT,
  premiered TEXT,
  ended TEXT,
  status TEXT,
  network TEXT,
  category TEXT NOT NULL CHECK (category IN ('watching', 'plan', 'finished', 'dropped')),
  rating REAL CHECK (rating IS NULL OR (rating >= 0.5 AND rating <= 5)),
  -- Order within a list, higher first. New shows get the current time in ms.
  sort_key INTEGER NOT NULL DEFAULT 0,
  -- Aired and watched episode counts, stored for lists other than Watching.
  aired_count INTEGER NOT NULL DEFAULT 0,
  watched_count INTEGER NOT NULL DEFAULT 0,
  added_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  refreshed_at TEXT
);

-- Episode list cached from TVmaze. airstamp is stored as an ISO UTC string.
CREATE TABLE IF NOT EXISTS episodes (
  id INTEGER PRIMARY KEY,
  show_id INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  season INTEGER NOT NULL,
  number INTEGER,
  name TEXT,
  airstamp TEXT,
  -- Air date in the network's own time zone (YYYY-MM-DD), shown on the site.
  airdate TEXT,
  runtime INTEGER
);
CREATE INDEX IF NOT EXISTS episodes_by_show ON episodes(show_id, season, number);
CREATE INDEX IF NOT EXISTS episodes_by_air ON episodes(airstamp);

CREATE TABLE IF NOT EXISTS watched (
  episode_id INTEGER PRIMARY KEY REFERENCES episodes(id) ON DELETE CASCADE,
  show_id INTEGER NOT NULL REFERENCES shows(id) ON DELETE CASCADE,
  watched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS watched_by_show ON watched(show_id);
