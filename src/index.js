import { clearFailures, isAdmin, lockedOut, login, logoutCookie, recordFailure } from './auth.js';
import {
  CATEGORIES, backlogEpisodes, deleteShow, getShow, listShows, markEpisode, progress, recountAll, saveShow,
  staleShows, unmarkSeason, updateShow, upcomingEpisodes,
} from './db.js';
import { buildDigest, sendDigest } from './digest.js';
import { previewPage } from './preview.js';
import { getSchedule, nextSend, saveSchedule, slotOf, validSchedule } from './schedule.js';
import { ensureSchema } from './schema.js';
import { addWeeks, dateParts, episodeCode, episodeDate, groupByWeek, startOfWeek } from './time.js';
import { fetchShow, recentUpdates, searchShows } from './tvmaze.js';

const UPCOMING_WEEKS = 4;
// The free plan allows 50 D1 queries per invocation. A cold start spends 3 on
// the schema check (15 on an empty database), the schedule 1, the stale-show
// lookup 1, the recount 1, the digest 1, and each show refresh 3, so 12 shows fit.
const REFRESH_PER_RUN = 12;

const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...headers } });
const fail = (status, error) => json({ error }, status);

async function body(request) {
  try { return await request.json(); } catch { return {}; }
}

function validRating(r) {
  return r === null || (typeof r === 'number' && r >= 0.5 && r <= 5 && Number.isInteger(r * 2));
}

async function state(env, admin) {
  // Visitors don't get the owner's time zone; their browser uses its own.
  if (!admin) return { admin, shows: await listShows(env) };
  const tz = env.TIMEZONE || 'UTC';
  // Upcoming and catch-up lists are only for the signed-in owner. The queries
  // run side by side, so the page waits for one database round trip, not four.
  const now = new Date();
  const first = startOfWeek(now, tz);
  const [shows, upcoming, backlog, ...extras] = await Promise.all([
    listShows(env),
    upcomingEpisodes(env, first, addWeeks(first, UPCOMING_WEEKS, tz), tz),
    backlogEpisodes(env, now),
  ]);
  return {
    ...Object.assign({}, ...extras),
    admin, tz, shows,
    weeks: groupByWeek(upcoming, first, UPCOMING_WEEKS, tz),
    backlogTotal: backlog.total,
    backlog: backlog.episodes.map((e) => {
      const p = dateParts(episodeDate(e, tz));
      return { ...e, code: episodeCode(e.season, e.number), date: `${p.day} ${p.month}` };
    }),
  };
}

async function api(request, env, url) {
  const path = url.pathname.replace(/\/+$/, '');
  const method = request.method;
  const admin = await isAdmin(request, env);
  const needAdmin = () => (admin ? null : fail(401, 'Sign in to make changes'));

  if (path === '/api/state' && method === 'GET') return json(await state(env, admin));
  // Just enough for a show page: who is viewing and the time zone.
  if (path === '/api/session' && method === 'GET') return json(admin ? { admin, tz: env.TIMEZONE || 'UTC' } : { admin });

  if (path === '/api/login' && method === 'POST') {
    const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    if (await lockedOut(env, ip)) return fail(429, 'Too many wrong passwords. Try again in 15 minutes.');
    const cookie = await login(env, (await body(request)).password);
    if (!cookie) {
      if (env.ADMIN_PASSWORD) await recordFailure(env, ip);
      return fail(401, env.ADMIN_PASSWORD ? 'Wrong password' : 'ADMIN_PASSWORD is not set');
    }
    await clearFailures(env, ip);
    return json({ ok: true }, 200, { 'set-cookie': cookie });
  }
  if (path === '/api/logout' && method === 'POST') return json({ ok: true }, 200, { 'set-cookie': logoutCookie() });

  if (path === '/api/search' && method === 'GET') {
    const q = (url.searchParams.get('q') ?? '').trim();
    if (q.length < 2) return json({ results: [] });
    return json({ results: await searchShows(env, q) });
  }

  const showMatch = path.match(/^\/api\/shows\/(\d+)(\/episodes)?$/);
  if (showMatch) {
    const id = Number(showMatch[1]);

    if (!showMatch[2] && method === 'GET') {
      const saved = await getShow(env, id);
      if (saved) return json({ tracked: true, ...saved });
      // Not tracked yet: show a preview straight from TVmaze.
      const fresh = await fetchShow(env, id);
      if (!fresh) return fail(404, 'Show not found');
      return json({ tracked: false, show: { ...fresh.show, category: null, rating: null }, episodes: fresh.episodes, watched: [] });
    }

    if (!showMatch[2] && method === 'PUT') {
      const denied = needAdmin(); if (denied) return denied;
      const { category, rating } = await body(request);
      if (category !== undefined && !CATEGORIES.includes(category)) return fail(400, 'Unknown category');
      if (rating !== undefined && !validRating(rating)) return fail(400, 'Rating must be 0.5 to 5 in half steps');
      const existing = await getShow(env, id);
      if (!existing) {
        const fresh = await fetchShow(env, id);
        if (!fresh) return fail(404, 'Show not found');
        await saveShow(env, fresh, category ?? 'plan');
      }
      // New shows, and shows moved to another list, go to the top of that list.
      const moved = !existing || (category !== undefined && category !== existing.show.category);
      await updateShow(env, id, { category, rating, sortKey: moved ? Date.now() : undefined });
      return json({ ok: true });
    }

    if (!showMatch[2] && method === 'DELETE') {
      const denied = needAdmin(); if (denied) return denied;
      await deleteShow(env, id);
      return json({ ok: true });
    }

    if (showMatch[2] && method === 'POST') {
      const denied = needAdmin(); if (denied) return denied;
      const { episodeId, mode = 'upto', watched = true, season } = await body(request);
      const saved = await getShow(env, id);
      if (!saved) return fail(404, 'Add the show first');
      if (mode === 'unseason') {
        await unmarkSeason(env, id, Number(season));
      } else if (!(await markEpisode(env, id, Number(episodeId), mode, watched))) {
        return fail(404, 'Episode not found');
      }
      let category = saved.show.category;
      if (watched && mode !== 'unseason') {
        const { aired, watched: seen } = await progress(env, id);
        if (saved.show.status === 'Ended' && aired > 0 && seen >= aired && category !== 'finished') {
          // Every episode of a show that has ended its run: it's finished.
          category = 'finished';
        } else if (category === 'plan') {
          // Starting a show you planned to watch moves it to Watching.
          category = 'watching';
        }
        if (category !== saved.show.category) await updateShow(env, id, { category, sortKey: Date.now() });
      }
      return json({ ok: true, category });
    }
  }

  if (path === '/api/refresh' && method === 'POST') {
    const denied = needAdmin(); if (denied) return denied;
    return json(await refresh(env));
  }


  if (path === '/api/digest' && method === 'GET') {
    const denied = needAdmin(); if (denied) return denied;
    // The email as it will go out next, so it covers the week it will cover then.
    const schedule = await getSchedule(env);
    const { html } = await buildDigest(env, nextSend(new Date(), schedule));
    return new Response(previewPage(html, schedule), { headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
  if (path === '/api/digest' && method === 'POST') {
    const denied = needAdmin(); if (denied) return denied;
    return json(await sendDigest(env));
  }

  if (path === '/api/settings' && method === 'GET') {
    const denied = needAdmin(); if (denied) return denied;
    return json({ schedule: await getSchedule(env) });
  }
  if (path === '/api/settings' && method === 'PUT') {
    const denied = needAdmin(); if (denied) return denied;
    const { day, time } = await body(request);
    if (!validSchedule({ day, time })) return fail(400, 'Pick a day and a time on the hour or half hour');
    await saveSchedule(env, { day, time });
    return json({ ok: true, schedule: { day, time } });
  }

  return fail(404, 'Not found');
}

// Re-download shows TVmaze changed this week (new episodes, air dates, posters).
async function refresh(env) {
  const ids = await staleShows(env, await recentUpdates(env), REFRESH_PER_RUN);
  for (const id of ids) {
    const fresh = await fetchShow(env, id);
    if (fresh) await saveShow(env, fresh);
  }
  await recountAll(env);
  return { refreshed: ids.length };
}

// D1 read replication: reads go to the nearest copy of the database. The
// bookmark cookie remembers the last write this browser saw, so a reload
// after a change never reads from a copy that hasn't caught up yet.
const BOOKMARK = 'tvlog_d1';

function readSession(request, env) {
  const cookie = request.headers.get('Cookie') ?? '';
  const bookmark = cookie.match(new RegExp(`(?:^|;\\s*)${BOOKMARK}=([^;]+)`))?.[1];
  return env.DB.withSession(bookmark ? decodeURIComponent(bookmark) : 'first-unconstrained');
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    const started = Date.now();
    try {
      const session = readSession(request, env);
      // Every other binding and secret stays reachable through the prototype.
      const db = Object.create(env, { DB: { value: session } });
      await ensureSchema(db);
      const res = await api(request, db, url);
      const bookmark = session.getBookmark();
      if (bookmark) {
        res.headers.append('set-cookie',
          `${BOOKMARK}=${encodeURIComponent(bookmark)}; Path=/api; Max-Age=86400; HttpOnly; Secure; SameSite=Strict`);
      }
      // Time spent waiting on the database and TVmaze, visible in DevTools.
      res.headers.set('Server-Timing', `app;dur=${Date.now() - started}`);
      return res;
    } catch (err) {
      console.error(err);
      return fail(502, err.message);
    }
  },

  async scheduled(controller, env, ctx) {
    // Runs every 30 minutes. Once a day, at the email's time of day, it
    // refreshes episode data; on the email's day it then sends the email.
    const now = new Date(controller.scheduledTime);
    ctx.waitUntil((async () => {
      await ensureSchema(env);
      const schedule = await getSchedule(env);
      const slot = slotOf(now);
      if (slot.time !== schedule.time) return;
      try {
        console.log('refresh', await refresh(env));
      } catch (err) {
        console.error('refresh failed', err);
      }
      if (slot.day !== schedule.day) return;
      // The email is optional: without Brevo set up, there is nothing to send.
      if (!env.BREVO_API_KEY) console.log('digest skipped: BREVO_API_KEY is not set');
      else console.log('digest', await sendDigest(env, now));
    })());
  },
};
