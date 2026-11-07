import { SITE, VERSION } from './config.js';

/* Calls to aeonproxy.com. The extension signs in with a token of its own (`ape_…`, issued by the site),
   sent as a Bearer header; the site's cookies are never used (credentials: 'omit'). Errors come in two shapes:
   the public API's { error: { code, message } } and the site routes' { error: "…", needsCode? }. */
export class ApiError extends Error {
  constructor(status, message, data) { super(message); this.status = status; this.data = data || {}; }
}

export async function api(path, { method, body, token, timeout = 20000 } = {}) {
  const headers = { Accept: 'application/json', 'X-AP-Client': `extension/${VERSION}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeout);
  let r;
  try {
    r = await fetch(SITE + path, { method: method || (body === undefined ? 'GET' : 'POST'), headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'omit', cache: 'no-store', signal: ctl.signal });
  } catch {
    throw new ApiError(0, `Could not reach ${new URL(SITE).host}. Check your internet connection.`);
  } finally { clearTimeout(t); }
  let data = null;
  try { data = await r.json(); } catch { /* empty or not JSON */ }
  if (!r.ok) {
    const e = data && data.error;
    const msg = typeof e === 'string' ? e : e && e.message ? e.message : r.status === 429 ? 'Too many requests. Wait a minute.' : `Something went wrong (${r.status}). Try again.`;
    throw new ApiError(r.status, msg, data);
  }
  return data;
}

/** Signed-in calls: the token comes from storage; a 401 means the sign-in ended (revoked in Settings → Security, a
    password change, 14 days without use), so the stored one is dropped and the popup shows the sign-in form. */
export async function authed(path, opts = {}) {
  const { auth } = await chrome.storage.local.get('auth');
  if (!auth || !auth.token) throw new ApiError(401, 'Sign in first.');
  try {
    return await api(path, { ...opts, token: auth.token });
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) await chrome.storage.local.remove(['auth', 'state']);
    throw e;
  }
}

export const siteUrl = (path) => SITE + path;
