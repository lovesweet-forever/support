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
  openSettings: () => ipcRenderer.invoke('open-settings'),
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
  addTranscript: (sessionId, entry) => ipcRenderer.invoke('sessions:transcript', sessionId, entry),
  /** Save the session report as a PDF; resolves to { path } | { canceled } | { error }. */
  exportPdf: (payload) => ipcRenderer.invoke('report:export-pdf', payload),
  /** Screenshot of the display the panel is on, as { mime, data (base64), width, height }. */
  captureScreen: () => ipcRenderer.invoke('screen:capture'),
  /** macOS: trigger the OS microphone prompt (no-op elsewhere). */
  ensureMicPermission: () => ipcRenderer.invoke('media:ensure-mic'),
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
