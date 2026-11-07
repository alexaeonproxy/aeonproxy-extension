/* AeonProxy extension — service worker. Owns everything that must keep working while the popup is closed: the browser's
   proxy setting, the proxy login (onAuthRequired), the WebRTC policy, the exit check and the toolbar badge.

   State (chrome.storage.local): enabled, active (the proxy in use, with its login), settings, auth (the extension's
   sign-in), profiles (the customer's own proxies), aeon (the last AeonProxy picks), state (the account as the site last
   sent it). Per browser session (chrome.storage.session): phase off | connecting | checking | on | error, exit, error,
   authUsed (which login Chrome holds per proxy address), pendingTab.

   Chrome keeps one proxy login per proxy address for the whole browser session and sends it without asking again, so a
   new country (a new login on the same host:port) would silently keep the old one. The only call that forgets it is
   browsingData with `cookies` for that origin, which also deletes the cookies of the whole domain. So the extension
   connects by IP address wherever it can (the site sends the relay's IP; other names are looked up over DNS-over-HTTPS
   when the login changes) and clears the login of that IP before every switch: no site cookie is touched. */
import { ApiError, api } from './lib/api.js';
import { BYPASS_ALWAYS, CHECK, CHECK_PLAIN, DEFAULT_SETTINGS, SITE } from './lib/config.js';
import { isIPv4, isIPv6 } from './lib/parse.js';

const L = chrome.storage.local, S = chrome.storage.session;
const EMERALD = '#0B8A69', CORAL = '#C4461F';

/* storage.session is readable by extension pages only by default; the content script never needs it */
S.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});

const settingsOf = async () => ({ ...DEFAULT_SETTINGS, ...((await L.get('settings')).settings || {}) });
const who = (p) => `${p.username}\n${p.password}`;
const bare = (h) => String(h || '').replace(/^\[|\]$/g, '');
const isIp = (h) => isIPv4(bare(h)) || isIPv6(bare(h));
const urlHost = (h) => (isIPv6(bare(h)) ? `[${bare(h)}]` : bare(h));

/* ---------------- proxy login ---------------- */
const tries = new Map(); /* requestId → { n, t }: a second challenge for the same request means the login was refused */
let authFailedAt = 0;
chrome.webRequest.onAuthRequired.addListener((d, done) => { answerAuth(d).then(done, () => done({})); }, { urls: ['<all_urls>'] }, ['asyncBlocking']);
async function answerAuth(d) {
  if (!d.isProxy) return {}; /* a site's own login prompt is not ours */
  const { enabled, active } = await L.get(['enabled', 'active']);
  if (!enabled || !active || !active.username) return {};
  const ch = d.challenger || {}, at = active.applied || {};
  if (String(ch.port) !== String(at.port) || bare(ch.host).toLowerCase() !== bare(at.host).toLowerCase()) return {};
  const now = Date.now();
  if (tries.size > 300) for (const [k, v] of tries) if (now - v.t > 60_000) tries.delete(k);
  const t = tries.get(d.requestId) || { n: 0, t: now };
  t.n++; tries.set(d.requestId, t);
  if (t.n > 1) { authFailedAt = now; return { cancel: true }; }
  return { authCredentials: { username: active.username, password: active.password } };
}

/* ---------------- applying a proxy ---------------- */
async function dohA(name) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 4000);
  try {
    const r = await fetch(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(name)}&type=A`, { headers: { accept: 'application/dns-json' }, signal: ctl.signal, cache: 'no-store', credentials: 'omit' });
    const j = await r.json();
    return (j.Answer || []).find((a) => a.type === 1 && isIPv4(a.data))?.data || null;
  } catch { return null; } finally { clearTimeout(t); }
}

/** The address Chrome is pointed at: the IP when we know it; a name only while no other login was used on it. */
async function addressOf(p) {
  if (p.hostIp && isIp(p.hostIp)) return bare(p.hostIp);
  if (isIp(p.host)) return bare(p.host);
  if (!p.username) return p.host;
  const { authUsed = {} } = await S.get('authUsed');
  const prev = authUsed[`${p.host}:${p.port}`];
  if (!prev || prev === who(p)) return p.host;
  return (await dohA(p.host)) || p.host;
}

/** Makes Chrome forget the login it holds for this proxy address (see the header comment). */
async function forgetLogin(host, p) {
  const key = `${host}:${p.port}`, { authUsed = {} } = await S.get('authUsed');
  if (p.username && (isIp(host) ? authUsed[key] !== who(p) : authUsed[key] && authUsed[key] !== who(p))) {
    const h = urlHost(host);
    try { await chrome.browsingData.remove({ origins: [`http://${h}:${p.port}`, `https://${h}:${p.port}`] }, { cookies: true }); } catch (e) { console.warn('[aeon] could not clear the proxy login', e); }
  }
  if (p.username) { authUsed[key] = who(p); await S.set({ authUsed }); }
}

function bypassList(settings) {
  const own = (settings.bypass || []).map((s) => String(s).trim()).filter((s) => s && s.length < 254 && !/\s/.test(s));
  return [...new Set(['<local>', ...BYPASS_ALWAYS, ...own])];
}
async function setChromeProxy(scheme, host, port, settings) {
  await chrome.proxy.settings.set({ scope: 'regular', value: { mode: 'fixed_servers', rules: { singleProxy: { scheme, host: bare(host), port: Number(port) }, bypassList: bypassList(settings) } } });
  const got = await chrome.proxy.settings.get({});
  if (got.levelOfControl !== 'controlled_by_this_extension') throw Object.assign(new Error('Another extension (often a VPN) controls the browser\'s proxy. Turn it off, then connect again.'), { kind: 'conflict' });
}
async function setWebRtc(on) {
  const pol = chrome.privacy?.network?.webRTCIPHandlingPolicy;
  if (!pol) return;
  try { if (on) await pol.set({ value: 'disable_non_proxied_udp' }); else await pol.clear({}); } catch { /* managed by policy */ }
}

const SCHEME = { http: 'http', https: 'https', socks5: 'socks5', socks4: 'socks4' };
function cleanProxy(p) {
  if (!p || typeof p !== 'object') throw new Error('Nothing to connect to.');
  const scheme = SCHEME[p.scheme] || 'http', port = Number(p.port);
  if (!p.host || typeof p.host !== 'string' || !(port >= 1 && port <= 65535)) throw new Error('This proxy has no valid host and port.');
  return {
    kind: ['aeon', 'ip', 'manual'].includes(p.kind) ? p.kind : 'manual', id: String(p.id || ''), label: String(p.label || p.host).slice(0, 80), sub: String(p.sub || '').slice(0, 120),
    scheme, host: p.host.trim().toLowerCase(), hostIp: p.hostIp && isIp(p.hostIp) ? bare(p.hostIp) : null, port,
    username: String(p.username || ''), password: String(p.password || ''), cc: /^[A-Za-z]{2}$/.test(p.cc || '') ? p.cc.toUpperCase() : null,
    product: p.product || null, cfg: p.cfg || null,
  };
}

let seq = 0;
async function connect(raw) {
  const p = cleanProxy(raw), my = ++seq;
  await S.set({ phase: 'connecting', exit: null, error: null });
  paint();
  try {
    const settings = await settingsOf();
    const host = await addressOf(p);
    await forgetLogin(host, p);
    await setChromeProxy(p.scheme, host, p.port, settings);
    tries.clear(); authFailedAt = 0;
    await L.set({ enabled: true, active: { ...p, applied: { host, port: p.port }, at: Date.now() } });
    await setWebRtc(settings.webrtc);
  } catch (e) {
    if (my !== seq) return;
    await S.set({ phase: 'error', error: { kind: e.kind || 'failed', message: e.message || 'Could not set the proxy.', at: Date.now() } });
    paint();
    throw e;
  }
  if (my === seq) check(my);
}

async function disconnect() {
  seq++;
  try { await chrome.proxy.settings.clear({ scope: 'regular' }); } catch { /* not ours any more */ }
  await setWebRtc(false);
  await L.set({ enabled: false });
  await S.set({ phase: 'off', exit: null, error: null });
  paint();
}

/** Settings changed (bypass list, WebRTC) while connected: same proxy, new rules; the login stays. */
async function reapply() {
  const { enabled, active } = await L.get(['enabled', 'active']);
  if (!enabled || !active?.applied) return;
  const settings = await settingsOf();
  try { await setChromeProxy(active.scheme, active.applied.host, active.applied.port, settings); await setWebRtc(settings.webrtc); }
  catch (e) { await S.set({ phase: 'error', error: { kind: e.kind || 'failed', message: e.message } }); paint(); }
}

/* ---------------- exit check ---------------- */
async function timedFetch(url, ms, opts = {}) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { cache: 'no-store', credentials: 'omit', ...opts, signal: ctl.signal }); } finally { clearTimeout(t); }
}
let lastProxyError = { error: '', at: 0 };
chrome.proxy.onProxyError.addListener((d) => { lastProxyError = { error: d.error || '', at: Date.now() }; });

async function check(my = seq) {
  const { enabled, active } = await L.get(['enabled', 'active']);
  if (!enabled || !active) return;
  await S.set({ phase: 'checking' });
  paint();
  const t0 = performance.now();
  try {
    const r = await timedFetch(CHECK, 15000);
    if (!r.ok) throw new Error(`check ${r.status}`);
    const j = await r.json(), ip = j.ip || {};
    const exit = { ip: ip.ip || '', cc: ip.geo?.country_code || '', city: ip.geo?.city || '', region: ip.geo?.region || '', network: ip.as?.name || '', mobile: Boolean(ip.mobile), ms: Math.round(performance.now() - t0), at: Date.now() };
    if (my !== seq) return;
    await S.set({ phase: 'on', exit, error: null });
    /* the customer's own proxies show the country and speed they were last seen with */
    if (active.kind === 'manual') {
      const { profiles = [] } = await L.get('profiles');
      if (profiles.some((x) => x.id === active.id)) await L.set({ profiles: profiles.map((x) => (x.id === active.id ? { ...x, geo: { cc: exit.cc, city: exit.city, ip: exit.ip, ms: exit.ms, at: exit.at } } : x)) });
    }
  } catch {
    if (my !== seq) return;
    const error = { ...(await diagnose(active)), at: Date.now() };
    if (my !== seq) return;
    await S.set({ phase: 'error', exit: null, error });
  }
  paint();
}

/** Why the check failed, in words. A plain-HTTP request through the proxy shows the relay's own answer. */
async function diagnose(active) {
  if (Date.now() - authFailedAt < 30_000) return { kind: 'auth', message: 'The proxy refused the login or password.' };
  const ours = active.kind !== 'manual' || /(^|\.)aeonproxy\.com$/.test(active.host);
  try {
    const r = await timedFetch(CHECK_PLAIN, 10000, { redirect: 'manual' });
    const reason = r.headers.get('x-reason') || '';
    if (r.status === 402) return { kind: 'traffic', message: 'No traffic left on this product. Top up to keep browsing.' };
    if (r.status === 407 || Date.now() - authFailedAt < 30_000) return { kind: 'auth', message: reason && ours ? `The proxy refused the login: ${reason}.` : 'The proxy refused the login or password.' };
    if (r.status === 429) return { kind: 'limit', message: 'Too many failed logins from this address. Wait a minute and connect again.' };
    if (r.status === 403) return { kind: 'blocked', message: reason ? `The proxy refused: ${reason}.` : 'The proxy refused the connection.' };
    if (r.status >= 500) return { kind: 'upstream', message: reason && ours ? `The proxy could not reach an exit: ${reason}. Try another location or connect again.` : 'The proxy could not reach the site. Try again or pick another proxy.' };
    return { kind: 'tls', message: 'Plain pages load, but secure (HTTPS) ones do not. The proxy may not support HTTPS tunnels.' };
  } catch {
    if (Date.now() - authFailedAt < 30_000) return { kind: 'auth', message: 'The proxy refused the login or password.' };
    if (Date.now() - lastProxyError.at < 30_000) {
      if (/PROXY_CONNECTION_FAILED|NAME_NOT_RESOLVED|ADDRESS_UNREACHABLE|CONNECTION_REFUSED/.test(lastProxyError.error)) return { kind: 'unreachable', message: 'Could not reach the proxy server. Check the host and port, or your internet connection.' };
      if (/SOCKS/.test(lastProxyError.error)) return { kind: 'socks', message: active.username ? 'The SOCKS proxy refused. Chrome cannot send a login to SOCKS proxies: use the provider\'s HTTP port.' : 'The SOCKS proxy refused the connection.' };
    }
    if (active.scheme === 'socks5' && active.username) return { kind: 'socks', message: 'Chrome cannot send a login to SOCKS5 proxies. Use the HTTP port of this proxy instead.' };
    return { kind: 'timeout', message: 'The proxy did not answer in time. Try again or pick another location.' };
  }
}

/* ---------------- toolbar ---------------- */
async function paint() {
  const { enabled, active } = await L.get(['enabled', 'active']);
  const { phase, exit } = await S.get(['phase', 'exit']);
  const on = Boolean(enabled && active);
  try {
    await chrome.action.setIcon({ path: on ? { 16: '/icons/on-16.png', 32: '/icons/on-32.png' } : { 16: '/icons/off-16.png', 32: '/icons/off-32.png' } });
    if (!on) { await chrome.action.setBadgeText({ text: '' }); await chrome.action.setTitle({ title: 'AeonProxy — not connected' }); return; }
    const bad = phase === 'error';
    const text = bad ? '!' : phase === 'connecting' || phase === 'checking' ? '…' : (exit?.cc || active.cc || 'ON').toUpperCase().slice(0, 3);
    await chrome.action.setBadgeBackgroundColor({ color: bad ? CORAL : EMERALD });
    chrome.action.setBadgeTextColor?.({ color: '#FFFFFF' });
    await chrome.action.setBadgeText({ text });
    await chrome.action.setTitle({ title: bad ? `AeonProxy — ${active.label}: not working` : `AeonProxy — ${active.label}${exit?.ip ? ` · ${exit.ip}` : ''}` });
  } catch { /* the action may be unavailable while the browser shuts down */ }
}

/* ---------------- sign-in through the site ---------------- */
const TOKEN_RE = /^ape_[A-Za-z0-9_-]{20,80}$/;
async function siteToken(m, sender) {
  if (!sender.tab || !sender.url || !sender.url.startsWith(`${SITE}/dashboard/extension`)) throw new Error('Not from the site.');
  if (!TOKEN_RE.test(String(m.token || ''))) throw new Error('This sign-in is not valid.');
  let state;
  try { state = await api('/api/ext/state', { token: m.token }); } catch (e) { throw new Error(e instanceof ApiError ? e.message : 'Could not check the sign-in.'); }
  const { auth: old } = await L.get('auth');
  await L.set({ auth: { token: m.token, email: state.account.email, at: Date.now() }, state: { ...state, at: Date.now() } });
  /* the token it replaces ends on the site too, so Settings → Security does not collect stale rows */
  if (old?.token && old.token !== m.token) api('/api/ext/logout', { method: 'POST', token: old.token }).catch(() => {});
  const { pendingTab } = await S.get('pendingTab');
  if (pendingTab === sender.tab.id) { await S.remove('pendingTab'); setTimeout(() => chrome.tabs.remove(sender.tab.id).catch(() => {}), 1800); }
  return { ok: true };
}
async function openSignIn(path) {
  const tab = await chrome.tabs.create({ url: `${SITE}${path === 'signup' ? '/signup' : '/login'}?next=/dashboard/extension` });
  await S.set({ pendingTab: tab.id });
  return { ok: true };
}

/* ---------------- messages ---------------- */
chrome.runtime.onMessage.addListener((m, sender, reply) => {
  route(m || {}, sender).then(reply, (e) => reply({ ok: false, error: e.message || String(e), kind: e.kind }));
  return true;
});
async function route(m, sender) {
  if (sender.id !== chrome.runtime.id) throw new Error('Unknown sender.');
  if (m.cmd === 'siteToken') return siteToken(m, sender);
  /* everything else comes from the extension's own pages (the popup), never from a content script on a site */
  if (!String(sender.url || '').startsWith(chrome.runtime.getURL(''))) throw new Error('Not allowed from a page.');
  switch (m.cmd) {
    case 'connect': await connect(m.proxy); return { ok: true };
    case 'disconnect': await disconnect(); return { ok: true };
    case 'check': check(); return { ok: true };
    case 'reapply': await reapply(); return { ok: true };
    case 'signIn': return openSignIn(m.path);
    default: throw new Error('Unknown command.');
  }
}

/* ---------------- lifecycle ---------------- */
async function resume() {
  const { enabled, active } = await L.get(['enabled', 'active']);
  if (!enabled || !active?.applied) { await S.set({ phase: 'off' }); paint(); return; }
  const settings = await settingsOf();
  try {
    await setChromeProxy(active.scheme, active.applied.host, active.applied.port, settings);
    await setWebRtc(settings.webrtc);
    check();
  } catch (e) { await S.set({ phase: 'error', error: { kind: e.kind || 'failed', message: e.message } }); paint(); }
}
/* The site ends a sign-in after 14 days without use (the site's idle rule): a call at every browser start keeps
   the extension signed in while the browser is in use, and drops a sign-in that was ended on the site. */
async function refreshAccount() {
  const { auth } = await L.get('auth');
  if (!auth?.token) return;
  try { const state = await api('/api/ext/state', { token: auth.token }); await L.set({ state: { ...state, at: Date.now() } }); }
  catch (e) { if (e instanceof ApiError && e.status === 401) await L.remove(['auth', 'state']); }
}
chrome.runtime.onStartup.addListener(() => { resume(); refreshAccount(); });
chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await L.get('settings');
  if (!settings) await L.set({ settings: DEFAULT_SETTINGS });
  resume();
});
chrome.proxy.settings.onChange.addListener(async (d) => {
  const { enabled } = await L.get('enabled');
  if (enabled && d.levelOfControl === 'controlled_by_other_extensions') {
    await S.set({ phase: 'error', error: { kind: 'conflict', message: 'Another extension (often a VPN) took over the browser\'s proxy. Turn it off, then connect again.' } });
    paint();
  }
});
