// macOS system audio: runs native/bin/copilot-audio-tap (a Core Audio process
// tap, see native/mac-audio-tap/AudioTap.swift), which records everything the
// Mac plays — whatever the output device — as 16 kHz mono 16-bit PCM on
// stdout. The chunks are forwarded to the panel renderer, which transcribes
// them exactly like a captured MediaStream (see renderer/audio.js).
//
// Needs macOS 14.2+. On older systems, or when the helper is missing from a dev
// checkout, the app falls back to a virtual audio device (BlackHole).

const { app } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const MIN_MACOS = [14, 2];
// macOS shows the "System Audio Recording" prompt on the first capture and the
// helper waits until it is answered; tell the user after this long.
const PERMISSION_HINT_MS = 2500;

let child = null;

function helperPath() {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'bin', 'copilot-audio-tap')
    : path.join(__dirname, '..', '..', 'native', 'bin', 'copilot-audio-tap');
}

function macosAtLeast([major, minor]) {
  const [m = 0, n = 0] = process.getSystemVersion().split('.').map(Number);
  return m > major || (m === major && n >= minor);
}

/** { supported, reason } — whether Automatic can record the system output directly. */
function info() {
  if (process.platform !== 'darwin') return { supported: false, reason: 'not macOS' };
  if (!macosAtLeast(MIN_MACOS)) return { supported: false, reason: `macOS ${process.getSystemVersion()} is older than 14.2` };
  if (!fs.existsSync(helperPath())) return { supported: false, reason: 'the audio helper is not built (npm run build:mac-tap)' };
  return { supported: true, reason: '' };
}

/**
 * Starts the helper and streams to `webContents`:
 *   'mac-tap:pcm'     Uint8Array of Int16 LE samples (whole samples only)
 *   'mac-tap:status'  { event: 'waiting-permission' | 'output' | 'exit', … }
 * Resolves to { output } once audio flows; rejects if the helper fails first.
 */
function start(webContents) {
  stop();
  const proc = spawn(helperPath(), [], { stdio: ['pipe', 'pipe', 'pipe'] });
  child = proc;
  const send = (channel, payload) => { if (!webContents.isDestroyed()) webContents.send(channel, payload); };

  let odd = null;
  proc.stdout.on('data', (data) => {
    if (odd) { data = Buffer.concat([odd, data]); odd = null; }
    if (data.length % 2) { odd = data.subarray(data.length - 1); data = data.subarray(0, data.length - 1); }
    if (data.length) send('mac-tap:pcm', data);
  });

  return new Promise((resolve, reject) => {
    let ready = false;
    let lastError = '';
    const permissionTimer = setTimeout(() => send('mac-tap:status', { event: 'waiting-permission' }), PERMISSION_HINT_MS);

    let buffered = '';
    proc.stderr.on('data', (data) => {
      buffered += data;
      let nl;
      while ((nl = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, nl).trim();
        buffered = buffered.slice(nl + 1);
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.event === 'ready') {
          ready = true;
          clearTimeout(permissionTimer);
          resolve({ output: msg.output || '' });
        } else if (msg.event === 'error') {
          lastError = msg.status ? `${msg.message} (${msg.status})` : msg.message;
        } else if (msg.event === 'output') {
          send('mac-tap:status', msg);
        }
      }
    });

    proc.on('error', (err) => {
      clearTimeout(permissionTimer);
      reject(new Error(`could not run the audio helper: ${err.message}`));
    });
    proc.on('exit', (code, signal) => {
      clearTimeout(permissionTimer);
      const unexpected = child === proc;
      if (unexpected) child = null;
      if (!ready) reject(new Error(lastError || (unexpected ? `audio helper exited (${code ?? signal})` : 'stopped')));
      else if (unexpected) send('mac-tap:status', { event: 'exit', message: lastError || `audio helper exited (${code ?? signal})` });
    });
  });
}

function stop() {
  const proc = child;
  if (!proc) return;
  child = null;
  proc.stdin.end();
  proc.kill('SIGTERM');
  // The helper cleans up its tap on SIGTERM; make sure it is gone regardless.
  setTimeout(() => { if (proc.exitCode === null && proc.signalCode === null) proc.kill('SIGKILL'); }, 1500).unref();
}

module.exports = { info, start, stop };
