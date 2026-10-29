// Thin client for the TVmaze public API (https://www.tvmaze.com/api).
// No key needed. Limit is about 20 calls every 10 seconds per IP.

const BASE = 'https://api.tvmaze.com';

// Only search results may come from Cloudflare's cache. Show data and the
// update list must be current, or a refresh could save a stale copy and
// mark the show as up to date.
async function get(env, path, { cached = false } = {}) {
  const res = await fetch((env.TVMAZE_BASE || BASE) + path, {
    headers: { 'User-Agent': 'tv-shows personal tracker (Cloudflare Worker)' },
    ...(cached ? { cf: { cacheTtl: 3600 } } : { cache: 'no-store' }),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`TVmaze ${path} answered ${res.status}`);
  return res.json();
}

function year(date) {
  return date ? date.slice(0, 4) : null;
}

export function summarize(show) {
  return {
    id: show.id,
    name: show.name,
    poster: show.image?.medium ?? null,
    poster_large: show.image?.original ?? null,
    premiered: show.premiered ?? null,
    ended: show.ended ?? null,
    status: show.status ?? null,
    network: show.network?.name ?? show.webChannel?.name ?? null,
    years: { start: year(show.premiered), end: show.status === 'Ended' ? year(show.ended) : null },
  };
}

export async function searchShows(env, query) {
  const results = (await get(env, `/search/shows?q=${encodeURIComponent(query)}`, { cached: true })) ?? [];
  return results.map((r) => summarize(r.show));
}

// The show plus every regular episode (specials are left out by TVmaze).
export async function fetchShow(env, id) {
  const show = await get(env, `/shows/${id}?embed=episodes`);
  if (!show) return null;
  const episodes = (show._embedded?.episodes ?? []).map((e) => ({
    id: e.id,
    season: e.season,
    number: e.number,
    name: e.name,
    airstamp: e.airstamp ? new Date(e.airstamp).toISOString() : null,
    // The date in the network's own time zone, as TVmaze lists it.
    airdate: e.airdate || null,
    runtime: e.runtime ?? null,
  }));
  return { show: summarize(show), episodes };
}

// Map of TVmaze show id to the unix time it last changed, for the past week.
export async function recentUpdates(env) {
  return (await get(env, '/updates/shows?since=week')) ?? {};
}
