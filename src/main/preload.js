// The only bridge between the sandboxed renderer and the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('copilot', {
  // 'win32' | 'darwin' | 'linux' — the renderer picks the system-audio path
  // and shortcut labels from this.
  platform: process.platform,
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  onSettingsChanged: (cb) => {
    const h = (_e, s) => cb(s);
    ipcRenderer.on('settings:changed', h);
    return () => ipcRenderer.removeListener('settings:changed', h);
  },
  /** Open Setup, optionally on a tab ('profile' | 'app' | 'guide'). */
  openSettings: (tab) => ipcRenderer.invoke('open-settings', tab),
  /** Setup window: the main process asks to switch tab (e.g. the panel's Guide button). */
  onShowTab: (cb) => {
    const h = (_e, tab) => cb(tab);
    ipcRenderer.on('settings:show-tab', h);
    return () => ipcRenderer.removeListener('settings:show-tab', h);
  },
  /** Setup window: colour its title bar / window controls from the active theme ({ color, symbolColor } hex). */
  setWindowChrome: (c) => ipcRenderer.invoke('window:chrome', c),
  setPanelOpacity: (v) => ipcRenderer.invoke('panel:set-opacity', v),
  setIgnoreMouse: (ignore) => ipcRenderer.invoke('panel:set-ignore-mouse', ignore),
  hidePanel: () => ipcRenderer.invoke('panel:hide'),
  quit: () => ipcRenderer.invoke('quit'),
  // Profiles (one per company / role) and interview sessions — see main/db.js.
  listProfiles: () => ipcRenderer.invoke('profiles:list'),
  createProfile: (fields) => ipcRenderer.invoke('profiles:create', fields),
  duplicateProfile: (id) => ipcRenderer.invoke('profiles:duplicate', id),
  selectProfile: (id) => ipcRenderer.invoke('profiles:select', id),
  deleteProfile: (id) => ipcRenderer.invoke('profiles:delete', id),
  listSessions: () => ipcRenderer.invoke('sessions:list'),
  createSession: (title) => ipcRenderer.invoke('sessions:create', title),
  loadSession: (id) => ipcRenderer.invoke('sessions:load', id),
  renameSession: (id, title) => ipcRenderer.invoke('sessions:rename', id, title),
  deleteSession: (id) => ipcRenderer.invoke('sessions:delete', id),
  endSession: (id) => ipcRenderer.invoke('sessions:end', id),
  addTurn: (sessionId, turn) => ipcRenderer.invoke('sessions:turn', sessionId, turn),
  /** A retried question: replace the saved answer of an existing turn. */
  updateTurn: (turnId, patch) => ipcRenderer.invoke('sessions:turn-update', turnId, patch),
  addTranscript: (sessionId, entry) => ipcRenderer.invoke('sessions:transcript', sessionId, entry),
  /** Test a proxy address against the provider endpoints; see main/proxy.js checkProxy. */
  checkProxy: (url) => ipcRenderer.invoke('proxy:check', url),
  /** Save the session report as a PDF; resolves to { path } | { canceled } | { error }. */
  exportPdf: (payload) => ipcRenderer.invoke('report:export-pdf', payload),
  /** Screenshot of the display the panel is on, as { mime, data (base64), width, height }. */
  captureScreen: () => ipcRenderer.invoke('screen:capture'),
  /** macOS: trigger the OS microphone prompt (no-op elsewhere). */
  ensureMicPermission: () => ipcRenderer.invoke('media:ensure-mic'),
  /**
   * Offline speech-to-text (main/stt). status() -> { engine, model, models,
   * ready, supported, reason, downloading, dir }; download(modelId) resolves
   * { ok } | { ok: false, error } when finished, with onDownloadProgress(cb)
   * ticks meanwhile. Sessions: open(id) loads the model (rejects with the
   * reason if it cannot), audio(id, pcm) feeds 16 kHz Int16 LE bytes, cut /
   * flush / close as DeepgramChannel; results arrive via onResult(cb) as
   * { id, text, isFinal, stale } or { type: 'error', message }.
   */
  stt: {
    status: () => ipcRenderer.invoke('stt:status'),
    download: (modelId) => ipcRenderer.invoke('stt:download', modelId),
    cancelDownload: () => ipcRenderer.invoke('stt:cancel-download'),
    deleteModel: (modelId) => ipcRenderer.invoke('stt:delete', modelId),
    openFolder: () => ipcRenderer.invoke('stt:open-folder'),
    onDownloadProgress: (cb) => {
      const h = (_e, p) => cb(p);
      ipcRenderer.on('stt:download-progress', h);
      return () => ipcRenderer.removeListener('stt:download-progress', h);
    },
    open: (id) => ipcRenderer.invoke('stt:open', id),
    audio: (id, pcm) => ipcRenderer.send('stt:audio', id, pcm),
    cut: (id, until) => ipcRenderer.send('stt:cut', id, until),
    flush: (id) => ipcRenderer.send('stt:flush', id),
    setLanguage: (language) => ipcRenderer.invoke('stt:language', language),
    close: (id) => ipcRenderer.invoke('stt:close', id),
    onResult: (cb) => {
      const h = (_e, r) => cb(r);
      ipcRenderer.on('stt:result', h);
      return () => ipcRenderer.removeListener('stt:result', h);
    }
  },
  /** App version (and the macOS version on a Mac), for the Guide. */
  appInfo: () => ipcRenderer.invoke('app:info'),
  /**
   * macOS: record the system audio output with the native helper (14.2+).
   * info() -> { supported, reason }; start() resolves to { output } once audio
   * flows; onPcm(cb) gets Uint8Array chunks of 16 kHz mono Int16 LE; onStatus(cb)
   * gets { event: 'waiting-permission' | 'output' | 'exit', … }. Both return an unsubscribe.
   */
  macTap: {
    info: () => ipcRenderer.invoke('mac-tap:info'),
    start: () => ipcRenderer.invoke('mac-tap:start'),
    stop: () => ipcRenderer.invoke('mac-tap:stop'),
    onPcm: (cb) => {
      const h = (_e, chunk) => cb(chunk);
      ipcRenderer.on('mac-tap:pcm', h);
      return () => ipcRenderer.removeListener('mac-tap:pcm', h);
    },
    onStatus: (cb) => {
      const h = (_e, status) => cb(status);
      ipcRenderer.on('mac-tap:status', h);
      return () => ipcRenderer.removeListener('mac-tap:status', h);
    }
  },
  /** Linux: create the temporary source mirroring the default output; resolves to its label. */
  ensureMonitorSource: () => ipcRenderer.invoke('linux:ensure-monitor-source'),
  /** Linux: remove that source again (no-op elsewhere). */
  releaseMonitorSource: () => ipcRenderer.invoke('linux:release-monitor-source'),
  onShortcut: (name, cb) => {
    const ch = `shortcut:${name}`;
    const h = () => cb();
    ipcRenderer.on(ch, h);
    return () => ipcRenderer.removeListener(ch, h);
  }
});
