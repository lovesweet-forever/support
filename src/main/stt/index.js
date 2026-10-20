// Offline speech-to-text: model files on disk, their download, and the
// utility process that runs sherpa-onnx (./worker.js). The renderer talks to
// it through the `stt:*` IPC handlers registered below; each window's audio
// sessions are closed when the window goes away.
//
// Models live in <userData>/stt-models/<model id>/, the VAD next to them.
// Downloads go through Electron's `net`, so the proxy set in Setup applies.

const { app, ipcMain, net, utilityProcess } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { STT_MODELS, VAD_MODEL, DEFAULT_STT_MODEL, sttModel, modelSize } = require('./models');

const LOAD_TIMEOUT_MS = 120000;
const modelsRoot = () => path.join(app.getPath('userData'), 'stt-models');
const modelDir = (id) => path.join(modelsRoot(), id);
const vadPath = () => path.join(modelsRoot(), VAD_MODEL.name);

// ---- files on disk ----------------------------------------------------------

const fileSize = (p) => { try { return fs.statSync(p).size; } catch { return -1; } };
const complete = (p, size) => fileSize(p) === size;

function installed(model) {
  return complete(vadPath(), VAD_MODEL.size) &&
    Object.values(model.files).every((f) => complete(path.join(modelDir(model.id), f.name), f.size));
}

/** Whether the native addon exists for this platform (the x64 build of a mac universal pair may lack it). */
function addonAvailable() {
  try {
    const platform = process.platform === 'win32' ? 'win' : process.platform;
    require.resolve(`sherpa-onnx-${platform}-${process.arch}/sherpa-onnx.node`);
    return { ok: true };
  } catch {
    return { ok: false, reason: `offline transcription is not available in this build for ${process.platform}-${process.arch}` };
  }
}

// ---- download ---------------------------------------------------------------

let download = null; // { modelId, cancel(), progress }

function fetchToFile(url, dest, expectedSize, onBytes, signal) {
  return new Promise((resolve, reject) => {
    const request = net.request({ url, redirect: 'follow' });
    const part = `${dest}.part`;
    const out = fs.createWriteStream(part);
    let received = 0;
    const fail = (err) => { out.destroy(); fs.rmSync(part, { force: true }); reject(err); };
    const abort = () => { request.abort(); fail(new Error('cancelled')); };
    signal.addEventListener('abort', abort, { once: true });
    request.on('response', (res) => {
      if (res.statusCode !== 200) { fail(new Error(`HTTP ${res.statusCode}`)); return; }
      res.on('data', (chunk) => { received += chunk.length; out.write(chunk); onBytes(chunk.length); });
      res.on('end', () => {
        out.end(() => {
          signal.removeEventListener('abort', abort);
          if (expectedSize && received !== expectedSize) { fs.rmSync(part, { force: true }); reject(new Error(`incomplete file (${received} of ${expectedSize} bytes)`)); return; }
          fs.renameSync(part, dest);
          resolve();
        });
      });
      res.on('error', fail);
    });
    request.on('error', fail);
    request.end();
  });
}

async function fetchFirst(urls, dest, size, onBytes, signal) {
  let last = null;
  for (const url of urls) {
    if (signal.aborted) throw new Error('cancelled');
    try { return await fetchToFile(url, dest, size, onBytes, signal); } catch (err) {
      last = err;
      if (err.message === 'cancelled') throw err;
    }
  }
  throw new Error(`${path.basename(dest)}: ${last?.message || 'download failed'}`);
}

/** Download a model (and the VAD) with progress to `onProgress`; resolves when installed. */
async function downloadModel(modelId, onProgress) {
  const model = sttModel(modelId);
  if (!model) throw new Error(`unknown model ${modelId}`);
  if (download) throw new Error('a download is already running');
  fs.mkdirSync(modelDir(modelId), { recursive: true });

  const jobs = [];
  if (!complete(vadPath(), VAD_MODEL.size)) jobs.push({ urls: VAD_MODEL.urls, dest: vadPath(), size: VAD_MODEL.size });
  for (const f of Object.values(model.files)) {
    const dest = path.join(modelDir(modelId), f.name);
    if (!complete(dest, f.size)) jobs.push({ urls: model.sources.map((base) => base + f.name), dest, size: f.size });
  }
  const total = modelSize(model) + VAD_MODEL.size;
  let received = total - jobs.reduce((n, j) => n + j.size, 0); // already on disk
  const controller = new AbortController();
  download = { modelId, cancel: () => controller.abort(), progress: { received, total } };
  const report = () => { download.progress = { received, total }; onProgress({ modelId, received, total, file: current }); };
  let current = '';
  try {
    for (const job of jobs) {
      current = path.basename(job.dest);
      report();
      await fetchFirst(job.urls, job.dest, job.size, (n) => { received += n; report(); }, controller.signal);
    }
    current = '';
    report();
  } finally {
    download = null;
  }
}

function cancelDownload() { download?.cancel(); }

function deleteModel(modelId) {
  if (!sttModel(modelId)) return;
  if (download?.modelId === modelId) cancelDownload();
  fs.rmSync(modelDir(modelId), { recursive: true, force: true });
}

/** Everything Setup and the panel need to know, in one object. */
function status(settings) {
  const addon = addonAvailable();
  const models = STT_MODELS.map((m) => ({
    id: m.id, label: m.label, hint: m.hint, type: m.type, size: modelSize(m), recommended: Boolean(m.recommended),
    installed: installed(m),
    onDisk: Object.values(m.files).reduce((n, f) => n + Math.max(0, fileSize(path.join(modelDir(m.id), f.name))), 0)
  }));
  const selected = sttModel(settings.sttModel) ? settings.sttModel : DEFAULT_STT_MODEL;
  const ready = addon.ok && models.some((m) => m.id === selected && m.installed);
  return {
    engine: settings.sttEngine || 'offline',
    model: selected,
    models,
    ready,
    supported: addon.ok,
    reason: addon.ok ? '' : addon.reason,
    downloading: download ? { modelId: download.modelId, ...download.progress } : null,
    dir: modelsRoot(),
    running: Boolean(worker)
  };
}

// ---- worker -----------------------------------------------------------------

let worker = null;
let workerReady = null; // promise
let workerModel = null; // { modelId, language }
const sessions = new Map(); // id -> webContents

function threads() {
  const n = os.cpus().length || 4;
  return Math.max(2, Math.min(4, Math.floor(n / 2)));
}

function stopWorker() {
  if (worker) { try { worker.kill(); } catch { /* already gone */ } }
  worker = null;
  workerReady = null;
  workerModel = null;
  sessions.clear();
}

function ensureWorker(settings) {
  const modelId = sttModel(settings.sttModel) ? settings.sttModel : DEFAULT_STT_MODEL;
  const model = sttModel(modelId);
  const language = require('./models').whisperLanguage(settings.language);
  if (worker && workerModel?.modelId === modelId) {
    if (model.type === 'whisper' && workerModel.language !== language) {
      workerModel.language = language;
      worker.postMessage({ type: 'language', language });
    }
    return workerReady;
  }
  stopWorker();
  const addon = addonAvailable();
  if (!addon.ok) return Promise.reject(new Error(addon.reason));
  if (!installed(model)) return Promise.reject(new Error(`the transcription model is not downloaded — Setup → App → Transcription → Download`));

  const proc = utilityProcess.fork(path.join(__dirname, 'worker.js'), [], { serviceName: 'Interview Copilot transcription', stdio: 'pipe' });
  worker = proc;
  workerModel = { modelId, language };
  proc.stderr?.on('data', (d) => { if (process.env.STT_DEBUG) process.stderr.write(d); });
  proc.stdout?.on('data', (d) => { if (process.env.STT_DEBUG) process.stdout.write(d); });

  workerReady = new Promise((resolve, reject) => {
    // A model that never finishes loading (e.g. a damaged file) must not leave
    // Start hanging forever.
    const timer = setTimeout(() => {
      reject(new Error('the transcription model did not load within 2 minutes — delete and download it again in Setup → App → Transcription'));
      if (worker === proc) stopWorker();
    }, LOAD_TIMEOUT_MS);
    const onMessage = (msg) => {
      if (msg.type === 'ready') { clearTimeout(timer); resolve(); return; }
      if (msg.type === 'error' && !msg.id) { reject(new Error(msg.message)); return; }
      if (msg.type === 'result') {
        const wc = sessions.get(msg.id);
        if (wc && !wc.isDestroyed()) wc.send('stt:result', msg);
      }
    };
    proc.on('message', onMessage);
    proc.on('exit', (code) => {
      clearTimeout(timer);
      const err = new Error(`transcription process exited (${code})`);
      reject(err);
      if (worker === proc) {
        for (const wc of new Set(sessions.values())) if (!wc.isDestroyed()) wc.send('stt:result', { type: 'error', message: err.message });
        stopWorker();
      }
    });
    proc.postMessage({ type: 'init', modelDir: modelDir(modelId), model: { type: model.type, files: model.files }, vadPath: vadPath(), threads: threads(), language });
  });
  return workerReady;
}

// ---- IPC --------------------------------------------------------------------

/**
 * @param {() => object} getSettings  current settings (engine, model, language)
 */
function register(getSettings) {
  ipcMain.handle('stt:status', () => status(getSettings()));
  ipcMain.handle('stt:download', (e, modelId) =>
    downloadModel(modelId, (p) => { if (!e.sender.isDestroyed()) e.sender.send('stt:download-progress', p); })
      .then(() => ({ ok: true }), (err) => ({ ok: false, error: err.message })));
  ipcMain.handle('stt:cancel-download', () => cancelDownload());
  ipcMain.handle('stt:delete', (_e, modelId) => { deleteModel(modelId); return status(getSettings()); });
  ipcMain.handle('stt:open-folder', () => { fs.mkdirSync(modelsRoot(), { recursive: true }); return require('electron').shell.openPath(modelsRoot()); });

  // One session per audio channel of a window; ids are prefixed with the
  // window id so two windows cannot collide.
  const sid = (e, id) => `${e.sender.id}:${id}`;
  ipcMain.handle('stt:open', async (e, id) => {
    await ensureWorker(getSettings());
    sessions.set(sid(e, id), e.sender);
    worker.postMessage({ type: 'open', id: sid(e, id) });
    e.sender.once('destroyed', () => closeAll(e.sender));
  });
  ipcMain.on('stt:audio', (e, id, pcm) => { worker?.postMessage({ type: 'audio', id: sid(e, id), pcm }); });
  ipcMain.on('stt:cut', (e, id, until) => { worker?.postMessage({ type: 'cut', id: sid(e, id), until }); });
  ipcMain.on('stt:flush', (e, id) => { worker?.postMessage({ type: 'flush', id: sid(e, id) }); });
  ipcMain.handle('stt:language', (_e, language) => { if (worker) ensureWorker({ ...getSettings(), language }).catch(() => {}); });
  ipcMain.handle('stt:close', (e, id) => closeSession(sid(e, id)));
}

function closeSession(id) {
  if (!sessions.has(id)) return;
  sessions.delete(id);
  worker?.postMessage({ type: 'close', id });
  // The model stays loaded for a quick restart; it goes when the app quits.
}

function closeAll(webContents) {
  for (const [id, wc] of [...sessions]) if (wc === webContents) closeSession(id);
}

module.exports = { register, status, stopWorker };
