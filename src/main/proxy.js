// Outbound proxy for every request the app makes (OpenAI / Anthropic / Gemini
// HTTPS calls and the Deepgram WebSocket), for regions where the provider
// endpoints are blocked. The proxy is applied to Chromium's session in the
// main process, so the renderer code needs no changes.
//
// Setting: `proxyUrl` — "http://host:port", "socks5://host:port", or with
// credentials "http://user:pass@host:port". Empty = the system proxy settings.
//
// Credentials are the catch: Chromium can answer a proxy's login challenge for
// ordinary requests (the app 'login' event) but not for a WebSocket handshake,
// and the Deepgram audio stream is a WebSocket — with a credentialed proxy it
// failed with "Deepgram socket error". So a proxy with credentials is used
// through a loopback relay (proxy-relay.js) that adds the credentials itself;
// Chromium talks to 127.0.0.1 without any login.

const { net, session } = require('electron');
const { ProxyRelay } = require('./proxy-relay');

const SCHEMES = new Set(['http', 'https', 'socks', 'socks4', 'socks5']);

/**
 * "host:port" | "scheme://[user:pass@]host:port" ->
 * { rules: 'scheme://host:port', auth: { user, pass } | null, host, port, scheme } or null when unusable.
 */
function parseProxy(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  let url;
  try {
    url = new URL(/^[a-z0-9+.-]+:\/\//i.test(raw) ? raw : `http://${raw}`);
  } catch {
    return null;
  }
  const scheme = url.protocol.replace(':', '').toLowerCase();
  if (!SCHEMES.has(scheme) || !url.hostname) return null;
  const port = url.port || (scheme === 'https' ? '443' : scheme.startsWith('socks') ? '1080' : '80');
  const auth = url.username ? { user: decodeURIComponent(url.username), pass: decodeURIComponent(url.password || '') } : null;
  return { rules: `${scheme}://${url.hostname}:${port}`, auth, host: url.hostname, port: Number(port), scheme };
}

let currentAuth = null;
let relay = null; // the loopback relay for the app's own session, when credentials are set

/**
 * Chromium proxy rules for a parsed proxy, starting a relay when it needs
 * credentials. Returns { rules, relay | null }.
 */
async function rulesFor(parsed) {
  if (!parsed.auth) return { rules: parsed.rules, relay: null };
  if (parsed.scheme === 'socks4') throw new Error('socks4 proxies have no password; use socks5://user:pass@host:port');
  const r = new ProxyRelay(parsed);
  const port = await r.start();
  return { rules: `http://127.0.0.1:${port}`, relay: r };
}

/** Point a session at the proxy (or back to the system settings when empty). */
async function applyProxy(ses, proxyUrl) {
  const parsed = parseProxy(proxyUrl);
  currentAuth = parsed?.auth || null;
  const old = relay;
  relay = null;
  if (parsed) {
    const r = await rulesFor(parsed);
    relay = r.relay;
    await ses.setProxy({ proxyRules: r.rules, proxyBypassRules: '<local>' });
  } else {
    await ses.setProxy({ mode: 'system' });
  }
  // Connections opened before the change would keep their old route.
  await ses.closeAllConnections().catch(() => {});
  if (old) await old.stop();
  return parsed;
}

/** app 'login' handler: answers a proxy challenge for non-relayed cases. */
function handleLogin(event, _webContents, _details, authInfo, callback) {
  if (!authInfo?.isProxy || !currentAuth) return;
  event.preventDefault();
  callback(currentAuth.user, currentAuth.pass);
}

// What the app actually talks to. Any HTTP status back (even 401 without a
// key) proves the route works; only a connection failure or timeout counts
// as unreachable.
const TARGETS = [
  { name: 'OpenAI', url: 'https://api.openai.com/v1/models' },
  { name: 'Anthropic', url: 'https://api.anthropic.com/v1/models' },
  { name: 'Gemini', url: 'https://generativelanguage.googleapis.com/v1beta/models' },
  { name: 'Deepgram', url: 'https://api.deepgram.com/v1/projects' }
];

function probe(ses, url, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = net.request({ url, method: 'GET', session: ses, useSessionCookies: false });
    const timer = setTimeout(() => { req.abort(); resolve({ ok: false, error: 'timed out', ms: Date.now() - started }); }, timeoutMs);
    req.on('login', (_info, cb) => { clearTimeout(timer); cb(); resolve({ ok: false, error: 'proxy asked for credentials', ms: Date.now() - started }); });
    req.on('response', (res) => {
      clearTimeout(timer);
      res.on('data', () => {}); res.on('end', () => {}); res.on('error', () => {});
      resolve({ ok: true, status: res.statusCode, ms: Date.now() - started });
    });
    req.on('error', (err) => { clearTimeout(timer); resolve({ ok: false, error: err.message, ms: Date.now() - started }); });
    req.end();
  });
}

/**
 * Tries the given proxy (unsaved is fine) against every provider endpoint,
 * in a throwaway session — through a relay when it has credentials, i.e. the
 * exact path the app itself uses — so the running app is not affected.
 * -> { proxy: rules | 'system', ok, results: [{ name, ok, status?, ms, error? }] } or { error }
 */
async function checkProxy(proxyUrl) {
  const raw = String(proxyUrl || '').trim();
  const parsed = parseProxy(raw);
  if (raw && !parsed) return { error: 'Not a valid proxy address. Use http://host:port, socks5://host:port, or http://user:pass@host:port.' };
  const ses = session.fromPartition(`proxy-check-${Date.now()}`);
  let tempRelay = null;
  try {
    if (parsed) {
      const r = await rulesFor(parsed);
      tempRelay = r.relay;
      await ses.setProxy({ proxyRules: r.rules, proxyBypassRules: '<local>' });
    } else {
      await ses.setProxy({ mode: 'system' });
    }
    const results = await Promise.all(TARGETS.map(async (t) => ({ name: t.name, ...(await probe(ses, t.url)) })));
    // A relay failure (bad password, proxy down) surfaces to Chromium as a
    // tunnel error; say what the relay actually saw.
    if (tempRelay?.lastError) for (const r of results) if (!r.ok) r.error = tempRelay.lastError;
    return { proxy: parsed ? parsed.rules : 'system', ok: results.every((r) => r.ok), results };
  } catch (err) {
    return { error: err.message };
  } finally {
    await ses.closeAllConnections().catch(() => {});
    if (tempRelay) await tempRelay.stop();
  }
}

/** For tests / diagnostics: the running relay, if any. */
function activeRelay() { return relay; }

module.exports = { parseProxy, applyProxy, handleLogin, checkProxy, activeRelay, TARGETS };
