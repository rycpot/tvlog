// Single-owner sign-in. The password lives in the ADMIN_PASSWORD secret; a
// signed, expiring cookie keeps you signed in for 30 days.

const COOKIE = 'tvlog_session';
const MAX_AGE = 30 * 86400;
const encoder = new TextEncoder();

async function sign(secret, message) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Compares two strings through their HMACs so timing reveals nothing.
async function safeEqual(secret, a, b) {
  const [x, y] = await Promise.all([sign(secret, `cmp:${a}`), sign(secret, `cmp:${b}`)]);
  return x === y;
}

export async function isAdmin(request, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const cookie = request.headers.get('Cookie') ?? '';
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!match) return false;
  const [expires, sig] = match[1].split('.');
  if (!expires || !sig || Number(expires) < Date.now() / 1000) return false;
  return safeEqual(env.ADMIN_PASSWORD, sig, await sign(env.ADMIN_PASSWORD, `session:${expires}`));
}

export async function login(env, password) {
  if (!env.ADMIN_PASSWORD || typeof password !== 'string') return null;
  if (!(await safeEqual(env.ADMIN_PASSWORD, password, env.ADMIN_PASSWORD))) return null;
  const expires = Math.floor(Date.now() / 1000) + MAX_AGE;
  const value = `${expires}.${await sign(env.ADMIN_PASSWORD, `session:${expires}`)}`;
  return `${COOKIE}=${value}; Path=/; Max-Age=${MAX_AGE}; HttpOnly; Secure; SameSite=Strict`;
}

// After MAX_FAILURES wrong passwords from one IP, sign-in is refused until
// LOCKOUT has passed since the first of them.
const MAX_FAILURES = 10;
const LOCKOUT = 15 * 60 * 1000;

export async function lockedOut(env, ip) {
  const row = await env.DB.prepare('SELECT count, first_at FROM login_failures WHERE ip = ?1').bind(ip).first();
  return Boolean(row && row.count >= MAX_FAILURES && Date.now() - row.first_at < LOCKOUT);
}

export async function recordFailure(env, ip) {
  const now = Date.now();
  await env.DB.prepare(`
    INSERT INTO login_failures (ip, count, first_at) VALUES (?1, 1, ?2)
    ON CONFLICT(ip) DO UPDATE SET
      count = CASE WHEN ?2 - first_at >= ?3 THEN 1 ELSE count + 1 END,
      first_at = CASE WHEN ?2 - first_at >= ?3 THEN ?2 ELSE first_at END`).bind(ip, now, LOCKOUT).run();
}

export async function clearFailures(env, ip) {
  await env.DB.prepare('DELETE FROM login_failures WHERE ip = ?1').bind(ip).run();
}

export function logoutCookie() {
  return `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}
