const CATEGORIES = [
  ['watching', 'Watching'],
  ['plan', 'Plan to watch'],
  ['finished', 'Finished'],
  ['dropped', 'Dropped'],
];

const view = document.getElementById('view');
const searchBox = document.getElementById('search');
const searchInput = document.getElementById('q');
const results = document.getElementById('results');
const authButton = document.getElementById('auth');
const loginDialog = document.getElementById('login');

let admin = false;
let tz; // the owner's time zone when signed in, else the browser's own
let current = null; // the show page's data while it is open
let lastState = null; // the homepage's data while it is open
const notices = []; // banners shown above the homepage lists, each (state) => html

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function api(path, options = {}) {
  // index.html starts the first page's requests early; each is used once.
  const early = !options.method && window.preloaded?.[path];
  if (early) delete window.preloaded[path];
  const res = await (early || fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...options.headers },
    body: options.body ? JSON.stringify(options.body) : undefined,
  }));
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(message) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = message;
  document.body.append(el);
  setTimeout(() => el.remove(), 3500);
}

const root = document.documentElement;

// Set once the first response says who is viewing.
let sessionKnown = false;

function setAdmin(value) {
  admin = value;
  sessionKnown = true;
  searchBox.hidden = !admin;
  // Visitors see no sign-in button; the owner opens /signin instead.
  authButton.hidden = !admin;
  root.classList.toggle('owner', admin);
  root.classList.toggle('public', !admin);
  // Remembered so the next load starts at the right page width (see index.html).
  try { localStorage.setItem('tvlog-owner', admin ? '1' : '0'); } catch {}
}

// The wide homepage layout doesn't apply to show pages.
function setPage(page) {
  root.classList.toggle('home', page === 'home');
}

function years(show) {
  const start = show.premiered ? show.premiered.slice(0, 4) : '—';
  const end = show.status === 'Ended' ? (show.ended ? show.ended.slice(0, 4) : '') : 'Now';
  return `${start} – ${end}`;
}

function stars(rating) {
  const label = rating == null ? 'Not rated' : `${rating} out of 5 stars`;
  return `<span class="stars" role="img" aria-label="${label}"><i style="width:${((rating ?? 0) / 5) * 100}%"></i></span>`;
}

// Ten half-star buttons over a star row. Clicking the current rating clears it.
function rateInput(rating, showId) {
  const value = rating ?? 0;
  return `
    <span class="rate-input">
      <span class="stars" aria-hidden="true"><i style="width:${(value / 5) * 100}%"></i></span>
      <span class="hit">
        ${Array.from({ length: 10 }, (_, i) => {
          const v = (i + 1) / 2;
          return `<button type="button" data-rate="${v}" data-show="${showId}" aria-label="Rate ${v} out of 5"${v === rating ? ' aria-pressed="true"' : ''}></button>`;
        }).join('')}
      </span>
    </span>`;
}

function poster(src, cls = 'poster') {
  return src ? `<img class="${cls}" src="${esc(src)}" alt="" loading="lazy">` : `<div class="${cls}"></div>`;
}

function formatDate(iso) {
  return new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(iso));
}

// The day an episode airs: TVmaze's airdate (the network's own date) when
// stored, otherwise the local date of its airstamp.
function airDate(e) {
  return e.airdate
    ? new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${e.airdate}T00:00:00Z`))
    : formatDate(e.airstamp);
}

/* ---------- Home ---------- */

async function renderHome() {
  current = null;
  const state = await api('/api/state');
  setPage('home');
  lastState = state;
  tz = state.tz;
  setAdmin(state.admin);

  const groups = Object.fromEntries(CATEGORIES.map(([key]) => [key, []]));
  for (const show of state.shows) groups[show.category]?.push(show);

  const counts = CATEGORIES.map(([key, name]) => `
    <a class="count" href="#${key}"><b>${groups[key].length}</b><span>${name}</span></a>`).join('');

  const sections = CATEGORIES.map(([key, name]) => {
    const list = groups[key];
    const rows = list.map((s) => {
      const pct = s.aired ? Math.min(100, (s.watched / s.aired) * 100) : 0;
      return `
        <div class="row" data-href="/show/${s.id}">
          ${poster(s.poster)}
          <a class="title" href="/show/${s.id}">${esc(s.name)}</a>
          <span class="years num">${years(s)}</span>
          <span class="rating">${admin ? rateInput(s.rating, s.id) : stars(s.rating)}</span>
          <span class="eps num">${s.watched} / ${s.aired}<span class="bar${key === 'watching' ? ' on' : ''}"><i style="width:${pct}%"></i></span></span>
        </div>`;
    }).join('');
    return `
      <section id="${key}">
        <div class="head"><h2>${name}</h2><span>${list.length} ${list.length === 1 ? 'show' : 'shows'}</span></div>
        ${list.length ? `
          <div class="table"><div class="table-inner">
            <div class="row labels" aria-hidden="true"><span></span><span>Title</span><span>Years</span><span>Rating</span><span>Episodes</span></div>
            ${rows}
          </div></div>` : `<p class="none">Nothing here yet.${admin && key === 'watching' ? ' Search for a show to add it.' : ''}</p>`}
      </section>`;
  }).join('');

  view.innerHTML = `
    ${notices.map((notice) => notice(state)).join('')}
    <nav class="wrap counts" aria-label="Categories">${counts}</nav>
    <div class="wrap layout">
      <div class="lists">${sections}</div>
      ${state.admin ? `<aside class="side">${catchUp(state.backlog, state.backlogTotal)}${upcoming(state.weeks)}</aside>` : ''}
    </div>`;
  alignCounts();
}

// Big numerals carry side bearing, so shift each one until its ink starts
// exactly where its label's ink does.
async function alignCounts() {
  const ctx = document.createElement('canvas').getContext('2d');
  const fontOf = (el) => {
    const style = getComputedStyle(el);
    return `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
  };
  const counts = [...view.querySelectorAll('.count')];
  // Measure with the real web font, not a fallback that is shown meanwhile.
  await Promise.all(counts.flatMap((c) => [...c.children]).map((el) => document.fonts.load(fontOf(el)).catch(() => {})));
  const inkLeft = (el) => {
    ctx.font = fontOf(el);
    return -ctx.measureText(el.textContent).actualBoundingBoxLeft;
  };
  for (const count of counts) {
    const number = count.querySelector('b');
    number.style.marginLeft = `${inkLeft(count.querySelector('span')) - inkLeft(number)}px`;
  }
}

// The numerals change size at the 1040px and 720px breakpoints.
for (const width of [1040, 720]) {
  matchMedia(`(max-width: ${width}px)`).addEventListener('change', () => { if (!current) alignCounts(); });
}

function catchUp(backlog, total) {
  const items = backlog.map((e) => `
    <button class="catch" type="button" data-catch="${e.id}" data-show="${e.show_id}" aria-label="Mark ${esc(e.show_name)} ${e.code} watched">
      <span class="box" aria-hidden="true"></span>
      <span class="catch-text">
        <span class="what">${esc(e.show_name)}</span>
        <span class="meta-line num">${e.code} · ${e.date}${e.name ? ` · ${esc(e.name)}` : ''}</span>
      </span>
    </button>`).join('');
  return `
    <section class="block catch-block" aria-label="Episodes to catch up on">
      <div class="head"><h2>Catch up</h2><span class="num">${total} ${total === 1 ? 'episode' : 'episodes'}</span></div>
      <div class="catch-list">${items || '<p class="none">You\'re all caught up.</p>'}${total > backlog.length ? `<p class="none">Showing the oldest ${backlog.length}. Tick some off to see more.</p>` : ''}</div>
    </section>`;
}

// Episodes are dimmed an hour after their airstamp, once they've surely
// finished airing. The airstamp is an instant, so it needs no time zone.
function upcoming(weeks) {
  const cutoff = Date.now() - 60 * 60 * 1000;
  return `
    <section class="block up-block" aria-label="Upcoming episodes">
      <div class="head"><h2>Upcoming</h2><span><a href="/api/digest" target="_blank" rel="noopener">Preview email</a></span></div>
      ${weeks.map((w) => `
        <div class="week">
          <div class="week-head"><b>${w.label}</b><span>${w.range}</span></div>
          ${w.episodes.length ? w.episodes.map((e) => `
            <a class="up${e.airstamp && Date.parse(e.airstamp) <= cutoff ? ' aired' : ''}" href="/show/${e.show_id}">
              <span class="when">${e.weekday} ${e.day}</span>
              <span class="what">${esc(e.show_name)}</span>
              <span class="code num">${e.code}</span>
            </a>`).join('') : '<p class="none">Nothing airing.</p>'}
        </div>`).join('')}
    </section>`;
}

/* ---------- Show page ---------- */

async function renderShow(id, { refetch = true } = {}) {
  setPage('show');
  if (refetch || !current || current.show.id !== id) {
    if (!current) view.innerHTML = '<div class="wrap"><p class="meta">Loading…</p></div>';
    current = await api(`/api/shows/${id}`);
  }
  const { show, episodes, tracked } = current;
  const watched = new Set(current.watched);
  const now = Date.now();
  const aired = (e) => e.airstamp && Date.parse(e.airstamp) <= now;
  const airedCount = episodes.filter(aired).length;
  const watchedCount = episodes.filter((e) => aired(e) && watched.has(e.id)).length;
  const editable = admin && tracked;
  const meta = [years(show), show.network, show.status].filter(Boolean).map(esc).join(' · ');

  const categoryControl = admin ? `
    <div>
      <div class="label" id="cat-label">${tracked ? 'List' : 'Add to'}</div>
      <div class="seg" role="group" aria-labelledby="cat-label">
        ${CATEGORIES.map(([key, name]) => `<button type="button" data-category="${key}" aria-pressed="${show.category === key}">${name}</button>`).join('')}
      </div>
    </div>` : tracked ? `<div><div class="label">List</div><div class="rate-value">${CATEGORIES.find(([k]) => k === show.category)[1]}</div></div>` : '';

  const ratingControl = editable ? `
    <div>
      <div class="label">My rating</div>
      <div class="rate">
        ${rateInput(show.rating, show.id)}
        <span class="rate-value">${show.rating ? `${show.rating} / 5` : 'Not rated'}</span>
        ${show.rating ? '<button class="link" type="button" data-rate="clear">Clear</button>' : ''}
      </div>
    </div>` : tracked ? `<div><div class="label">My rating</div>${stars(show.rating)}</div>` : '';

  const seasons = new Map();
  for (const e of episodes) {
    if (!seasons.has(e.season)) seasons.set(e.season, []);
    seasons.get(e.season).push(e);
  }

  const seasonBlocks = [...seasons].reverse().map(([season, eps]) => {
    const seasonAired = eps.filter(aired);
    const seasonWatched = eps.filter((e) => watched.has(e.id)).length;
    const complete = seasonAired.length > 0 && seasonAired.every((e) => watched.has(e.id));
    const toggle = editable && seasonAired.length
      ? `<button class="link" type="button" data-season="${season}" data-complete="${complete}">${complete ? 'Unmark season' : 'Mark season watched'}</button>`
      : '';
    return `
      <section>
        <div class="season-head"><h2>Season ${season}</h2><span class="num">${seasonWatched} / ${seasonAired.length} watched</span>${toggle}</div>
        ${[...eps].reverse().map((e) => {
          const isWatched = watched.has(e.id);
          const isAired = aired(e);
          const date = e.airstamp ? (isAired ? airDate(e) : `Airs ${airDate(e)}`) : 'TBA';
          const inner = `
            <span class="box" aria-hidden="true">${isWatched ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#111111" stroke-width="3.5" stroke-linecap="square"><path d="M4 12l5 5L20 6"/></svg>' : ''}</span>
            <span class="code num">E${e.number ?? '—'}</span>
            <span class="name">${esc(e.name)}</span>
            <span class="date num">${date}</span>`;
          return editable
            ? `<button class="ep" type="button" data-ep="${e.id}" aria-pressed="${isWatched}" ${isAired || isWatched ? '' : 'disabled'}>${inner}</button>`
            : `<div class="ep" aria-label="${isWatched ? 'Watched' : 'Not watched'}">${inner}</div>`;
        }).join('')}
      </section>`;
  }).join('');

  view.innerHTML = `
    <div class="wrap">
      <a class="back" href="/">← All shows</a>
      <div class="show">
        ${poster(show.poster_large || show.poster, 'art')}
        <div>
          <h1>${esc(show.name)}</h1>
          <p class="meta">${meta}</p>
          <div class="controls">
            ${categoryControl}
            ${ratingControl}
            ${tracked ? `<div><div class="label">Progress</div><div class="progress"><b class="num">${watchedCount} / ${airedCount}</b><span>episodes watched</span></div></div>` : ''}
            ${editable ? '<div><button class="link" type="button" data-remove>Remove from my shows</button></div>' : ''}
          </div>
        </div>
      </div>
      <div class="seasons${editable ? '' : ' readonly'}">
        ${seasonBlocks || '<p class="none">TVmaze has no episodes for this show yet.</p>'}
      </div>
    </div>`;
}

// Mirror of the server's "upto" rule, so ticks show instantly. Like SQL,
// an episode without a number only matches itself.
function markLocally(episode) {
  const watched = new Set(current.watched);
  for (const e of current.episodes) {
    const earlierInSeason = e.season === episode.season && e.number != null && episode.number != null && e.number <= episode.number;
    if (e.season < episode.season || earlierInSeason || e.id === episode.id) {
      watched.add(e.id);
    }
  }
  current.watched = [...watched];
}

function announce({ category }) {
  if (category && category !== current?.show.category) {
    toast(`Moved to ${CATEGORIES.find(([k]) => k === category)[1]}`);
  }
}

// Changes on the show page run one at a time, in click order. The page is
// reloaded from the server only once none are left, so an older answer can
// never overwrite newer ticks.
let queue = Promise.resolve();
let queued = 0;

function mutate(action) {
  const id = current.show.id;
  queued++;
  queue = queue.then(action).catch((err) => toast(err.message)).then(async () => {
    if (--queued) return;
    try {
      const fresh = await api(`/api/shows/${id}`);
      if (!queued && current?.show.id === id) {
        current = fresh;
        renderShow(id, { refetch: false });
      }
    } catch (err) {
      toast(err.message);
    }
  });
}

view.addEventListener('click', async (event) => {
  const done = event.target.closest('[data-catch]');
  if (done && !current) {
    done.disabled = true;
    done.setAttribute('aria-pressed', 'true');
    try {
      const { category } = await api(`/api/shows/${done.dataset.show}/episodes`, {
        method: 'POST', body: { episodeId: Number(done.dataset.catch), mode: 'upto' },
      });
      if (category === 'finished') toast('Every episode watched: moved to Finished');
    } catch (err) {
      toast(err.message);
    }
    renderHome();
    return;
  }
  const rate = event.target.closest('[data-rate][data-show]');
  if (rate && !current) {
    const id = Number(rate.dataset.show);
    const show = lastState.shows.find((x) => x.id === id);
    const rating = Number(rate.dataset.rate) === show.rating ? null : Number(rate.dataset.rate);
    show.rating = rating;
    rate.closest('.rate-input').querySelector('.stars i').style.width = `${((rating ?? 0) / 5) * 100}%`;
    try {
      await api(`/api/shows/${id}`, { method: 'PUT', body: { rating } });
      toast(rating ? `Rated ${show.name} ${rating} / 5` : `Cleared rating for ${show.name}`);
    } catch (err) {
      toast(err.message);
      renderHome();
    }
    return;
  }
  const row = event.target.closest('.row[data-href]');
  if (row && !current && !event.target.closest('a, button')) {
    navigate(row.dataset.href);
    return;
  }
  if (!current) return;
  const target = event.target.closest('button');
  if (!target) return;
  const id = current.show.id;

  if (target.dataset.category) {
    const category = target.dataset.category;
    mutate(async () => {
      await api(`/api/shows/${id}`, { method: 'PUT', body: { category } });
      toast(`Saved to ${CATEGORIES.find(([k]) => k === category)[1]}`);
    });
  } else if (target.dataset.rate) {
    const rating = target.dataset.rate === 'clear' ? null : Number(target.dataset.rate);
    current.show.rating = rating;
    renderShow(id, { refetch: false });
    mutate(() => api(`/api/shows/${id}`, { method: 'PUT', body: { rating } }));
  } else if (target.dataset.ep) {
    const episode = current.episodes.find((e) => e.id === Number(target.dataset.ep));
    const isWatched = current.watched.includes(episode.id);
    if (isWatched) current.watched = current.watched.filter((x) => x !== episode.id);
    else markLocally(episode);
    renderShow(id, { refetch: false });
    mutate(() => api(`/api/shows/${id}/episodes`, {
      method: 'POST',
      body: isWatched ? { episodeId: episode.id, mode: 'single', watched: false } : { episodeId: episode.id, mode: 'upto' },
    }).then(announce));
  } else if (target.dataset.season) {
    const season = Number(target.dataset.season);
    if (target.dataset.complete === 'true') {
      mutate(() => api(`/api/shows/${id}/episodes`, { method: 'POST', body: { mode: 'unseason', season } }));
    } else {
      const now = Date.now();
      const last = current.episodes.filter((e) => e.season === season && e.airstamp && Date.parse(e.airstamp) <= now).pop();
      markLocally(last);
      renderShow(id, { refetch: false });
      mutate(() => api(`/api/shows/${id}/episodes`, { method: 'POST', body: { episodeId: last.id, mode: 'upto' } }).then(announce));
    }
  } else if (target.hasAttribute('data-remove')) {
    if (!window.confirm(`Remove ${current.show.name} and its watch history?`)) return;
    api(`/api/shows/${id}`, { method: 'DELETE' })
      .then(() => { toast('Removed'); navigate('/'); })
      .catch((err) => toast(err.message));
  }
});

/* ---------- Search ---------- */

let searchTimer;
let searchSeq = 0;

searchInput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = searchInput.value.trim();
  if (q.length < 2) { results.hidden = true; return; }
  searchTimer = setTimeout(async () => {
    const seq = ++searchSeq;
    try {
      const { results: shows } = await api(`/api/search?q=${encodeURIComponent(q)}`);
      if (seq !== searchSeq) return;
      results.innerHTML = shows.length
        ? shows.map((s) => `
          <a class="result" href="/show/${s.id}">
            ${poster(s.poster)}
            <span><strong>${esc(s.name)}</strong><span>${[years(s), s.network].filter(Boolean).map(esc).join(' · ')}</span></span>
          </a>`).join('')
        : '<p class="empty">No shows found.</p>';
      results.hidden = false;
    } catch (err) {
      toast(err.message);
    }
  }, 250);
});

function closeSearch() {
  results.hidden = true;
}
searchInput.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeSearch();
});
document.addEventListener('click', (event) => {
  if (!searchBox.contains(event.target)) closeSearch();
});
results.addEventListener('click', () => {
  closeSearch();
  searchInput.value = '';
});

/* ---------- Sign in ---------- */

authButton.addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  setAdmin(false);
  route();
});

function openLogin() {
  document.getElementById('login-error').textContent = '';
  loginDialog.showModal();
}

document.getElementById('login-cancel').addEventListener('click', () => loginDialog.close());

document.getElementById('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = document.getElementById('password');
  try {
    await api('/api/login', { method: 'POST', body: { password: input.value } });
    input.value = '';
    loginDialog.close();
    setAdmin(true);
    route();
  } catch (err) {
    document.getElementById('login-error').textContent = err.message;
  }
});

/* ---------- Routing ---------- */

// Plain paths (/ and /show/123); the Worker serves index.html for both.
let homeScroll = 0;

function navigate(path) {
  if (location.pathname === '/') homeScroll = window.scrollY;
  history.pushState(null, '', path);
  route();
}

async function route() {
  // Old #/show/123 links still work.
  const legacy = location.hash.match(/^#\/show\/(\d+)/);
  if (legacy || location.hash === '#/') history.replaceState(null, '', legacy ? `/show/${legacy[1]}` : '/');
  // /signin shows the homepage with the sign-in dialog open.
  const signin = location.pathname.replace(/\/+$/, '') === '/signin';
  if (signin) history.replaceState(null, '', '/');
  const match = location.pathname.match(/^\/show\/(\d+)/);
  try {
    if (match) {
      const id = Number(match[1]);
      // Who is viewing (first load only) and the show, fetched side by side.
      const [session, show] = await Promise.all([!sessionKnown ? api('/api/session') : null, api(`/api/shows/${id}`)]);
      if (session) {
        tz = session.tz;
        setAdmin(session.admin);
      }
      current = show;
      await renderShow(id, { refetch: false });
      window.scrollTo(0, 0);
    } else {
      await renderHome();
      window.scrollTo(0, homeScroll);
      if (signin && !admin) openLogin();
    }
  } catch (err) {
    view.innerHTML = `<div class="wrap"><p class="none">${esc(err.message)}</p></div>`;
  }
}

document.addEventListener('click', (event) => {
  const link = event.target.closest('a[href]');
  if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || link.target) return;
  const href = link.getAttribute('href');
  if (href.startsWith('#')) {
    // Count links scroll to their list without touching the URL.
    event.preventDefault();
    document.getElementById(href.slice(1))?.scrollIntoView({ behavior: 'smooth' });
  } else if (href === '/' || href.startsWith('/show/')) {
    event.preventDefault();
    navigate(href);
  }
});

window.addEventListener('popstate', route);
route();
