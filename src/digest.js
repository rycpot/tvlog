// The weekly email: every episode of a "Watching" show airing in the seven
// days after it is sent, grouped by day, sent through Brevo. Sent on Sunday,
// that is the coming Monday–Sunday week.

import { upcomingEpisodes } from './db.js';
import { addDays, dateParts, episodeCode, episodeDate, startOfDay, weekRange } from './time.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export async function buildDigest(env, now = new Date()) {
  const tz = env.TIMEZONE || 'UTC';
  const start = startOfDay(addDays(startOfDay(now, tz), 1.5), tz);
  // Grouped by airdate, so order by it too: the query sorts by airstamp.
  const episodes = (await upcomingEpisodes(env, start, startOfDay(addDays(start, 7.5), tz), tz))
    .sort((a, b) => episodeDate(a, tz).localeCompare(episodeDate(b, tz)));
  const range = weekRange(start, tz);

  const days = [];
  for (const e of episodes) {
    const p = dateParts(episodeDate(e, tz));
    const key = `${p.weekday} ${p.month} ${p.day}`;
    if (!days.length || days[days.length - 1].key !== key) days.push({ key, items: [] });
    days[days.length - 1].items.push({ ...e, code: episodeCode(e.season, e.number) });
  }

  const site = env.SITE_URL ? `<a href="${esc(env.SITE_URL)}" style="color:#111111">Open tvlog</a>` : '';
  const rows = days.map((d) => `
    <tr><td colspan="2" style="padding:28px 0 8px;border-bottom:2px solid #111111;font-size:15px;font-weight:800;color:#111111">${esc(d.key)}</td></tr>
    ${d.items.map((e) => `
    <tr>
      <td width="64" style="padding:14px 12px 14px 0;border-bottom:1px solid #E4E4E4;vertical-align:top">
        ${e.poster ? `<img src="${esc(e.poster)}" width="48" height="68" alt="" style="display:block;width:48px;height:68px;object-fit:cover">` : ''}
      </td>
      <td style="padding:14px 12px 14px 0;border-bottom:1px solid #E4E4E4;vertical-align:top">
        <div style="font-size:16px;font-weight:700;color:#111111">${esc(e.show_name)}</div>
        <div style="font-size:14px;color:#5E5E5E;padding-top:4px">${esc(e.code)}${e.name ? ` · ${esc(e.name)}` : ''}</div>
      </td>
    </tr>`).join('')}`).join('');

  const body = episodes.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse">${rows}</table>`
    : '<p style="font-size:16px;color:#5E5E5E;margin:24px 0 0">Nothing from your Watching list airs this week.</p>';

  const subject = `Your week in TV · ${range}`;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(subject)}</title></head><body style="margin:0;background:#FFFFFF">
  <div style="max-width:600px;margin:0 auto;padding:40px 24px;font-family:'Inter Tight',Helvetica,Arial,sans-serif;color:#111111">
    <div style="font-size:20px;font-weight:800">tvlog<span style="color:#FF4F00">.</span></div>
    <div style="padding-top:36px;font-size:72px;font-weight:800;letter-spacing:-3px;line-height:0.9;color:#FF4F00">${episodes.length}</div>
    <div style="padding-top:8px;font-size:16px;color:#5E5E5E">${episodes.length === 1 ? 'episode' : 'episodes'} coming up · ${esc(range)}</div>
    ${body}
    ${site ? `<p style="padding-top:36px;font-size:13px;color:#5E5E5E">${site}</p>` : ''}
  </div></body></html>`;

  return { subject, html, count: episodes.length };
}

export async function sendDigest(env, now = new Date()) {
  if (!env.BREVO_API_KEY || !env.DIGEST_TO || !env.DIGEST_FROM) {
    throw new Error('Set BREVO_API_KEY, DIGEST_TO and DIGEST_FROM to send the weekly email');
  }
  const { subject, html, count } = await buildDigest(env, now);
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: { email: env.DIGEST_FROM, name: env.DIGEST_FROM_NAME || 'tvlog' },
      to: env.DIGEST_TO.split(',').map((email) => ({ email: email.trim() })),
      subject,
      htmlContent: html,
    }),
  });
  if (!res.ok) throw new Error(`Brevo answered ${res.status}: ${await res.text()}`);
  return { sent: true, count };
}
