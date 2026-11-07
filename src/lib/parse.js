/* Proxy lines as people paste them. Every format the AeonProxy dashboard exports, plus the common ones of other
   providers:
     host:port                      host:port:user:pass          user:pass@host:port
     host:port@user:pass            user:pass:host:port          scheme://user:pass@host:port
   scheme is http, https, socks5 (socks, socks5h) or socks4 (socks4a). IPv6 hosts go in brackets: [2001:db8::1]:8080.
   A password may contain ":" (host:port:user:pa:ss) and "@" (the last @ splits). */

const ALIAS = { http: 'http', https: 'https', socks: 'socks5', socks5: 'socks5', socks5h: 'socks5', socks4: 'socks4', socks4a: 'socks4' };
export const SCHEMES = ['http', 'https', 'socks5', 'socks4'];

const isPort = (s) => /^\d{1,5}$/.test(s) && +s >= 1 && +s <= 65535;
const LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?';
const NAME = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`);
export const isIPv4 = (s) => /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.test(s) && s.split('.').every((n) => +n <= 255);
export const isIPv6 = (s) => /^[0-9a-fA-F:.]+$/.test(s) && s.includes(':') && s.split(':').length <= 9;
const isHost = (s) => isIPv4(s) || (s.startsWith('[') && s.endsWith(']') && isIPv6(s.slice(1, -1))) || (s.length <= 253 && NAME.test(s) && !/^\d+$/.test(s));
/* how much a string looks like a proxy host rather than a login: an IP or a dotted name wins over a bare word */
const hostScore = (s) => (isIPv4(s) || s.startsWith('[') ? 3 : isHost(s) ? (s.includes('.') ? 2 : s === 'localhost' ? 2 : 1) : 0);

const dec = (s) => { try { return /%[0-9a-f]{2}/i.test(s) ? decodeURIComponent(s) : s; } catch { return s; } };
function cred(s) { const i = s.indexOf(':'); return i < 0 ? [dec(s), ''] : [dec(s.slice(0, i)), dec(s.slice(i + 1))]; }
function hostPort(s) {
  if (s.startsWith('[')) { const e = s.indexOf(']'); if (e < 0 || s[e + 1] !== ':') return null; const h = s.slice(0, e + 1), p = s.slice(e + 2); return isHost(h) && isPort(p) ? [h, p] : null; }
  const i = s.lastIndexOf(':'); if (i < 0) return null;
  const h = s.slice(0, i), p = s.slice(i + 1);
  return isHost(h) && isPort(p) && !h.includes(':') ? [h, p] : null;
}

export class ParseError extends Error {}

/** One line → { scheme, host, port, username, password }, or throws ParseError with a message for people. */
export function parseProxy(raw, fallbackScheme = 'http') {
  let s = String(raw || '').trim().replace(/\s+/g, '');
  if (!s) throw new ParseError('Paste a proxy first.');
  let scheme = null;
  const m = /^([a-z0-9]+):\/\//i.exec(s);
  if (m) {
    scheme = ALIAS[m[1].toLowerCase()];
    if (!scheme) throw new ParseError(`Unknown protocol "${m[1]}". Use http, https, socks5 or socks4.`);
    s = s.slice(m[0].length);
  }
  s = s.replace(/\/+$/, '');
  let host, port, username = '', password = '';
  const at = s.lastIndexOf('@');
  if (at > -1) {
    const left = s.slice(0, at), right = s.slice(at + 1);
    const hp = hostPort(right), hp2 = hp ? null : hostPort(left);
    if (hp) { [host, port] = hp; [username, password] = cred(left); }
    else if (hp2) { [host, port] = hp2; [username, password] = cred(right); }
    else throw new ParseError('Could not find host:port in this line.');
  } else if (s.startsWith('[')) {
    const e = s.indexOf(']');
    const rest = e > 0 && s[e + 1] === ':' ? s.slice(e + 2).split(':') : [];
    if (!rest.length || !isPort(rest[0]) || !isHost(s.slice(0, e + 1))) throw new ParseError('Could not read this IPv6 address. Write it as [address]:port.');
    host = s.slice(0, e + 1); port = rest[0]; username = dec(rest[1] || ''); password = dec(rest.slice(2).join(':'));
  } else {
    const p = s.split(':');
    if (p.length === 2) {
      if (!isHost(p[0]) || !isPort(p[1])) throw new ParseError('Write the proxy as host:port, host:port:login:password or login:password@host:port.');
      [host, port] = p;
    } else if (p.length === 3) {
      if (!isHost(p[0]) || !isPort(p[1])) throw new ParseError('Write the proxy as host:port:login:password.');
      [host, port] = p; username = dec(p[2]);
    } else {
      /* host:port:user:pass or user:pass:host:port — pick the reading whose host looks most like a host */
      const a = isPort(p[1]) ? hostScore(p[0]) : 0;
      const b = isPort(p[p.length - 1]) ? hostScore(p[p.length - 2]) : 0;
      if (!a && !b) throw new ParseError('Could not find host:port in this line.');
      if (a >= b) { host = p[0]; port = p[1]; username = dec(p[2]); password = dec(p.slice(3).join(':')); }
      else { host = p[p.length - 2]; port = p[p.length - 1]; username = dec(p[0]); password = dec(p.slice(1, -2).join(':')); }
    }
  }
  if (username.length > 255 || password.length > 255) throw new ParseError('The login or password is too long.');
  return { scheme: scheme || fallbackScheme, host: host.toLowerCase(), port: +port, username, password };
}

/** Several lines at once (a pasted list): the good ones and, for the rest, the line number with the reason. */
export function parseList(text, fallbackScheme = 'http') {
  const ok = [], bad = [];
  String(text || '').split(/\r?\n/).forEach((line, i) => {
    if (!line.trim() || line.trim().startsWith('#')) return;
    try { ok.push(parseProxy(line, fallbackScheme)); } catch (e) { bad.push({ line: i + 1, error: e.message }); }
  });
  return { ok, bad };
}

/** host:port:user:pass, the line the dashboard copies by default. */
export const lineOf = (p) => `${p.host}:${p.port}${p.username ? `:${p.username}:${p.password}` : ''}`;
