// Electron main process: the always-on-top panel window, the settings window,
// system-audio loopback wiring, global shortcuts, tray, and settings IPC.
//
// Platform notes
//  - Windows: the interviewer's audio comes from Electron's display-media
//    loopback (setDisplayMediaRequestHandler with audio: 'loopback').
//  - macOS: Electron has no system-audio loopback, so the renderer captures a
//    virtual audio device (BlackHole etc.) as an input instead (see
//    renderer/audio.js). The main process handles the microphone permission
//    prompt and installs an application menu — without one, Cmd+C / Cmd+V /
//    Cmd+Q do not work in the setup window.
//  - Linux: no loopback either. Chromium does not list PulseAudio "Monitor of…"
//    sources as inputs, so the main process creates a temporary remapped
//    source that mirrors the default output (pactl module-remap-source) and
//    the renderer captures that; it is unloaded when the session stops.
//
// Both windows enable content protection (BrowserWindow.setContentProtection),
// so they are excluded from screen captures / screen sharing (Windows:
// WDA_EXCLUDEFROMCAPTURE, macOS: NSWindowSharingNone) while staying visible
// on the local display.

const { app, BrowserWindow, ipcMain, globalShortcut, desktopCapturer, session, Tray, Menu, shell, systemPreferences } = require('electron');
const { execFile } = require('child_process');
const path = require('path');
const settings = require('./settings');

let panel = null;
let settingsWin = null;
let tray = null;

const isMac = process.platform === 'darwin';
const isLinux = process.platform === 'linux';

if (isLinux) {
  // Transparent frameless window on X11 needs an ARGB visual. Some NVIDIA
  // drivers also need the GPU off for the alpha channel to work; opt in with
  // COPILOT_DISABLE_GPU=1 if the panel shows a black background.
  app.commandLine.appendSwitch('enable-transparent-visuals');
  if (process.env.COPILOT_DISABLE_GPU) app.disableHardwareAcceleration();
}

// ---- Linux system audio: a temporary PulseAudio / PipeWire source ----------
// Chromium hides "Monitor of <output>" sources from getUserMedia, but a source
// remapped from that monitor is a normal input and shows up by its description.
const MONITOR_SOURCE = 'interview_copilot_monitor';
const MONITOR_LABEL = 'InterviewCopilotMonitor';
let monitorModule = null;

const pactl = (...args) =>
  new Promise((resolve, reject) => {
    execFile('pactl', args, { timeout: 5000 }, (err, out) => (err ? reject(err) : resolve(String(out).trim())));
  });

async function ensureMonitorSource() {
  if (!isLinux) return null;
  if (monitorModule) return MONITOR_LABEL;
  let sink;
  try {
    sink = await pactl('get-default-sink');
  } catch (err) {
    throw new Error(`pactl not available (${err.code || err.message}) — PulseAudio or PipeWire-pulse is required`);
  }
  if (!sink) throw new Error('no default output device found (pactl get-default-sink)');
  monitorModule = await pactl(
    'load-module',
    'module-remap-source',
    `master=${sink}.monitor`,
    `source_name=${MONITOR_SOURCE}`,
    `source_properties=device.description=${MONITOR_LABEL}`
  );
  return MONITOR_LABEL;
}

async function releaseMonitorSource() {
  if (!monitorModule) return;
  const idx = monitorModule;
  monitorModule = null;
  await pactl('unload-module', idx).catch(() => {});
}

// The same accelerators on every platform (Electron maps Alt to Option on
// macOS); only the labels differ.
const SHORTCUTS = {
  toggle: 'Alt+Shift+I',
  answer: 'Alt+Shift+A',
  session: 'Alt+Shift+S',
  fontInc: 'Alt+Shift+Up',
  fontDec: 'Alt+Shift+Down'
};
const keyLabel = (acc) => (isMac ? acc.replace('Alt+Shift+', '⌥⇧').replace('Up', '↑').replace('Down', '↓') : acc);

function togglePanel() {
  if (!panel || panel.isDestroyed()) return;
  if (panel.isVisible()) panel.hide();
  else panel.show();
}

function createPanel() {
  const saved = settings.get().panelBounds;
  panel = new BrowserWindow({
    width: saved?.width || 980,
    height: saved?.height || 640,
    x: saved?.x,
    y: saved?.y,
    minWidth: 340,
    minHeight: 220,
    frame: false,
    transparent: true,
    resizable: true,
    hasShadow: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    fullscreenable: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // Local tool calling the LLM / Deepgram APIs directly from the renderer:
      // disabling web security removes cross-origin blocking for those calls.
      webSecurity: false
    }
  });

  // Hide from screen capture / screen sharing (still visible locally).
  // Windows and macOS only — Linux window managers have no equivalent.
  if (!isLinux) panel.setContentProtection(true);

  // Float above full-screen meeting windows.
  panel.setAlwaysOnTop(true, 'screen-saver');
  panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // macOS: keep the floating panel out of Mission Control / Exposé thumbnails.
  if (isMac) panel.setHiddenInMissionControl(true);

  panel.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  if (process.env.SMOKE) {
    const errs = [];
    panel.webContents.on('console-message', (_e, lvl, m) => { if (lvl >= 3) errs.push(m); });
    panel.webContents.on('did-finish-load', () => setTimeout(() => {
      console.log(errs.length ? 'SMOKE_FAIL: ' + errs.join(' | ') : 'SMOKE_OK real main + renderer clean');
      app.quit();
    }, 2000));
  }

  const persistBounds = () => {
    if (panel && !panel.isDestroyed()) settings.set({ panelBounds: panel.getBounds() });
  };
  panel.on('resized', persistBounds);
  panel.on('moved', persistBounds);
  panel.on('closed', () => {
    panel = null;
  });
}

function createSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 900,
    height: 760,
    title: 'Interview Copilot — Setup',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  if (!isLinux) settingsWin.setContentProtection(true);
  // Help links (e.g. BlackHole on macOS) open in the system browser.
  settingsWin.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  settingsWin.loadFile(path.join(__dirname, '..', 'renderer', 'settings.html'));
  settingsWin.on('closed', () => {
    settingsWin = null;
  });
}

// System audio: on getDisplayMedia, hand back a screen source plus loopback
// audio (system output). The renderer keeps only the audio track. Loopback is
// Windows-only in Electron; on macOS the renderer never calls getDisplayMedia.
function wireLoopbackAudio() {
  session.defaultSession.setDisplayMediaRequestHandler(
    (request, callback) => {
      desktopCapturer
        .getSources({ types: ['screen'] })
        .then((sources) => {
          callback({ video: sources[0], audio: 'loopback' });
        })
        .catch(() => callback({}));
    },
    { useSystemPicker: false }
  );
}

function registerShortcuts() {
  const toPanel = (channel) => () => panel && !panel.isDestroyed() && panel.webContents.send(channel);
  globalShortcut.register(SHORTCUTS.toggle, togglePanel);
  globalShortcut.register(SHORTCUTS.answer, toPanel('shortcut:answer'));
  globalShortcut.register(SHORTCUTS.session, toPanel('shortcut:toggle-session'));
  globalShortcut.register(SHORTCUTS.fontInc, toPanel('shortcut:font-inc'));
  globalShortcut.register(SHORTCUTS.fontDec, toPanel('shortcut:font-dec'));
}

// macOS only: an application menu gives the setup window the standard Edit
// shortcuts (paste a resume / key) and Cmd+Q. Windows keeps Electron's default.
function installAppMenu() {
  if (!isMac) return;
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: app.name,
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { label: 'Setup (resume, keys, model)…', accelerator: 'Command+,', click: createSettingsWindow },
          { label: `Show / hide panel  (${keyLabel(SHORTCUTS.toggle)})`, click: togglePanel },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' }
        ]
      },
      { role: 'editMenu' },
      { role: 'windowMenu' }
    ])
  );
}

function createTray() {
  // A tiny glyph; the menu is the point. macOS gets a template image (black +
  // alpha, auto-inverted for the menu bar), other platforms a coloured one.
  try {
    tray = new Tray(path.join(__dirname, '..', 'assets', isMac ? 'trayTemplate.png' : 'tray.png'));
  } catch {
    return; // no icon asset — tray is optional
  }
  const menu = Menu.buildFromTemplate([
    { label: `Show / hide panel  (${keyLabel(SHORTCUTS.toggle)})`, click: togglePanel },
    { label: 'Setup (resume, keys, model)…', click: createSettingsWindow },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]);
  tray.setToolTip('Interview Copilot');
  tray.setContextMenu(menu);
}

// ------------------------------------------------------------------- IPC

ipcMain.handle('settings:get', () => settings.get());
ipcMain.handle('settings:set', (_e, patch) => {
  const next = settings.set(patch);
  // Push the change to whichever window did not originate it.
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('settings:changed', next);
  return next;
});
ipcMain.handle('open-settings', () => createSettingsWindow());
ipcMain.handle('panel:set-opacity', (_e, value) => {
  if (panel && !panel.isDestroyed()) panel.setOpacity(Math.max(0.2, Math.min(1, value)));
});
ipcMain.handle('panel:set-ignore-mouse', (_e, ignore) => {
  if (panel && !panel.isDestroyed()) panel.setIgnoreMouseEvents(Boolean(ignore), { forward: true });
});
ipcMain.handle('panel:hide', () => { if (panel && !panel.isDestroyed()) panel.hide(); });
ipcMain.handle('quit', () => app.quit());

// macOS asks for microphone access once per app; both the real mic and a
// virtual audio device count as "microphone" inputs. Resolves true when
// capture is allowed. Other platforms need no prompt.
ipcMain.handle('media:ensure-mic', async () => {
  if (!isMac) return true;
  if (systemPreferences.getMediaAccessStatus('microphone') === 'granted') return true;
  return systemPreferences.askForMediaAccess('microphone');
});

// Linux: create / remove the temporary source that mirrors the default output.
// Resolves to the device label the renderer should look for.
ipcMain.handle('linux:ensure-monitor-source', () => ensureMonitorSource());
ipcMain.handle('linux:release-monitor-source', () => releaseMonitorSource());

// --------------------------------------------------------------- lifecycle

app.whenReady().then(() => {
  installAppMenu();
  wireLoopbackAudio();
  createPanel();
  registerShortcuts();
  createTray();

  app.on('activate', () => {
    if (!panel) createPanel();
    else panel.show();
  });
});

app.on('will-quit', (e) => {
  globalShortcut.unregisterAll();
  if (monitorModule) {
    // Don't leave the remapped source behind in PulseAudio.
    e.preventDefault();
    releaseMonitorSource().finally(() => app.exit(0));
  }
});
app.on('window-all-closed', () => {
  // The tray keeps the app alive; only quit explicitly.
  if (!tray) app.quit();
});
