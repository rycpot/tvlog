// When the weekly email goes out: a weekday and a time of day in UTC, picked
// on the email preview's settings panel. The cron runs every 30 minutes, so
// times come in half-hour steps. Until a time is saved, DIGEST_DAY and
// DIGEST_TIME from the Worker's variables apply, then Sunday 18:00 UTC.

const DAY = 86400000;
const SLOT = 30 * 60000;
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function validSchedule({ day, time } = {}) {
  return Number.isInteger(day) && day >= 0 && day <= 6
    && typeof time === 'string' && /^([01]\d|2[0-3]):(00|30)$/.test(time);
}

export async function getSchedule(env) {
  const { results } = await env.DB.prepare(
    "SELECT key, value FROM settings WHERE key IN ('digest_day', 'digest_time')").all();
  const saved = Object.fromEntries(results.map((r) => [r.key, r.value]));
  const pick = { day: Number(saved.digest_day ?? env.DIGEST_DAY ?? 0), time: saved.digest_time ?? env.DIGEST_TIME ?? '18:00' };
  return validSchedule(pick) ? pick : { day: 0, time: '18:00' };
}

export async function saveSchedule(env, { day, time }) {
  const upsert = 'INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value';
  await env.DB.batch([
    env.DB.prepare(upsert).bind('digest_day', String(day)),
    env.DB.prepare(upsert).bind('digest_time', time),
  ]);
}

// The half-hour slot a cron run belongs to, as a weekday and "HH:MM" in UTC.
export function slotOf(date) {
  const d = new Date(Math.floor(date.getTime() / SLOT) * SLOT);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return { day: d.getUTCDay(), time: `${hh}:${mm}` };
}

// The next send at or after `now`.
export function nextSend(now, { day, time }) {
  const [h, m] = time.split(':').map(Number);
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), h, m);
  let at = today + ((day - now.getUTCDay() + 7) % 7) * DAY;
  if (at < now.getTime()) at += 7 * DAY;
  return new Date(at);
}

// "Sunday 18:00 UTC".
export function describe({ day, time }) {
  return `${DAYS[day]} ${time} UTC`;
}
