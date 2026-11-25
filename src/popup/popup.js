/* AeonProxy extension popup. Two tabs: "AeonProxy" (the account: residential / mobile lines made by the site's API for a
   picked country, region, city and ISP, and the account's ISP / datacenter IPs) and "My proxies" (any proxy the customer
   pastes). The service worker (background.js) applies the proxy; the popup only asks it and redraws from storage. */
import { ApiError, api, authed, siteUrl } from '../lib/api.js';
import { CHECK, DEFAULT_SETTINGS, UPDATES, VERSION } from '../lib/config.js';
import { ic } from '../lib/icons.js';
import { lineOf, parseList } from '../lib/parse.js';

const L = chrome.storage.local, S = chrome.storage.session;
const $ = (s, el = document) => el.querySelector(s);
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const REGION = new Intl.DisplayNames(['en'], { type: 'region' });
const countryName = (cc) => { if (!cc) return ''; try { return REGION.of(String(cc).toUpperCase()) || String(cc).toUpperCase(); } catch { return String(cc).toUpperCase(); } };
const send = (msg) => chrome.runtime.sendMessage(msg);
/* names come lowercase from the location lists: capitalise words, and write company suffixes the way companies do
   ("deutsche telekom ag" → "Deutsche Telekom AG", not "Ag") */
const SUFFIX = { ag: 'AG', gmbh: 'GmbH', llc: 'LLC', ltd: 'Ltd', inc: 'Inc', bv: 'BV', nv: 'NV', plc: 'PLC', sas: 'SAS', srl: 'SRL', ab: 'AB', oy: 'Oy', usa: 'USA', uk: 'UK' };
const title = (s) => String(s || '').replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\b[A-Z][a-z]{1,3}\b/g, (w) => SUFFIX[w.toLowerCase()] || w);

const PRODUCTS = [
  { id: 'res', api: 'residential', name: 'Residential', icon: 'home', target: 'isp', targetName: 'ISP' },
  { id: 'mob', api: 'mobile', name: 'Mobile', icon: 'phone', target: 'carrier', targetName: 'Carrier' },
  { id: 'isp', api: 'isp', name: 'ISP', icon: 'isp' },
  { id: 'dc', api: 'datacenter', name: 'Datacenter', icon: 'server' },
];
const P = Object.fromEntries(PRODUCTS.map((p) => [p.id, p]));
const TIMES = [[60, '1 min'], [600, '10 min'], [1800, '30 min'], [3600, '1 h'], [21600, '6 h']];
const fmtTime = (s) => TIMES.find(([v]) => v === s)?.[1] || (s >= 3600 ? `${Math.round(s / 3600)} h` : `${Math.round(s / 60)} min`);
const PICK = { country: '', region: '', city: '', target: '', session: 'sticky', time: 600 };
const fmtGb = (n) => (n >= 100 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n >= 1 ? n.toFixed(2) : `${Math.round(n * 1000)} MB`).replace(/^(\d+(?:\.\d+)?)$/, '$1 GB');
const fmtDate = (iso) => { try { return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }); } catch { return ''; } };
const usd = (n) => `$${(Number(n) || 0).toFixed(2)}`;
const SCHEME_LABEL = { http: 'HTTP', https: 'HTTPS', socks5: 'SOCKS5', socks4: 'SOCKS4' };

const st = {
  tab: 'aeon', local: {}, session: {}, anim: 'view',
  signin: { step: 'form', email: '', password: '', err: '', busy: false, show: false },
  busy: '', targets: new Map(), addErr: '', addScheme: 'auto', editing: '', realIp: null, sheet: false, update: '',
};
const app = $('#app'), main = $('#main');

/* ---------------- storage ---------------- */
async function load() {
  st.local = await L.get(null);
  st.session = await S.get(null);
}
const settings = () => ({ ...DEFAULT_SETTINGS, ...(st.local.settings || {}) });
const signedIn = () => Boolean(st.local.auth && st.local.auth.token);
const aeonCfg = () => {
  const a = st.local.aeon || {};
  return { product: P[a.product] ? a.product : 'res', res: { ...PICK, ...(a.res || {}) }, mob: { ...PICK, ...(a.mob || {}) } };
};
async function saveCfg(fn) { const c = aeonCfg(); fn(c); st.local.aeon = c; await L.set({ aeon: c }); }

let paintQueued = false;
chrome.storage.onChanged.addListener((ch, area) => {
  const bag = area === 'local' ? st.local : area === 'session' ? st.session : null;
  if (!bag) return;
  for (const [k, v] of Object.entries(ch)) { if (v.newValue === undefined) delete bag[k]; else bag[k] = v.newValue; }
  const keys = Object.keys(ch);
  renderHeader();
  if (keys.some((k) => ['auth', 'state', 'profiles', 'active', 'enabled'].includes(k)) || (area === 'session' && ch.phase && (ch.phase.newValue === 'error' || ch.phase.oldValue === 'error'))) {
    if (!paintQueued) { paintQueued = true; requestAnimationFrame(() => { paintQueued = false; renderMain(false); }); }
  }
  if (keys.includes('settings')) applyTheme();
  if (ch.enabled && ch.enabled.newValue === false) realIp();
});

/* ---------------- toast ---------------- */
let toastT = 0;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2400);
}
async function copy(text) {
  try { await navigator.clipboard.writeText(text); }
  catch { const ta = document.createElement('textarea'); ta.value = text; document.body.append(ta); ta.select(); document.execCommand('copy'); ta.remove(); }
  toast('Copied');
}
function openSite(path) { chrome.tabs.create({ url: siteUrl(path) }); window.close(); }

/* ---------------- header: status + exit ---------------- */
function renderHeader() {
  const { enabled, active } = st.local, { phase = 'off', exit, error } = st.session;
  const on = Boolean(enabled && active), busy = on && (phase === 'connecting' || phase === 'checking'), bad = on && phase === 'error';
  app.classList.toggle('is-on', on && !bad && !busy);
  app.classList.toggle('is-err', bad);
  app.classList.toggle('is-busy', busy);
  const kicker = !on ? 'Not connected' : bad ? 'Not working' : phase === 'connecting' ? 'Connecting' : phase === 'checking' ? 'Checking the IP' : 'Connected';
  const t = on ? active.label : 'Direct connection';
  const sub = on ? active.sub || `${active.host}:${active.port}` : active ? `Last used: ${active.label}` : 'Sites see your own IP address';
  $('#status').innerHTML = `
    <div class="st-txt"><div class="st-k"><span class="dot"></span>${esc(kicker)}</div><div class="st-t" title="${esc(t)}">${esc(t)}</div><div class="st-s" title="${esc(sub)}">${esc(sub)}</div></div>
    <button type="button" class="power" id="power" aria-pressed="${on}" title="${on ? 'Turn the proxy off' : active ? 'Connect again' : 'Pick a proxy below'}" aria-label="${on ? 'Turn the proxy off' : 'Turn the proxy on'}"><span class="knob">${ic('power', 14, 2.6)}</span></button>`;
  const ex = $('#exit');
  ex.className = 'exit';
  if (on && busy) ex.innerHTML = `<span class="cc">${ic('globe', 14)}</span><div class="exit-main"><span class="sk" style="width:62%"></span><span class="sk" style="width:84%"></span></div>`;
  else if (on && bad) {
    ex.className = 'exit exit-err';
    const kind = error?.kind || '';
    const extra = kind === 'traffic' ? `<button type="button" class="hbtn pri" data-act="topup">Top up</button>` : kind === 'conflict' ? '' : `<button type="button" class="hbtn" data-act="off">Turn off</button>`;
    ex.innerHTML = `${ic('warn', 16)}<div class="exit-main"><b>${esc(error?.message || 'The proxy is not answering.')}</b><div class="acts"><button type="button" class="hbtn" data-act="retry">${ic('refresh', 12)}Try again</button>${extra}</div></div>`;
  } else if (on) {
    const where = [exit?.city, countryName(exit?.cc)].filter(Boolean).join(', ') || 'Connected';
    const line = [exit?.ip, exit?.network].filter(Boolean).join(' · ');
    ex.innerHTML = `<span class="cc">${esc(exit?.cc || active.cc || '··')}</span><div class="exit-main"><b title="${esc(where)}">${esc(where)}</b><span title="${esc(line)}">${esc(line || `${active.host}:${active.port}`)}</span></div>${exit?.ms ? `<span class="ms">${exit.ms} ms</span>` : ''}<button type="button" class="ib" data-act="recheck" title="Check the IP again" aria-label="Check the IP again">${ic('refresh', 14)}</button><button type="button" class="ib" data-act="copyActive" title="Copy this proxy" aria-label="Copy this proxy">${ic('copy', 14)}</button>`;
  } else {
    const r = st.realIp;
    ex.innerHTML = r ? `<span class="cc">${esc(r.cc || '··')}</span><div class="exit-main"><b>Your own IP · ${esc([r.city, countryName(r.cc)].filter(Boolean).join(', '))}</b><span>${esc([r.ip, r.network].filter(Boolean).join(' · '))}</span></div>`
      : `<span class="cc">${ic('globe', 14)}</span><div class="exit-main exit-idle">Pick a location or one of your proxies and connect.</div>`;
  }
}

/* ---------------- tabs ---------------- */
function renderTabs() {
  $('#tabs').dataset.tab = st.tab;
  for (const b of document.querySelectorAll('.tab')) b.setAttribute('aria-selected', String(b.dataset.tab === st.tab));
}

/* ---------------- main ---------------- */
function renderMain(animate = true) {
  /* never redraw under the customer's fingers: a focused field keeps its value; we redraw on blur */
  const f = document.activeElement;
  if (!animate && f && main.contains(f) && /^(INPUT|TEXTAREA|SELECT)$/.test(f.tagName)) { f.addEventListener('blur', () => renderMain(false), { once: true }); return; }
  const top = main.scrollTop;
  const html = st.tab === 'mine' ? mineView() : signedIn() ? aeonView() : signInView();
  main.innerHTML = `<div class="view${animate ? '' : ' still'}${animate && st.anim !== 'view' ? ` ${st.anim}` : ''}">${html}</div>`;
  if (!animate) { main.firstElementChild.style.animation = 'none'; main.scrollTop = top; for (const el of main.querySelectorAll('.stagger>*')) el.style.animation = 'none'; }
  else main.scrollTop = 0;
  st.anim = 'view';
  const ta = $('#addText');
  if (ta && st.addDraft) ta.value = st.addDraft;
}

/* ----- AeonProxy tab, signed in ----- */
function aeonView() {
  const c = aeonCfg(), prod = c.product, s = st.local.state;
  const prods = `<div class="prods" role="group" aria-label="Product">${PRODUCTS.map((p) => `<button type="button" class="prod" data-prod="${p.id}" aria-pressed="${p.id === prod}">${ic(p.icon, 18)}<span>${p.name}</span></button>`).join('')}</div>`;
  const pane = prod === 'res' || prod === 'mob' ? trafficPane(prod, c[prod], s) : ipPane(prod, s);
  const bal = s ? `<span>Balance <b>${usd(s.account?.balance_usd)}</b></span><a href="#" data-open="/dashboard/wallet">Top up ${ic('ext', 12)}</a>` : '<span>Loading your account…</span>';
  return `${prods}${pane}<div class="foot">${bal}</div>`;
}

function trafficPane(prod, pick, s) {
  const p = P[prod], t = s?.traffic?.[p.api] || { gb_left: 0, gb_total: 0 };
  const left = Number(t.gb_left) || 0, total = Number(t.gb_total) || 0, pct = total > 0 ? Math.max(2, Math.min(100, (left / total) * 100)) : 0;
  const meter = !s ? `<div class="meter"><span class="sk" style="width:40%;background:var(--surface-2)"></span></div>`
    : left > 0 ? `<div class="meter"><div class="meter-top"><span><b>${fmtGb(left)}</b> <small>left</small></span><small>of ${fmtGb(total)} · <a href="#" data-open="/dashboard/${prod === 'res' ? 'residential' : 'mobile'}#buy">Add traffic</a></small></div><div class="bar${pct < 15 ? ' low' : ''}"><i style="width:${pct}%"></i></div></div>`
      : `<div class="note note-warn">${ic('info')}<span>No ${p.name.toLowerCase()} traffic on your account yet. <a href="#" data-open="/dashboard/${prod === 'res' ? 'residential' : 'mobile'}#buy">Buy traffic</a> — it never expires.</span></div>`;
  const ccTile = pick.country ? `<span class="cc">${esc(pick.country.toUpperCase())}</span>` : `<span class="cc">${ic('globe', 14)}</span>`;
  const nSet = [pick.region, pick.city, pick.target].filter(Boolean).length;
  const dis = pick.country ? '' : ' disabled';
  const sel = (k, v, ph) => `<button type="button" class="sel sm" data-pick="${k}"${dis} aria-haspopup="listbox" aria-expanded="false"><span class="v${v ? '' : ' ph'}">${esc(v ? title(v) : ph)}</span>${ic('chev-d', 14)}</button>`;
  const a = st.local.active, live = st.local.enabled && a?.kind === 'aeon' && a.product === prod && sameCfg(a.cfg, pick);
  const sticky = pick.session === 'sticky';
  return `
    ${meter}
    <div class="fld"><span class="lbl">Location<button type="button" class="linkb more-link" data-act="more">${nSet ? `Region, city, ${p.targetName === 'ISP' ? 'ISP' : 'carrier'} · ${nSet}` : `+ Region, city, ${p.targetName === 'ISP' ? 'ISP' : 'carrier'}`}</button></span><button type="button" class="sel" data-pick="country" aria-haspopup="listbox" aria-expanded="false">${ccTile}<span class="v${pick.country ? '' : ' ph'}">${esc(pick.country ? countryName(pick.country) : 'Any country')}</span>${ic('chev-d', 15)}</button></div>
    <div class="fld"><label>Session</label><div class="sess"><div class="seg" role="group" aria-label="Session"><button type="button" data-session="sticky" aria-pressed="${sticky}">Sticky IP</button><button type="button" data-session="rotating" aria-pressed="${!sticky}">Rotating</button></div>${sticky ? `<button type="button" class="sel sm" data-pick="time" aria-haspopup="listbox" aria-expanded="false" title="Keep the IP for">${ic('clock', 14)}<span class="v">${fmtTime(pick.time)}</span>${ic('chev-d', 14)}</button>` : ''}</div>
      <p class="hint">${sticky ? `One IP for up to ${fmtTime(pick.time)}. <b>New IP</b> changes it sooner.` : 'A new IP for every connection. Sites may sign you out between pages.'}</p>
    </div>
    <details class="more"${nSet ? ' open' : ''}><summary>${ic('chev-d', 13)}Region, city and ${p.targetName === 'ISP' ? 'ISP' : 'carrier'}${nSet ? `<span class="cnt">${nSet}</span>` : ''}</summary>
      <div class="grid2"><div class="fld"><span class="lbl">Region <span class="opt">optional</span></span>${sel('region', pick.region, pick.country ? 'Any region' : 'Pick a country')}</div><div class="fld"><span class="lbl">City <span class="opt">optional</span></span>${sel('city', pick.city, pick.country ? 'Any city' : 'Pick a country')}</div></div>
      <div class="fld"><span class="lbl">${p.targetName} <span class="opt">optional</span></span>${sel('target', pick.target, pick.country ? `Any ${p.targetName === 'ISP' ? 'ISP' : 'carrier'}` : 'Pick a country')}</div>
    </details>
    <div class="cta stick">${live
      ? `<button type="button" class="btn btn-primary btn-lg" data-act="connectAeon" data-fresh="1">${st.busy === 'aeon' ? '<span class="spin"></span>' : ic('refresh')}${sticky ? 'New IP' : 'Reconnect'}</button><button type="button" class="btn btn-secondary btn-lg" data-act="off">Disconnect</button>`
      : `<button type="button" class="btn btn-primary btn-lg"${left > 0 || !s ? '' : ' disabled'} data-act="connectAeon">${st.busy === 'aeon' ? '<span class="spin"></span>Connecting…' : `${ic('zap')}Connect`}</button>`}</div>`;
}
const sameCfg = (a, b) => Boolean(a && b) && ['country', 'region', 'city', 'target', 'session', 'time'].every((k) => (a[k] ?? '') === (b[k] ?? ''));

function ipPane(prod, s) {
  const p = P[prod];
  if (!s) return `<div class="list" style="margin-top:12px"><div class="row"><span class="cc"></span><div class="row-main"><span class="sk" style="width:50%;background:var(--surface-2)"></span><span class="sk" style="width:70%;background:var(--surface-2)"></span></div></div></div>`;
  const ips = (s.ips || []).filter((x) => x.product === p.api);
  const a = st.local.active, en = st.local.enabled;
  const setting = s.ips_setting_up ? `<div class="note note-acc">${ic('clock')}<span>${s.ips_setting_up === 1 ? 'One IP is' : `${s.ips_setting_up} IPs are`} being set up. They show here in a minute or two.</span></div>` : '';
  if (!ips.length) {
    const blurb = prod === 'isp' ? 'Static IPs from home internet providers, yours for the whole month.' : 'Fast static IPs, rented from three days to a month.';
    return `${setting}<div class="empty" style="margin-top:12px"><span class="ico">${ic(p.icon, 20)}</span><b>No ${p.name} IPs yet</b><p>${blurb} Buy them in the dashboard and they appear here, ready to connect.</p><button type="button" class="btn btn-primary btn-sm" data-open="/dashboard/${prod === 'isp' ? 'isp' : 'datacenter'}">${ic('plus')}Buy ${p.name} proxies</button></div>`;
  }
  const failing = st.session.phase === 'error';
  const rows = ips.map((x, i) => {
    const on = en && a?.kind === 'ip' && a.id === ipId(x);
    const meta = [countryName(x.country), x.tag, x.next_due ? `${x.auto_renew ? 'renews' : 'ends'} ${fmtDate(x.next_due)}` : ''].filter(Boolean).join(' · ');
    return `<div class="row${on ? (failing ? ' bad' : ' on') : ''}"><span class="cc">${esc(x.country || '··')}</span><div class="row-main" data-ip="${i}"><div class="row-t"><span class="mono">${esc(x.ip)}</span>${x.status === 'pending' ? '<span class="badge warn">unpaid</span>' : ''}</div><div class="row-s">${esc(meta)}</div></div><button type="button" class="ib2" data-copyip="${i}" title="Copy proxy" aria-label="Copy proxy">${ic('copy', 15)}</button><button type="button" class="go${on ? (failing ? ' bad' : ' on') : ''}" data-ip="${i}">${on ? (failing ? 'Retry' : `${ic('check', 13, 2.6)}On`) : 'Connect'}</button></div>`;
  }).join('');
  return `${setting}<div class="sect"><span>${p.name} IPs · ${ips.length}</span><a href="#" data-open="/dashboard/${prod === 'isp' ? 'isp' : 'datacenter'}">Buy more</a></div><div class="list stagger">${rows}</div>`;
}
const ipId = (x) => `ip-${x.order_id}-${x.ip}`;
const ipsOf = (prod) => (st.local.state?.ips || []).filter((x) => x.product === P[prod].api);

/* ----- AeonProxy tab, signed out ----- */
function signInView() {
  const si = st.signin;
  const mark = `<svg width="46" height="46" viewBox="0 0 64 64" fill="none" aria-hidden="true"><mask id="mk2" maskUnits="userSpaceOnUse" x="0" y="0" width="64" height="64"><rect width="64" height="64" fill="#fff"/><circle cx="32" cy="32" r="8.5" fill="#000"/></mask><path d="M32 32C40 20 58 20 58 32C58 44 40 44 32 32C24 20 6 20 6 32C6 44 24 44 32 32Z" stroke="#fff" stroke-width="7" stroke-linejoin="round" mask="url(#mk2)"/><path class="mark-run" d="M32 32C40 20 58 20 58 32C58 44 40 44 32 32C24 20 6 20 6 32C6 44 24 44 32 32Z" stroke="#9FE6D6" stroke-width="7" stroke-linejoin="round" mask="url(#mk2)" pathLength="100"/><circle cx="32" cy="32" r="5.5" fill="#9FE6D6"/></svg>`;
  const form = si.step === 'code'
    ? `<p class="hint" style="margin:0 0 2px;text-align:center">Enter the 6-digit code we sent to your Telegram.</p><input class="inp code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="••••••" required autofocus><button type="submit" class="btn btn-primary btn-block"${si.busy ? ' disabled' : ''}>${si.busy ? '<span class="spin"></span>' : ''}Confirm</button><button type="button" class="btn btn-ghost btn-sm" data-act="backToForm">Back</button>`
    : `<input class="inp" type="email" name="email" placeholder="Email" autocomplete="username" required value="${esc(si.email)}"><div class="pw"><input class="inp" type="${si.show ? 'text' : 'password'}" name="password" placeholder="Password" autocomplete="current-password" required value="${esc(si.password)}"><button type="button" data-act="eye" aria-label="${si.show ? 'Hide' : 'Show'} password">${ic(si.show ? 'eye-off' : 'eye', 15)}</button></div><button type="submit" class="btn btn-secondary btn-block"${si.busy ? ' disabled' : ''}>${si.busy ? '<span class="spin"></span>' : ''}Sign in</button>`;
  return `
    <div class="signin"><div class="loopart">${mark}</div><h2>Your AeonProxy proxies in the browser</h2><p>Sign in to pick a country, city or ISP, or one of your static IPs, and connect in two clicks.</p>
      <button type="button" class="btn btn-primary btn-lg btn-block" data-act="siteSignIn">${ic('ext')}Sign in with aeonproxy.com</button></div>
    <div class="or">or with email</div>
    <form class="form" id="loginForm" novalidate>${form}${si.err ? `<div class="err" role="alert">${esc(si.err)}</div>` : ''}</form>
    <p class="fine">New to AeonProxy? <a href="#" data-act="signup">Create an account</a></p>`;
}

/* ----- My proxies tab ----- */
function mineView() {
  const list = st.local.profiles || [], a = st.local.active, en = st.local.enabled, failing = st.session.phase === 'error';
  const rows = list.map((pr) => {
    const on = en && a?.kind === 'manual' && a.id === pr.id;
    const g = pr.geo;
    const tile = g?.cc ? esc(g.cc) : ic(pr.scheme.startsWith('socks') ? 'link' : 'globe', 14);
    const meta = [`<span class="mono">${esc(pr.host)}:${pr.port}</span>`, pr.username ? `login ${esc(pr.username.length > 18 ? `${pr.username.slice(0, 16)}…` : pr.username)}` : 'no login', g?.ms ? `${g.ms} ms` : ''].filter(Boolean).join(' · ');
    const name = st.editing === pr.id
      ? `<input class="inp" style="height:30px;font-size:12.5px" data-rename="${esc(pr.id)}" value="${esc(pr.name)}" maxlength="40" aria-label="Name">`
      : `<div class="row-t">${esc(pr.name)} <span class="badge${on ? ' on' : ''}">${SCHEME_LABEL[pr.scheme] || pr.scheme}</span>${pr.scheme === 'socks5' && pr.username ? '<span class="badge warn" title="Chrome cannot send a login to SOCKS5 proxies">login?</span>' : ''}</div>`;
    return `<div class="row${on ? (failing ? ' bad' : ' on') : ''}"><span class="cc">${tile}</span><div class="row-main" data-prof="${esc(pr.id)}">${name}<div class="row-s">${meta}</div></div><button type="button" class="ib2" data-menu="${esc(pr.id)}" title="More" aria-label="More">${ic('dots', 16)}</button><button type="button" class="go${on ? (failing ? ' bad' : ' on') : ''}" data-prof="${esc(pr.id)}">${on ? (failing ? 'Retry' : `${ic('check', 13, 2.6)}On`) : 'Connect'}</button></div>`;
  }).join('');
  const add = `<div class="add"><textarea class="ta" id="addText" spellcheck="false" autocomplete="off" placeholder="Paste a proxy, or a list of them (one per line)&#10;host:port:login:password · login:password@host:port&#10;socks5://host:port"></textarea>
    <div class="add-foot"><select id="addScheme" aria-label="Protocol">${[['auto', 'Protocol: auto'], ['http', 'HTTP'], ['https', 'HTTPS'], ['socks5', 'SOCKS5'], ['socks4', 'SOCKS4']].map(([v, l]) => `<option value="${v}"${st.addScheme === v ? ' selected' : ''}>${l}</option>`).join('')}</select><button type="button" class="btn btn-primary btn-sm" data-act="add">${ic('plus')}Add proxy</button></div>
    ${st.addErr ? `<div class="err" role="alert">${esc(st.addErr)}</div>` : ''}</div>`;
  const body = list.length ? `<div class="sect"><span>Saved · ${list.length}</span></div><div class="list stagger">${rows}</div>`
    : `<div class="empty" style="margin-top:12px"><span class="ico">${ic('list', 20)}</span><b>Bring any proxy</b><p>HTTP, HTTPS or SOCKS proxies from any provider. They are kept in this browser only.</p></div>`;
  return `${add}${body}`;
}

/* ---------------- settings sheet ---------------- */
function renderSheet() {
  const s = settings(), auth = st.local.auth;
  $('#sheet').innerHTML = `
    <div class="sheet-hd"><button type="button" class="ib" data-act="closeSheet" aria-label="Back">${ic('chev-l', 18)}</button><h2>Settings</h2></div>
    <div class="sheet-b">
      ${st.update ? `<a href="#" class="upd" data-open="/browser-extension#update">${ic('download', 18)}<div><b>Version ${esc(st.update)} is out</b><span>You have ${esc(VERSION)}. Download it and unzip it over the old folder.</span></div>${ic('chev-r', 16)}</a>` : ''}
      <div class="card"><div class="acct"><span class="av">${auth ? esc(auth.email.slice(0, 1).toUpperCase()) : ic('user', 16)}</span><div><b>${auth ? esc(auth.email) : 'Not signed in'}</b><span>${auth ? 'AeonProxy account' : 'Your own proxies work without an account'}</span></div>${auth ? `<button type="button" class="btn btn-ghost btn-sm" data-act="signOut">${ic('logout', 14)}Sign out</button>` : `<button type="button" class="btn btn-soft btn-sm" data-act="siteSignIn">Sign in</button>`}</div></div>
      <div class="sect">Privacy</div>
      <div class="card"><div class="set"><div><b>WebRTC leak protection</b><p>Stops sites from reading your real IP address through WebRTC while a proxy is on.</p></div><button type="button" class="sw" role="switch" aria-checked="${s.webrtc}" data-act="webrtc" aria-label="WebRTC leak protection"></button></div></div>
      <div class="sect">Open these directly</div>
      <div class="card"><textarea class="ta" id="bypass" spellcheck="false" placeholder="example.com&#10;*.mybank.com&#10;192.168.0.0/16">${esc((s.bypass || []).join('\n'))}</textarea><p class="hint">One site per line. They skip the proxy and see your own IP.</p><button type="button" class="btn btn-secondary btn-sm" data-act="saveBypass" style="margin-top:8px">Save list</button></div>
      <div class="sect">Theme</div>
      <div class="seg" role="group" aria-label="Theme">${['system', 'light', 'dark'].map((t) => `<button type="button" data-theme-pick="${t}" aria-pressed="${s.theme === t}">${title(t)}</button>`).join('')}</div>
      <div class="sect">Help</div>
      <div class="links"><a href="#" data-open="/dashboard">${ic('home', 15)}Dashboard</a><a href="#" data-open="/docs">${ic('book', 15)}Setup guides</a><a href="#" data-open="/contact">${ic('headset', 15)}Support</a><a href="#" data-open="/privacy">${ic('shield', 15)}Privacy</a></div>
      <p class="ver">AeonProxy extension ${esc(VERSION)}</p>
    </div>`;
}
function openSheet(open) {
  st.sheet = open;
  if (open) renderSheet();
  const sh = $('#sheet');
  sh.classList.toggle('open', open);
  sh.setAttribute('aria-hidden', String(!open));
}
function applyTheme() {
  const t = settings().theme;
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; else delete document.documentElement.dataset.theme;
  try { localStorage.setItem('ap-theme', t); } catch { /* no storage */ }
}

/* ---------------- picker (searchable list) ---------------- */
function picker(anchor, { items, value, placeholder, remote, plain = false }) {
  return new Promise((resolve) => {
    const layer = $('#ddLayer');
    layer.hidden = false;
    layer.innerHTML = `<div class="dd${plain ? ' plain' : ''}" role="dialog"><div class="dd-search">${ic('search', 15)}<input type="text" placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}" autocomplete="off" spellcheck="false"></div><div class="dd-list" role="listbox"></div></div>`;
    const dd = $('.dd', layer), input = $('input', dd), list = $('.dd-list', dd);
    const ar = anchor.getBoundingClientRect(), H = app.clientHeight, below = H - ar.bottom - 10, above = ar.top - 10;
    const max = Math.min(360, Math.max(below, above)), need = plain ? Math.min(360, items.length * 38 + 10) : 260;
    dd.style.maxHeight = `${max}px`;
    if (plain) { dd.style.left = `${Math.max(12, ar.right - 200)}px`; dd.style.right = 'auto'; dd.style.width = '200px'; }
    if (below >= need || below >= above) dd.style.top = `${ar.bottom + 6}px`; else dd.style.bottom = `${H - ar.top + 6}px`;
    anchor.setAttribute('aria-expanded', 'true');
    let shown = [], hi = 0, seq = 0;
    const draw = (rows, emptyText) => {
      shown = rows;
      hi = Math.max(0, rows.findIndex((r) => r.v === value));
      list.innerHTML = rows.length ? rows.map((r, i) => `<button type="button" class="dd-item${i === hi ? ' hi' : ''}" role="option" data-i="${i}" aria-selected="${r.v === value}">${r.cc !== undefined ? `<span class="cc">${r.cc ? esc(r.cc) : ic('globe', 12)}</span>` : ''}<span class="n">${esc(r.label)}</span>${r.note ? `<small>${esc(r.note)}</small>` : ''}</button>`).join('') : `<div class="dd-empty">${esc(emptyText || 'Nothing found')}</div>`;
      list.querySelector('.hi')?.scrollIntoView({ block: 'nearest' });
    };
    const filter = async () => {
      const q = input.value.trim().toLowerCase(), my = ++seq;
      if (remote) {
        list.innerHTML = '<div class="dd-empty">Searching…</div>';
        try { const rows = await remote(q); if (my === seq) draw(rows); } catch (e) { if (my === seq) draw([], e.message); }
        return;
      }
      draw(items.filter((r) => !q || r.label.toLowerCase().includes(q) || (r.v && r.v.toLowerCase() === q) || (r.cc && r.cc.toLowerCase() === q)));
    };
    const done = (v) => { layer.hidden = true; layer.innerHTML = ''; anchor.setAttribute('aria-expanded', 'false'); anchor.focus(); resolve(v); };
    let t = 0;
    input.addEventListener('input', () => { clearTimeout(t); t = setTimeout(filter, remote ? 220 : 0); });
    const onKey = (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!shown.length) return;
        hi = (hi + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length;
        list.querySelectorAll('.dd-item').forEach((b, i) => b.classList.toggle('hi', i === hi));
        list.querySelector('.hi')?.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') { e.preventDefault(); if (shown[hi]) done(shown[hi].v); }
      else if (e.key === 'Escape') { e.preventDefault(); done(undefined); }
    };
    input.addEventListener('keydown', onKey);
    list.addEventListener('click', (e) => { const b = e.target.closest('.dd-item'); if (b) done(shown[+b.dataset.i].v); });
    layer.onmousedown = (e) => { if (e.target === layer) done(undefined); };
    filter();
    /* a list without a search box takes the keys itself */
    if (plain) { list.tabIndex = -1; list.addEventListener('keydown', onKey); list.focus(); } else input.focus();
  });
}

/* ---------------- data ---------------- */
let stateLoading = null;
function loadState() {
  if (!signedIn()) return Promise.resolve();
  stateLoading ??= authed('/api/ext/state').then((r) => L.set({ state: { ...r, at: Date.now() } }), (e) => { if (e.status !== 401) toast(e.message); }).finally(() => { stateLoading = null; });
  return stateLoading;
}
async function countries(prod) {
  const cache = st.local.countries || {}, hit = cache[prod];
  if (hit && Date.now() - hit.at < 24 * 3600_000 && hit.list?.length) return hit.list;
  const r = await authed(`/api/v1/locations/countries?product=${P[prod].api}`);
  const list = r.results.map((c) => ({ code: c.code, name: countryName(c.code) || c.name }));
  await L.set({ countries: { ...cache, [prod]: { at: Date.now(), list } } });
  return list;
}
async function targets(prod, cc) {
  const key = `${prod}:${cc}`;
  if (!st.targets.has(key)) {
    const q = `product=${P[prod].api}&country=${cc}`;
    st.targets.set(key, Promise.all([authed(`/api/v1/locations/regions?${q}`), authed(`/api/v1/locations/isps?${q}`)]).then(([r, i]) => ({ regions: r.results, isps: i.results })).catch((e) => { st.targets.delete(key); throw e; }));
  }
  return st.targets.get(key);
}

async function connect(proxy, busyKey) {
  st.busy = busyKey; renderMain(false);
  try {
    const r = await send({ cmd: 'connect', proxy });
    if (!r?.ok) toast(r?.error || 'Could not connect.');
  } catch (e) { toast(e.message || 'Could not connect.'); }
  finally { st.busy = ''; renderMain(false); }
}

async function connectAeon() {
  const c = aeonCfg(), prod = c.product, p = P[prod], pick = c[prod], s = st.local.state;
  const body = { product: p.api, session: pick.session, protocol: 'http', count: 1, format: 'host:port:user:pass' };
  if (pick.session === 'sticky') body.time = pick.time;
  if (pick.country) body.country = pick.country;
  if (pick.country && pick.region) body.region = pick.region;
  if (pick.country && pick.city) body.city = pick.city;
  if (pick.country && pick.target) body[p.target] = pick.target;
  st.busy = 'aeon'; renderMain(false);
  let line;
  try { line = (await authed('/api/v1/proxy-list', { body })).results[0]; }
  catch (e) { st.busy = ''; renderMain(false); toast(e.message); return; }
  const where = [pick.city && title(pick.city), pick.region && !pick.city && title(pick.region), pick.target && title(pick.target)].filter(Boolean);
  await connect({
    kind: 'aeon', id: `aeon-${prod}`, product: prod, cfg: { ...pick },
    label: `${p.name} · ${pick.country ? countryName(pick.country) : 'Any country'}`,
    sub: [...where, pick.session === 'sticky' ? `Sticky ${fmtTime(pick.time)}` : 'Rotating'].join(' · '),
    scheme: 'http', host: line.host, hostIp: s?.gate?.host === line.host ? s.gate.ip : null, port: line.port, username: line.username, password: line.password, cc: pick.country || null,
  }, 'aeon');
}
function connectIp(prod, i) {
  const x = ipsOf(prod)[i];
  if (!x) return;
  return connect({ kind: 'ip', id: ipId(x), product: prod, label: `${P[prod].name} · ${x.ip}`, sub: [countryName(x.country), x.tag].filter(Boolean).join(' · '), scheme: 'http', host: x.host, hostIp: x.host_ip, port: x.port_http, username: x.username, password: x.password, cc: x.country }, `ip${i}`);
}
function connectProfile(id) {
  const pr = (st.local.profiles || []).find((x) => x.id === id);
  if (!pr) return;
  return connect({ kind: 'manual', id: pr.id, label: pr.name, sub: `${SCHEME_LABEL[pr.scheme]} · ${pr.host}:${pr.port}`, scheme: pr.scheme, host: pr.host, port: pr.port, username: pr.username, password: pr.password, cc: pr.geo?.cc || null }, `p${id}`);
}

async function addProxies() {
  const ta = $('#addText'), text = ta.value;
  const scheme = $('#addScheme').value;
  const { ok, bad } = parseList(text, scheme === 'auto' ? 'http' : scheme);
  if (!ok.length) { st.addErr = bad[0] ? (bad.length === 1 ? bad[0].error : `Line ${bad[0].line}: ${bad[0].error}`) : 'Paste a proxy first.'; st.addDraft = text; renderMain(false); return; }
  const list = [...(st.local.profiles || [])];
  let added = 0;
  for (const p of ok) {
    if (list.some((x) => x.host === p.host && x.port === p.port && x.username === p.username && x.password === p.password && x.scheme === p.scheme)) continue;
    if (list.length >= 500) break;
    const name = /(^|\.)aeonproxy\.com$/.test(p.host) ? `AeonProxy ${p.username.match(/-cc-([a-z]{2})/)?.[1]?.toUpperCase() || ''}`.trim() : p.host;
    list.unshift({ id: crypto.randomUUID(), name: name.slice(0, 40), ...p, added: Date.now() });
    added++;
  }
  await L.set({ profiles: list });
  st.addErr = bad.length ? `${bad.length} line${bad.length === 1 ? ' was' : 's were'} not added: line ${bad[0].line} — ${bad[0].error}` : '';
  st.addDraft = '';
  st.local.profiles = list;
  renderMain(false);
  toast(added ? `${added === 1 ? 'Proxy' : `${added} proxies`} added` : 'Already in your list');
}

function proxyMenu(anchor, id) {
  const pr = (st.local.profiles || []).find((x) => x.id === id);
  if (!pr) return;
  const layer = $('#ddLayer');
  layer.hidden = false;
  const r = anchor.getBoundingClientRect();
  layer.innerHTML = `<div class="menu" role="menu" style="right:${app.clientWidth - r.right}px;${r.bottom + 130 > app.clientHeight ? `bottom:${app.clientHeight - r.top + 4}px` : `top:${r.bottom + 4}px`}"><button type="button" data-m="copy">${ic('copy', 15)}Copy proxy line</button><button type="button" data-m="rename">${ic('edit', 15)}Rename</button><button type="button" class="bad" data-m="delete">${ic('trash', 15)}Delete</button></div>`;
  const close = () => { layer.hidden = true; layer.innerHTML = ''; };
  layer.onmousedown = (e) => { if (e.target === layer) close(); };
  layer.querySelector('.menu').onclick = async (e) => {
    const b = e.target.closest('button'); if (!b) return;
    close();
    if (b.dataset.m === 'copy') copy(lineOf(pr));
    if (b.dataset.m === 'rename') { st.editing = id; renderMain(false); const inp = main.querySelector('[data-rename]'); inp?.focus(); inp?.select(); }
    if (b.dataset.m === 'delete') {
      const list = (st.local.profiles || []).filter((x) => x.id !== id);
      await L.set({ profiles: list });
      if (st.local.enabled && st.local.active?.kind === 'manual' && st.local.active.id === id) await send({ cmd: 'disconnect' });
      toast('Proxy deleted');
    }
  };
}
async function rename(id, value) {
  const name = value.trim().slice(0, 40);
  st.editing = '';
  const list = (st.local.profiles || []).map((x) => (x.id === id && name ? { ...x, name } : x));
  await L.set({ profiles: list });
  renderMain(false);
}

/* ---------------- events ---------------- */
document.addEventListener('click', async (e) => {
  const t = e.target.closest('button, a, [data-ip], [data-prof]');
  if (!t) return;
  const d = t.dataset;
  if (t.tagName === 'A' && (d.open || d.act || t.id === 'brand')) e.preventDefault();
  if (t.id === 'brand') return openSite('/');
  if (d.open) return openSite(d.open);
  if (t.id === 'power') {
    if (st.local.enabled) return send({ cmd: 'disconnect' });
    const a = st.local.active;
    if (!a) { toast('Pick a proxy below first'); return; }
    return connect(a, '');
  }
  if (t.id === 'btnSettings') return openSheet(true);
  if (t.classList.contains('tab')) {
    if (st.tab === d.tab) return;
    st.anim = d.tab === 'mine' ? 'from-r' : 'from-l'; st.tab = d.tab; renderTabs(); renderMain(); S.set({ tab: d.tab });
    return;
  }
  if (d.prod) {
    await saveCfg((c) => { c.product = d.prod; });
    st.anim = 'view'; renderMain();
    if (d.prod === 'isp' || d.prod === 'dc') loadState();
    return;
  }
  if (d.session) { await saveCfg((c) => { c[c.product].session = d.session; }); return renderMain(false); }
  if (d.pick) return pick(t, d.pick);
  if (d.ip !== undefined && t.closest('.row')) {
    const prod = aeonCfg().product, x = ipsOf(prod)[+d.ip];
    if (st.local.enabled && st.local.active?.id === (x && ipId(x)) && st.session.phase !== 'error') return;
    return connectIp(prod, +d.ip);
  }
  if (d.copyip !== undefined) { const x = ipsOf(aeonCfg().product)[+d.copyip]; if (x) copy(`${x.host}:${x.port_http}:${x.username}:${x.password}`); return; }
  if (d.prof && !t.matches('input')) {
    if (st.editing === d.prof) return;
    if (st.local.enabled && st.local.active?.kind === 'manual' && st.local.active.id === d.prof && st.session.phase !== 'error') return;
    return connectProfile(d.prof);
  }
  if (d.menu) return proxyMenu(t, d.menu);
  if (d.themePick) { await L.set({ settings: { ...settings(), theme: d.themePick } }); st.local.settings = { ...settings(), theme: d.themePick }; applyTheme(); return renderSheet(); }
  switch (d.act) {
    case 'connectAeon': return connectAeon();
    case 'off': return send({ cmd: 'disconnect' });
    case 'retry': { const a = st.local.active; return a && connect(a, ''); }
    case 'recheck': return send({ cmd: 'check' });
    case 'topup': return openSite(st.local.active?.product === 'mob' ? '/dashboard/mobile#buy' : '/dashboard/residential#buy');
    case 'copyActive': { const a = st.local.active; if (a) copy(lineOf(a)); return; }
    case 'siteSignIn': await send({ cmd: 'signIn' }); window.close(); return;
    case 'signup': await send({ cmd: 'signIn', path: 'signup' }); window.close(); return;
    case 'eye': { const f = $('#loginForm'); st.signin.email = f.email.value; st.signin.password = f.password.value; st.signin.show = !st.signin.show; return renderMain(false); }
    case 'backToForm': st.signin = { ...st.signin, step: 'form', err: '' }; return renderMain(false);
    case 'add': return addProxies();
    case 'more': { const det = main.querySelector('details.more'); if (det) { det.open = true; det.scrollIntoView({ behavior: 'smooth', block: 'center' }); } return; }
    case 'closeSheet': return openSheet(false);
    case 'webrtc': { const v = !settings().webrtc; const s = { ...settings(), webrtc: v }; await L.set({ settings: s }); st.local.settings = s; await send({ cmd: 'reapply' }); renderSheet(); return toast(v ? 'WebRTC protection on' : 'WebRTC protection off'); }
    case 'saveBypass': {
      const bypass = $('#bypass').value.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean).slice(0, 200);
      const s = { ...settings(), bypass }; await L.set({ settings: s }); st.local.settings = s; await send({ cmd: 'reapply' }); renderSheet(); return toast('Saved');
    }
    case 'signOut': {
      const { auth } = await L.get('auth');
      if (auth?.token) api('/api/ext/logout', { method: 'POST', token: auth.token }).catch(() => {});
      await L.remove(['auth', 'state']);
      openSheet(false); return toast('Signed out');
    }
    default:
  }
});

main.addEventListener('submit', async (e) => {
  if (e.target.id !== 'loginForm') return;
  e.preventDefault();
  const f = e.target, si = st.signin;
  if (si.busy) return;
  if (si.step === 'form') { si.email = f.email.value.trim(); si.password = f.password.value; if (!si.email || !si.password) { si.err = 'Enter your email and password.'; return renderMain(false); } }
  const code = si.step === 'code' ? f.code.value.replace(/\D/g, '') : '';
  if (si.step === 'code' && code.length !== 6) { si.err = 'The code has 6 digits.'; return renderMain(false); }
  si.busy = true; si.err = ''; renderMain(false);
  try {
    const r = await api('/api/ext/login', { body: { email: si.email, password: si.password, ...(code ? { code } : {}) } });
    st.signin = { step: 'form', email: '', password: '', err: '', busy: false, show: false };
    await L.set({ auth: { token: r.token, email: r.email, at: Date.now() } });
    st.local.auth = { token: r.token, email: r.email };
    renderMain();
    loadState();
  } catch (err) {
    si.busy = false;
    if (err instanceof ApiError && err.data?.needsCode) { si.err = si.step === 'code' ? err.message : ''; si.step = 'code'; }
    else si.err = err.message;
    renderMain(false);
  }
});
main.addEventListener('keydown', (e) => {
  const inp = e.target.closest('[data-rename]');
  if (inp && e.key === 'Enter') { e.preventDefault(); rename(inp.dataset.rename, inp.value); }
  if (inp && e.key === 'Escape') { st.editing = ''; renderMain(false); }
  if (e.target.id === 'addText' && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); addProxies(); }
});
main.addEventListener('focusout', (e) => { const inp = e.target.closest?.('[data-rename]'); if (inp && st.editing) rename(inp.dataset.rename, inp.value); });
main.addEventListener('input', (e) => { if (e.target.id === 'addText') { st.addDraft = e.target.value; if (st.addErr) { st.addErr = ''; const er = main.querySelector('.add .err'); er?.remove(); } } });
main.addEventListener('change', (e) => { if (e.target.id === 'addScheme') st.addScheme = e.target.value; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && st.sheet && $('#ddLayer').hidden) openSheet(false); });

async function pick(anchor, kind) {
  const c = aeonCfg(), prod = c.product, p = P[prod], cur = c[prod];
  try {
    if (kind === 'country') {
      const list = await countries(prod);
      const items = [{ v: '', label: 'Any country', cc: null }, ...list.map((x) => ({ v: x.code, label: x.name, cc: x.code.toUpperCase() }))];
      const v = await picker(anchor, { items, value: cur.country, placeholder: `Search ${list.length} countries` });
      if (v === undefined || v === cur.country) return;
      await saveCfg((cc) => { Object.assign(cc[prod], { country: v, region: '', city: '', target: '' }); });
    } else if (kind === 'region' || kind === 'target') {
      if (!cur.country) return;
      const t = await targets(prod, cur.country);
      const rows = kind === 'region' ? t.regions : t.isps;
      const any = kind === 'region' ? 'Any region' : `Any ${p.targetName === 'ISP' ? 'ISP' : 'carrier'}`;
      if (!rows.length) { toast(`No ${kind === 'region' ? 'regions' : `${p.targetName === 'ISP' ? 'ISPs' : 'carriers'}`} to pick in ${countryName(cur.country)}`); return; }
      const items = [{ v: '', label: any }, ...rows.map((r) => ({ v: r.name, label: title(r.name) }))];
      const v = await picker(anchor, { items, value: cur[kind], placeholder: `Search ${rows.length} ${kind === 'region' ? 'regions' : p.targetName === 'ISP' ? 'ISPs' : 'carriers'}` });
      if (v === undefined) return;
      /* the City list belongs to the region (below), so another region clears the city, as in the dashboard's generator */
      await saveCfg((cc) => { cc[prod][kind] = v; if (kind === 'region' && v !== cur.region) cc[prod].city = ''; });
    } else if (kind === 'time') {
      const v = await picker(anchor, { items: TIMES.map(([t, l]) => ({ v: String(t), label: `Keep for ${l}` })), value: String(cur.time), placeholder: 'Session time', plain: true });
      if (v === undefined) return;
      await saveCfg((cc) => { cc[prod].time = Number(v); });
    } else if (kind === 'city') {
      if (!cur.country) return;
      /* with a region picked, only that region's cities: a city of another region next to it finds no exit there, and
         the gateway goes out from the region instead (the API's region parameter, as the dashboard's City list) */
      const q = `product=${p.api}&country=${cur.country}${cur.region ? `&region=${encodeURIComponent(cur.region)}` : ''}`;
      const v = await picker(anchor, {
        value: cur.city, placeholder: cur.region ? `Type a city in ${title(cur.region)}` : 'Type a city',
        remote: async (s) => { const r = await authed(`/api/v1/locations/cities?${q}&limit=100${s ? `&search=${encodeURIComponent(s)}` : ''}`); return [{ v: '', label: 'Any city' }, ...r.results.map((x) => ({ v: x.name, label: title(x.name) }))]; },
      });
      if (v === undefined) return;
      await saveCfg((cc) => { cc[prod].city = v; });
    }
    renderMain(false);
  } catch (e) { toast(e.message || 'Could not load the list.'); }
}

/* ---------------- update notice ---------------- */
/* Store copies update themselves; a copy loaded from the zip ("development") or put in by a program ("sideload") does
   not, so it asks the site for the latest version (at most every 6 hours) and marks the settings button. */
const newer = (a, b) => { const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
async function updateCheck() {
  try { const self = await chrome.management.getSelf(); if (!['development', 'sideload'].includes(self.installType)) return; } catch { return; }
  let u = st.local.update;
  if (!u || !(Date.now() - u.at < 6 * 3600_000)) {
    try {
      const r = await fetch(UPDATES, { cache: 'no-store', credentials: 'omit' });
      if (!r.ok) return;
      u = { version: String((await r.json()).version || ''), at: Date.now() };
      await L.set({ update: u });
    } catch { return; }
  }
  st.update = newer(u.version, VERSION) ? u.version : '';
  $('#btnSettings').classList.toggle('dot', Boolean(st.update));
  $('#btnSettings').title = st.update ? `Settings · version ${st.update} is out` : 'Settings';
  if (st.sheet) renderSheet();
}

/* ---------------- start ---------------- */
async function realIp() {
  const cached = st.session.realIp;
  if (cached && Date.now() - cached.at < 10 * 60_000) { st.realIp = cached; return renderHeader(); }
  try {
    const r = await fetch(CHECK, { cache: 'no-store', credentials: 'omit' });
    const ip = (await r.json()).ip || {};
    st.realIp = { ip: ip.ip, cc: ip.geo?.country_code || '', city: ip.geo?.city || '', network: ip.as?.name || '', at: Date.now() };
    if (!st.local.enabled) { S.set({ realIp: st.realIp }); renderHeader(); }
  } catch { /* offline: the hint stays */ }
}

(async () => {
  await load();
  applyTheme();
  $('#btnSettings').innerHTML = ic('settings', 17);
  if (st.session.tab === 'mine' || st.session.tab === 'aeon') st.tab = st.session.tab;
  renderTabs(); renderHeader(); renderMain();
  if (!st.local.enabled) realIp();
  loadState();
  updateCheck();
})();
