// The email preview page: the next email as it will be sent, under a bar
// whose gear opens the settings for when it goes out. None of this is in
// the email itself.

import { describe } from './schedule.js';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const TIMES = Array.from({ length: 48 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);

const GEAR = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`;

const option = (value, label, selected) => `<option value="${value}"${selected ? ' selected' : ''}>${label}</option>`;

export function previewPage(html, schedule) {
  const bar = `
<style>
  .pv { font-family: 'Inter Tight', Helvetica, Arial, sans-serif; color: #111111; border-bottom: 2px solid #111111; }
  .pv-bar { max-width: 600px; margin: 0 auto; padding: 12px 24px; display: flex; align-items: center; justify-content: space-between; gap: 16px; font-size: 14px; color: #5E5E5E; }
  .pv-bar b { color: #111111; }
  .pv-gear { display: grid; place-items: center; width: 36px; height: 36px; padding: 0; border: 0; background: none; color: #111111; cursor: pointer; }
  .pv-gear:hover, .pv-gear[aria-expanded="true"] { color: #FF4F00; }
  .pv-panel { max-width: 600px; margin: 0 auto; padding: 4px 24px 20px; display: grid; grid-template-columns: 1fr 1fr; gap: 12px 16px; font-size: 14px; }
  .pv-panel[hidden] { display: none; }
  .pv-panel label { display: grid; gap: 6px; font-weight: 700; }
  .pv-panel select { font: inherit; font-weight: 400; padding: 8px 0; border: 0; border-bottom: 2px solid #111111; background: none; color: #111111; }
  .pv-note { grid-column: 1 / -1; margin: 0; color: #5E5E5E; }
  .pv-save { justify-self: start; font: inherit; font-weight: 700; padding: 10px 18px; border: 0; background: #111111; color: #FFFFFF; cursor: pointer; }
  .pv-save:hover { background: #FF4F00; }
  .pv-status { align-self: center; color: #5E5E5E; }
</style>
<div class="pv">
  <div class="pv-bar">
    <span>Preview · next email <b id="pv-when">${describe(schedule)}</b></span>
    <button class="pv-gear" type="button" id="pv-gear" aria-expanded="false" aria-controls="pv-panel" aria-label="Email settings" title="Email settings">${GEAR}</button>
  </div>
  <form class="pv-panel" id="pv-panel" hidden>
    <label>Day
      <select id="pv-day">${DAYS.map((d, i) => option(i, d, i === schedule.day)).join('')}</select>
    </label>
    <label>Time (UTC)
      <select id="pv-time">${TIMES.map((t) => option(t, t, t === schedule.time)).join('')}</select>
    </label>
    <p class="pv-note" id="pv-local"></p>
    <button class="pv-save" type="submit">Save</button>
    <span class="pv-status" id="pv-status" role="status"></span>
  </form>
</div>
<script>
(() => {
  const DAYS = ${JSON.stringify(DAYS)};
  const $ = (id) => document.getElementById(id);
  const gear = $('pv-gear'), panel = $('pv-panel'), day = $('pv-day'), time = $('pv-time');
  // The chosen UTC time in the viewer's own time zone, as a sanity check.
  function local() {
    const [h, m] = time.value.split(':').map(Number);
    const base = new Date(Date.UTC(2026, 0, 4 + Number(day.value), h, m)); // 4 Jan 2026 is a Sunday
    const text = base.toLocaleString(undefined, { weekday: 'long', hour: 'numeric', minute: '2-digit' });
    $('pv-local').textContent = 'That is ' + text + ' where you are now.';
  }
  gear.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    gear.setAttribute('aria-expanded', String(!panel.hidden));
  });
  day.addEventListener('change', local);
  time.addEventListener('change', local);
  panel.addEventListener('submit', async (event) => {
    event.preventDefault();
    $('pv-status').textContent = 'Saving…';
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ day: Number(day.value), time: time.value }),
    }).catch(() => null);
    if (!res || !res.ok) { $('pv-status').textContent = 'Could not save. Are you still signed in?'; return; }
    // Reload so the preview shows the week the next email will cover.
    location.reload();
  });
  local();
})();
</script>`;
  return html
    .replace('</head>', '<link rel="icon" href="/favicon.svg" type="image/svg+xml"></head>')
    .replace(/<body([^>]*)>/, (m) => `${m}${bar}`);
}
