// Date helpers that work in a named time zone (e.g. Europe/London) without a
// date library. Weeks run Monday to Sunday.

const DAY = 86400000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// Calendar fields of an instant as seen in `tz`.
export function zoned(date, tz) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
  }).formatToParts(date)) parts[p.type] = Number(p.value);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  return {
    year: parts.year, month: parts.month, day: parts.day, hour: parts.hour, minute: parts.minute,
    weekday: new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay(),
    offset: asUtc - Math.floor(date.getTime() / 60000) * 60000,
  };
}

// The instant of local midnight on a calendar day. The offset is taken at
// that midnight, not at the starting instant, so daylight-saving changes in
// between don't shift it by an hour.
function midnight(year, month, day, tz) {
  const utc = Date.UTC(year, month - 1, day);
  const guess = utc - zoned(new Date(utc), tz).offset;
  return new Date(utc - zoned(new Date(guess), tz).offset);
}

// The instant of local midnight at the start of the day containing `date`.
export function startOfDay(date, tz) {
  const z = zoned(date, tz);
  return midnight(z.year, z.month, z.day, tz);
}

// The instant of local Monday 00:00 of the week containing `date`.
export function startOfWeek(date, tz) {
  const z = zoned(date, tz);
  return midnight(z.year, z.month, z.day - (z.weekday + 6) % 7, tz);
}

export function addDays(date, n) {
  return new Date(date.getTime() + n * DAY);
}

// Local Monday 00:00 `n` weeks after the week starting at `weekStart`. Going
// through startOfWeek keeps it on midnight across daylight-saving changes.
export function addWeeks(weekStart, n, tz) {
  return startOfWeek(addDays(weekStart, n * 7 + 0.5), tz);
}

// "Oct 26 – Nov 1" for the week starting at `weekStart`.
export function weekRange(weekStart, tz) {
  const a = zoned(weekStart, tz);
  const b = zoned(addDays(weekStart, 6.5), tz);
  return a.month === b.month
    ? `${MONTHS[a.month - 1]} ${a.day} – ${b.day}`
    : `${MONTHS[a.month - 1]} ${a.day} – ${MONTHS[b.month - 1]} ${b.day}`;
}

export function weekLabel(index) {
  if (index === 0) return 'This week';
  if (index === 1) return 'Next week';
  return `In ${index} weeks`;
}

// "2026-10-28" for the local day containing `date`.
export function localDate(date, tz) {
  const z = zoned(date, tz);
  return `${z.year}-${String(z.month).padStart(2, '0')}-${String(z.day).padStart(2, '0')}`;
}

// The day an episode airs: TVmaze's airdate, which is the date in the
// network's own time zone, or the local date of the airstamp for episodes
// downloaded before airdates were stored.
export function episodeDate(e, tz) {
  return e.airdate || localDate(new Date(e.airstamp), tz);
}

// Weekday, day and month of a "2026-10-28" date.
export function dateParts(ymd) {
  const [y, m, d] = ymd.split('-').map(Number);
  return { weekday: WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()], day: d, month: MONTHS[m - 1] };
}

export function episodeCode(season, number) {
  return number == null ? `S${season} · Special` : `S${season} · E${number}`;
}

// Group episodes into weeks starting at `firstWeek`, by the day they air.
export function groupByWeek(episodes, firstWeek, weeks, tz) {
  const out = [];
  for (let i = 0; i < weeks; i++) {
    const start = addWeeks(firstWeek, i, tz);
    const [first, last] = [localDate(start, tz), localDate(addWeeks(firstWeek, i + 1, tz), tz)];
    out.push({
      label: weekLabel(i),
      range: weekRange(start, tz),
      episodes: episodes
        .filter((e) => { const d = episodeDate(e, tz); return d >= first && d < last; })
        // Stable sort, so episodes on the same day keep their airstamp order.
        .sort((a, b) => episodeDate(a, tz).localeCompare(episodeDate(b, tz)))
        .map((e) => ({ ...e, ...dateParts(episodeDate(e, tz)), code: episodeCode(e.season, e.number) })),
    });
  }
  return out;
}
