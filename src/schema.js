// Creates any missing tables on first use, so a plain `wrangler deploy` works
// even when the D1 migrations were never applied. Every statement is
// IF NOT EXISTS, so this is safe alongside `wrangler d1 migrations apply`.

import init from '../migrations/0001_init.sql';
import logins from '../migrations/0003_logins.sql';
import settings from '../migrations/0004_settings.sql';
import { recountAll } from './db.js';

let ready;

function statements(sql) {
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}


// Databases created before the stored episode counts: add and fill them.
async function addCounts(env, columns) {
  if (columns.includes('aired_count')) return;
  await env.DB.batch([
    env.DB.prepare('ALTER TABLE shows ADD COLUMN aired_count INTEGER NOT NULL DEFAULT 0'),
    env.DB.prepare('ALTER TABLE shows ADD COLUMN watched_count INTEGER NOT NULL DEFAULT 0'),
  ]);
  await recountAll(env);
}

// Databases created before episodes.airdate: add it, and mark every show for
// a fresh download so the daily refresh fills it in, Watching shows first.
// Until then the site falls back to the local date of the airstamp.
async function addAirdate(env, columns) {
  if (columns.includes('airdate')) return;
  await env.DB.batch([
    env.DB.prepare('ALTER TABLE episodes ADD COLUMN airdate TEXT'),
    env.DB.prepare('UPDATE shows SET refreshed_at = NULL'),
  ]);
}

// Table and index names the migrations create.
function created(sql) {
  return [...sql.matchAll(/CREATE\s+(?:TABLE|INDEX)\s+IF\s+NOT\s+EXISTS\s+(\w+)/gi)].map((m) => m[1]);
}

export function ensureSchema(env) {
  const columns = ['shows', 'episodes'].map((t) => env.DB.prepare(`SELECT name FROM pragma_table_info('${t}')`));
  const sql = [
    init,
    logins,
    settings,
  ].flatMap(statements);
  // One read-only round trip on a fresh Worker: what exists, plus the shows
  // and episodes columns. The CREATE statements are writes, so they only run when
  // something is missing.
  ready ??= env.DB.batch([
    env.DB.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'index')"),
    ...columns,
  ])
    .then(async ([existing, ...tables]) => {
      const names = new Set(existing.results.map((r) => r.name));
      if (sql.flatMap(created).some((name) => !names.has(name))) {
        tables = (await env.DB.batch([...sql.map((s) => env.DB.prepare(s)), ...columns])).slice(-columns.length);
      }
      const [shows, episodes] = tables.map((t) => t.results.map((c) => c.name));
      await addCounts(env, shows);
      await addAirdate(env, episodes);
    })
    .catch((err) => { ready = undefined; throw err; });
  return ready;
}
