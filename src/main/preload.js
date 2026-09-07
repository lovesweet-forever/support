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
