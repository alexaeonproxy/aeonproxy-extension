/* Content script for https://aeonproxy.com/dashboard/extension only (manifest → content_scripts). It tells the page the
   extension is here and passes the sign-in the page creates (the site's /api/ext/connect) to the service worker. Messages are
   accepted from this very window and origin only. */
(() => {
  const SITE = 'aeonproxy-site', EXT = 'aeonproxy-ext', version = chrome.runtime.getManifest().version;
  const post = (m) => window.postMessage({ source: EXT, ...m }, location.origin);
  window.addEventListener('message', async (e) => {
    if (e.source !== window || e.origin !== location.origin || !e.data || e.data.source !== SITE) return;
    if (e.data.type === 'ping') post({ type: 'ready', version });
    if (e.data.type === 'token' && typeof e.data.token === 'string') {
      try {
        const r = await chrome.runtime.sendMessage({ cmd: 'siteToken', token: e.data.token });
        post(r && r.ok ? { type: 'connected' } : { type: 'failed', error: (r && r.error) || '' });
      } catch {
        post({ type: 'failed', error: 'The extension did not answer. Reload this page and try again.' });
      }
    }
  });
  post({ type: 'ready', version });
})();
