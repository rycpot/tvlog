// D1 queries. Episode lists are written with one statement per show (via
// json_each) so large shows stay well under D1's per-invocation query limit.

import { addDays, episodeDate, localDate } from './time.js';

export const CATEGORIES = ['watching', 'plan', 'finished', 'dropped'];

const UPSERT_EPISODES = `
  INSERT INTO episodes (id, show_id, season, number, name, airstamp, airdate, runtime)
  SELECT json_extract(value, '$.id'), ?1, json_extract(value, '$.season'), json_extract(value, '$.number'),
         json_extract(value, '$.name'), json_extract(value, '$.airstamp'), json_extract(value, '$.airdate'),
         json_extract(value, '$.runtime')
  FROM json_each(?2) WHERE true
  ON CONFLICT(id) DO UPDATE SET
    season = excluded.season, number = excluded.number, name = excluded.name,
    airstamp = excluded.airstamp, airdate = excluded.airdate, runtime = excluded.runtime
  -- Unchanged episodes are left alone: D1 bills every row written, indexes included.
  WHERE (episodes.season, episodes.number, episodes.name, episodes.airstamp, episodes.airdate, episodes.runtime)
    IS NOT (excluded.season, excluded.number, excluded.name, excluded.airstamp, excluded.airdate, excluded.runtime)`;

// Insert or refresh a show and its episodes. `category` is only used when the
// show is new; existing shows keep their category and rating.
export async function saveShow(env, { show, episodes }, category = 'plan') {
  const json = JSON.stringify(episodes);
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(`
      INSERT INTO shows (id, name, poster, poster_large, premiered, ended, status, network, category, refreshed_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name, poster = excluded.poster, poster_large = excluded.poster_large,
        premiered = excluded.premiered, ended = excluded.ended, status = excluded.status,
        network = excluded.network, refreshed_at = excluded.refreshed_at`)
      .bind(show.id, show.name, show.poster, show.poster_large, show.premiered, show.ended,
        show.status, show.network, category, now),
    env.DB.prepare(UPSERT_EPISODES).bind(show.id, json),
    env.DB.prepare(`
      DELETE FROM episodes WHERE show_id = ?1
      AND id NOT IN (SELECT json_extract(value, '$.id') FROM json_each(?2))`).bind(show.id, json),
  ]);
}

// Aired and watched episode counts of the show `shows.id`, as of ?1.
const AIRED = `(SELECT COUNT(*) FROM episodes e
  WHERE e.show_id = shows.id AND e.airstamp IS NOT NULL AND e.airstamp <= ?1)`;
const WATCHED = `(SELECT COUNT(*) FROM watched w JOIN episodes e ON e.id = w.episode_id
  WHERE w.show_id = shows.id AND e.airstamp IS NOT NULL AND e.airstamp <= ?1)`;

// Stores the counts for one show. Batched with every change to its episodes,
// list or watch history.
function recountStatement(env, id) {
  return env.DB.prepare(`UPDATE shows SET aired_count = ${AIRED}, watched_count = ${WATCHED} WHERE id = ?2`)
    .bind(new Date().toISOString(), id);
}

// Stores the counts for every show. The daily refresh runs this, so shows
// outside Watching pick up episodes that aired since.
export async function recountAll(env) {
  await env.DB.prepare(`UPDATE shows SET aired_count = ${AIRED}, watched_count = ${WATCHED}`)
    .bind(new Date().toISOString()).run();
}

// Watching shows are counted live, since their episodes air all the time;
// the other lists use the stored counts, which keeps a homepage load cheap.
export async function listShows(env) {
  const now = new Date().toISOString();
  const { results } = await env.DB.prepare(`
    SELECT id, name, poster, premiered, ended, status, network, category, rating, updated_at,
      CASE WHEN category = 'watching' THEN ${AIRED} ELSE aired_count END AS aired,
      CASE WHEN category = 'watching' THEN ${WATCHED} ELSE watched_count END AS watched
    FROM shows ORDER BY sort_key DESC, name`).bind(now).all();
  return results;
}

export async function getShow(env, id) {
  const [show, episodes, watched] = await env.DB.batch([
    env.DB.prepare('SELECT * FROM shows WHERE id = ?1').bind(id),
    env.DB.prepare('SELECT * FROM episodes WHERE show_id = ?1 ORDER BY season, number, airstamp').bind(id),
    env.DB.prepare('SELECT episode_id FROM watched WHERE show_id = ?1').bind(id),
  ]);
  if (!show.results.length) return null;
  return {
    show: show.results[0],
    episodes: episodes.results,
    watched: watched.results.map((r) => r.episode_id),
  };
}

// `sortKey` places the show in its list; higher is nearer the top.
export async function updateShow(env, id, { category, rating, sortKey }) {
  const sets = [];
  const args = [];
  if (category !== undefined) { sets.push(`category = ?${args.push(category)}`); }
  if (rating !== undefined) { sets.push(`rating = ?${args.push(rating)}`); }
  if (sortKey !== undefined) { sets.push(`sort_key = ?${args.push(sortKey)}`); }
  sets.push(`updated_at = ?${args.push(new Date().toISOString())}`);
  const statements = [
    env.DB.prepare(`UPDATE shows SET ${sets.join(', ')} WHERE id = ?${args.push(id)}`).bind(...args),
  ];
  // Finishing a show marks every aired episode as watched.
  if (category === 'finished') {
    statements.push(env.DB.prepare(`
      INSERT OR IGNORE INTO watched (episode_id, show_id)
      SELECT id, show_id FROM episodes
      WHERE show_id = ?1 AND airstamp IS NOT NULL AND airstamp <= ?2`).bind(id, new Date().toISOString()));
  }
  statements.push(recountStatement(env, id));
  await env.DB.batch(statements);
}

export async function deleteShow(env, id) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM watched WHERE show_id = ?1').bind(id),
    env.DB.prepare('DELETE FROM episodes WHERE show_id = ?1').bind(id),
    env.DB.prepare('DELETE FROM shows WHERE id = ?1').bind(id),
  ]);
}

// mode "upto": this episode and every earlier one become watched.
// mode "single": only this episode changes, to `watched`.
export async function markEpisode(env, showId, episodeId, mode, watched) {
  const ep = await env.DB.prepare('SELECT season, number FROM episodes WHERE id = ?1 AND show_id = ?2')
    .bind(episodeId, showId).first();
  if (!ep) return false;
  const touch = env.DB.prepare('UPDATE shows SET updated_at = ?1 WHERE id = ?2').bind(new Date().toISOString(), showId);
  if (mode === 'upto') {
    await env.DB.batch([
      env.DB.prepare(`
        INSERT OR IGNORE INTO watched (episode_id, show_id)
        SELECT id, show_id FROM episodes
        WHERE show_id = ?1 AND (season < ?2 OR (season = ?2 AND (number <= ?3 OR id = ?4)))`)
        .bind(showId, ep.season, ep.number ?? -1, episodeId),
      touch,
      recountStatement(env, showId),
    ]);
  } else if (watched) {
    await env.DB.batch([
      env.DB.prepare('INSERT OR IGNORE INTO watched (episode_id, show_id) VALUES (?1, ?2)').bind(episodeId, showId),
      touch,
      recountStatement(env, showId),
    ]);
  } else {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM watched WHERE episode_id = ?1').bind(episodeId),
      touch,
      recountStatement(env, showId),
    ]);
  }
  return true;
}

export async function unmarkSeason(env, showId, season) {
  await env.DB.batch([
    env.DB.prepare(`
      DELETE FROM watched WHERE show_id = ?1
      AND episode_id IN (SELECT id FROM episodes WHERE show_id = ?1 AND season = ?2)`).bind(showId, season),
    recountStatement(env, showId),
  ]);
}

// Episodes of shows in "watching" whose airdate falls in the local days
// [from, to). An airdate can be a day either side of the local date of the
// airstamp, so the query looks one day wider and the dates decide.
export async function upcomingEpisodes(env, from, to, tz) {
  const { results } = await env.DB.prepare(`
    SELECT e.id, e.show_id, s.name AS show_name, s.poster, e.season, e.number, e.name, e.airstamp, e.airdate
    FROM episodes e JOIN shows s ON s.id = e.show_id
    WHERE s.category = 'watching' AND e.airstamp >= ?1 AND e.airstamp < ?2
    ORDER BY e.airstamp, s.name`).bind(addDays(from, -1).toISOString(), addDays(to, 1).toISOString()).all();
  const [first, last] = [localDate(from, tz), localDate(to, tz)];
  return results.filter((e) => { const d = episodeDate(e, tz); return d >= first && d < last; });
}

export async function progress(env, id) {
  const now = new Date().toISOString();
  return env.DB.prepare(`
    SELECT
      (SELECT COUNT(*) FROM episodes WHERE show_id = ?1 AND airstamp IS NOT NULL AND airstamp <= ?2) AS aired,
      (SELECT COUNT(*) FROM watched w JOIN episodes e ON e.id = w.episode_id
        WHERE w.show_id = ?1 AND e.airstamp IS NOT NULL AND e.airstamp <= ?2) AS watched`).bind(id, now).first();
}

// The oldest `limit` unwatched episodes of Watching shows that aired before
// `before`, plus how many there are in all. Reading from the Watching shows
// outward (CROSS JOIN keeps that order) uses the per-show episode index
// instead of walking every episode by air date.
export async function backlogEpisodes(env, before, limit = 200) {
  const { results } = await env.DB.prepare(`
    SELECT e.id, e.show_id, s.name AS show_name, e.season, e.number, e.name, e.airstamp, e.airdate,
      COUNT(*) OVER () AS total
    FROM shows s CROSS JOIN episodes e ON e.show_id = s.id
    WHERE s.category = 'watching' AND e.airstamp IS NOT NULL AND e.airstamp < ?1
      AND NOT EXISTS (SELECT 1 FROM watched w WHERE w.episode_id = e.id)
    ORDER BY e.airstamp, s.name LIMIT ?2`).bind(before.toISOString(), limit).all();
  return { episodes: results, total: results[0]?.total ?? 0 };
}

// Shows whose cached data is older than TVmaze's last change: Watching shows
// first, then oldest first.
export async function staleShows(env, updates, limit) {
  const { results } = await env.DB.prepare(
    "SELECT id, refreshed_at FROM shows ORDER BY category = 'watching' DESC, refreshed_at").all();
  return results
    .filter((s) => !s.refreshed_at || (updates[s.id] && updates[s.id] * 1000 > Date.parse(s.refreshed_at)))
    .slice(0, limit)
    .map((s) => s.id);
}
