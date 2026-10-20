// Loopback relay for proxies that need a username / password.
//
// Chromium answers a proxy's credential challenge for ordinary requests (the
// app 'login' event), but a WebSocket handshake cannot — and the Deepgram
// audio stream is a WebSocket. So when the configured proxy has credentials,
// the app listens on 127.0.0.1:<random port> without authentication and, for
// every connection, opens the tunnel to the real proxy itself, supplying the
// credentials (HTTP Basic for http/https proxies, username/password for
// socks5). Chromium is pointed at the loopback port and never sees a
// challenge. Only CONNECT tunnels are relayed; every endpoint the app uses is
// HTTPS or WSS, so plain-HTTP proxying is not needed.

const http = require('http');
const net = require('net');
const tls = require('tls');

const CONNECT_TIMEOUT_MS = 15000;

function readHead(socket) {
  // Resolves with { head: string, rest: Buffer } once "\r\n\r\n" arrives.
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const i = buf.indexOf('\r\n\r\n');
      if (i === -1) { if (buf.length > 65536) fail(new Error('proxy response too long')); return; }
      cleanup();
      resolve({ head: buf.subarray(0, i).toString('latin1'), rest: buf.subarray(i + 4) });
    };
    const fail = (err) => { cleanup(); reject(err); };
    const cleanup = () => { socket.off('data', onData); socket.off('error', fail); socket.off('close', onClose); };
    const onClose = () => fail(new Error('proxy closed the connection'));
    socket.on('data', onData); socket.on('error', fail); socket.on('close', onClose);
  });
}

function readExactly(socket, n) {
  return new Promise((resolve, reject) => {
    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (buf.length < n) return;
      cleanup();
      resolve({ bytes: buf.subarray(0, n), rest: buf.subarray(n) });
    };
    const fail = (err) => { cleanup(); reject(err); };
    const cleanup = () => { socket.off('data', onData); socket.off('error', fail); socket.off('close', onClose); };
    const onClose = () => fail(new Error('proxy closed the connection'));
    socket.on('data', onData); socket.on('error', fail); socket.on('close', onClose);
  });
}

/** TCP (or TLS for https:// proxies) connection to the upstream proxy. */
function connectUpstream(upstream) {
  return new Promise((resolve, reject) => {
    const opts = { host: upstream.host, port: upstream.port };
    const sock = upstream.scheme === 'https'
      ? tls.connect({ ...opts, servername: upstream.host }, () => resolve(sock))
      : net.connect(opts, () => resolve(sock));
    sock.setNoDelay(true);
    sock.once('error', reject);
    sock.setTimeout(CONNECT_TIMEOUT_MS, () => { sock.destroy(); reject(new Error('timed out connecting to the proxy')); });
  });
}

/** HTTP proxy: CONNECT with Proxy-Authorization. Resolves once the tunnel is up. */
async function tunnelHttp(upstream, target) {
  const sock = await connectUpstream(upstream);
  const cred = Buffer.from(`${upstream.auth.user}:${upstream.auth.pass}`).toString('base64');
  sock.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: Basic ${cred}\r\nProxy-Connection: keep-alive\r\n\r\n`);
  const { head, rest } = await readHead(sock);
  const status = Number(/^HTTP\/1\.\d (\d{3})/.exec(head)?.[1] || 0);
  if (status < 200 || status >= 300) { sock.destroy(); throw new Error(`proxy refused the tunnel (HTTP ${status || '?'})`); }
  sock.setTimeout(0);
  return { sock, rest };
}

/** SOCKS5 with username/password (RFC 1929). Resolves once the tunnel is up. */
async function tunnelSocks5(upstream, target) {
  const [host, portStr] = target.split(':');
  const port = Number(portStr) || 443;
  const sock = await connectUpstream(upstream);
  // Greeting: we offer "no auth" and "username/password".
  sock.write(Buffer.from([0x05, 0x02, 0x00, 0x02]));
  let r = await readExactly(sock, 2);
  if (r.bytes[0] !== 0x05) { sock.destroy(); throw new Error('not a SOCKS5 proxy'); }
  if (r.bytes[1] === 0x02) {
    const u = Buffer.from(upstream.auth.user), p = Buffer.from(upstream.auth.pass);
    sock.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
    r = await readExactly(sock, 2);
    if (r.bytes[1] !== 0x00) { sock.destroy(); throw new Error('proxy rejected the username / password'); }
  } else if (r.bytes[1] !== 0x00) { sock.destroy(); throw new Error('proxy accepts no supported authentication'); }
  // CONNECT by domain name.
  const h = Buffer.from(host);
  sock.write(Buffer.concat([Buffer.from([0x05, 0x01, 0x00, 0x03, h.length]), h, Buffer.from([port >> 8, port & 0xff])]));
  r = await readExactly(sock, 4);
  if (r.bytes[1] !== 0x00) { sock.destroy(); throw new Error(`proxy could not connect to ${target} (SOCKS reply ${r.bytes[1]})`); }
  // Skip the bound address: IPv4 (4) / domain (1 + len) / IPv6 (16), then 2 port bytes.
  let rest = r.rest;
  const atyp = r.bytes[3];
  const need = (atyp === 0x01 ? 4 : atyp === 0x04 ? 16 : 1 + (rest.length ? rest[0] : (await readExactly(sock, 1)).bytes[0])) + 2;
  if (rest.length < need) rest = (await readExactly(sock, need - rest.length)).rest; else rest = rest.subarray(need);
  sock.setTimeout(0);
  return { sock, rest };
}

class ProxyRelay {
  /** @param {{scheme: string, host: string, port: number, auth: {user: string, pass: string}}} upstream */
  constructor(upstream) {
    this.upstream = upstream;
    this.server = null;
    this.port = 0;
    this.sockets = new Set();
    this.tunnels = 0;
    this.lastError = '';
  }

  start() {
    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        // Nothing the app does is plain HTTP through the proxy.
        res.writeHead(501, { 'content-type': 'text/plain' });
        res.end('Interview Copilot proxy relay: only CONNECT tunnels are relayed');
      });
      server.on('connect', (req, client, head) => this.handleConnect(req, client, head));
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => { this.server = server; this.port = server.address().port; resolve(this.port); });
    });
  }

  async handleConnect(req, client, head) {
    this.sockets.add(client);
    client.on('close', () => this.sockets.delete(client));
    client.on('error', () => {});
    try {
      const target = req.url;
      const { sock, rest } = this.upstream.scheme.startsWith('socks')
        ? await tunnelSocks5(this.upstream, target)
        : await tunnelHttp(this.upstream, target);
      this.tunnels++;
      this.sockets.add(sock);
      sock.on('close', () => { this.sockets.delete(sock); client.destroy(); });
      sock.on('error', () => client.destroy());
      client.on('close', () => sock.destroy());
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (rest.length) client.write(rest);
      if (head?.length) sock.write(head);
      sock.pipe(client);
      client.pipe(sock);
    } catch (err) {
      this.lastError = err.message;
      const status = /refused the tunnel|rejected|reply/.test(err.message) ? 502 : 504;
      client.end(`HTTP/1.1 ${status} ${err.message}\r\nContent-Length: 0\r\n\r\n`);
    }
  }

  stop() {
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    return new Promise((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}

module.exports = { ProxyRelay };
