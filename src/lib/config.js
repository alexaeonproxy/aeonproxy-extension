/* Where the extension talks to. build.mjs --dev rewrites these three lines for the local test stand (extension/test). */
export const SITE = 'https://aeonproxy.com';
/** The backend of aeonproxy.com/ip-checker: the exit IP with its country, city and network, asked through the proxy. */
export const CHECK = 'https://check.aeonproxy.com/ip';
/** The same host over plain HTTP: when the HTTPS check fails, the relay's own refusal (402 / 403 / 407 + X-Reason) is
    readable on a plain request, so the popup can say "no traffic left" instead of "not answering". */
export const CHECK_PLAIN = 'http://check.aeonproxy.com/ip';
/** The latest version the site hands out (written by build.mjs --public at every site release). Copies installed from the
    zip ("Load unpacked") do not update themselves, so the popup compares it with its own version and says so. */
export const UPDATES = `${SITE}/downloads/extension.json`;

/** Hosts that never go through the proxy: our own site and API, so signing in and loading lines work whatever the
    proxy does, and no proxy traffic is spent on them. check.aeonproxy.com is not here: it must see the proxy's exit. */
export const BYPASS_ALWAYS = ['aeonproxy.com', 'www.aeonproxy.com'];

/** WebRTC leak protection on by default: without it a site can read the real address past an HTTP proxy. */
export const DEFAULT_SETTINGS = { bypass: [], webrtc: true, theme: 'system' };

export const VERSION = chrome.runtime.getManifest().version;
