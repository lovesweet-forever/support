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

const { app, BrowserWindow, ipcMain, globalShortcut, desktopCapturer, session, Tray, Menu, shell, systemPreferences, screen, dialog } = require('electron');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const settings = require('./settings');
const db = require('./db');

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

// Title-bar colours of the Setup window, reported by its page from the active
// theme (renderer/settings.js). Defaults match the Dark theme for the first open.
const TITLEBAR_HEIGHT = 36;
let chrome = { color: '#10131a', symbolColor: '#f2f4f8' };

function createSettingsWindow() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.show();
    settingsWin.focus();
    return;
  }
  // The panel floats at the screen-saver always-on-top level, so a plain
  // window would open underneath it. Make Setup a child of the panel (children
  // always stack above their parent) and pin it to the same level.
  const owner = panel && !panel.isDestroyed() && panel.isVisible() ? panel : undefined;
  // The page draws its own title bar in the theme colours; the OS only
  // contributes the window controls (Windows: overlay buttons recoloured via
  // setTitleBarOverlay; macOS: the traffic lights). Linux keeps its native
  // frame, which the desktop theme styles.
  settingsWin = new BrowserWindow({
    width: 900,
    height: 760,
    title: 'Interview Copilot — Setup',
    parent: owner,
    show: false,
    backgroundColor: chrome.color,
    autoHideMenuBar: true,
    ...(isLinux
      ? {}
      : {
          titleBarStyle: isMac ? 'hiddenInset' : 'hidden',
          titleBarOverlay: isMac ? true : { color: chrome.color, symbolColor: chrome.symbolColor, height: TITLEBAR_HEIGHT }
        }),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  settingsWin.once('ready-to-show', () => { if (settingsWin && !settingsWin.isDestroyed()) settingsWin.show(); });
  if (!isLinux) settingsWin.setContentProtection(true);
  settingsWin.setAlwaysOnTop(true, 'screen-saver');
  settingsWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
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
  if (!isMac) {
    // No File / Edit / View / Window / Help bar on the Setup window. Text
    // editing shortcuts (Ctrl+C / V / X / A / Z) are native on Windows and
    // Linux and keep working without a menu.
    Menu.setApplicationMenu(null);
    return;
  }
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

// ------------------------------------------------------- profiles + settings

// What the renderer sees as "settings": the settings file plus the active
// profile's fields (resume, job description, custom prompt, style, language,
// name) laid over it. Writes to those fields go to the profile instead.
function mergedSettings() {
  const s = settings.get();
  const p = s.activeProfileId ? db.getProfile(s.activeProfileId) : null;
  if (!p) return { ...s, activeProfileId: null, name: '', priorNotes: '' };
  return { ...s, activeProfileId: p.id, name: p.name, resume: p.resume, jobDescription: p.jobDescription,
    customPrompt: p.customPrompt, priorNotes: p.priorNotes || '', answerStyle: p.answerStyle, language: p.language };
}

function broadcastSettings() {
  const next = mergedSettings();
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('settings:changed', next);
  return next;
}

// First run with the database: turn whatever was in settings.json into the
// first profile. Also heals a dangling activeProfileId.
function ensureProfiles() {
  const s = settings.get();
  let profiles = db.listProfiles();
  if (!profiles.length) {
    const p = db.createProfile({ name: s.name || 'Default', resume: s.resume, jobDescription: s.jobDescription,
      customPrompt: s.customPrompt, answerStyle: s.answerStyle, language: s.language });
    profiles = [p];
  }
  if (!profiles.some((p) => p.id === s.activeProfileId)) settings.set({ activeProfileId: profiles[0].id });
}

const activeProfileId = () => settings.get().activeProfileId;
const stamp = () => new Date().toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

// ------------------------------------------------------------------- IPC

ipcMain.handle('settings:get', () => mergedSettings());
ipcMain.handle('settings:set', (_e, patch) => {
  const profilePatch = {};
  const rest = {};
  for (const [k, v] of Object.entries(patch || {})) (db.PROFILE_FIELDS.includes(k) ? profilePatch : rest)[k] = v;
  if (Object.keys(profilePatch).length && activeProfileId()) db.updateProfile(activeProfileId(), profilePatch);
  if (Object.keys(rest).length) settings.set(rest);
  // Push the change to whichever window did not originate it.
  return broadcastSettings();
});

ipcMain.handle('profiles:list', () => ({ profiles: db.listProfiles(), activeId: activeProfileId() }));
ipcMain.handle('profiles:create', (_e, fields) => {
  const p = db.createProfile({ customPrompt: settings.DEFAULTS.customPrompt, ...(fields || {}) });
  settings.set({ activeProfileId: p.id });
  broadcastSettings();
  return p;
});
ipcMain.handle('profiles:duplicate', (_e, id) => {
  const src = db.getProfile(id);
  if (!src) return null;
  const p = db.createProfile({ ...src, name: `${src.name} (copy)` });
  settings.set({ activeProfileId: p.id });
  broadcastSettings();
  return p;
});
ipcMain.handle('profiles:select', (_e, id) => {
  if (db.getProfile(id)) { settings.set({ activeProfileId: id }); broadcastSettings(); }
  return mergedSettings();
});
ipcMain.handle('profiles:delete', (_e, id) => {
  if (db.listProfiles().length <= 1) return { error: 'Keep at least one profile.' };
  db.deleteProfile(id);
  if (activeProfileId() === id) settings.set({ activeProfileId: db.listProfiles()[0].id });
  broadcastSettings();
  return { ok: true };
});

ipcMain.handle('sessions:list', () => db.listSessions(activeProfileId()));
ipcMain.handle('sessions:create', (_e, title) => {
  const p = db.getProfile(activeProfileId());
  return db.createSession(p.id, title || `${p.name} — ${stamp()}`);
});
ipcMain.handle('sessions:load', (_e, id) => db.loadSession(id));
ipcMain.handle('sessions:rename', (_e, id, title) => db.renameSession(id, title));
ipcMain.handle('sessions:delete', (_e, id) => db.deleteSession(id));
ipcMain.handle('sessions:end', (_e, id) => db.endSession(id));
ipcMain.handle('sessions:turn', (_e, id, turn) => db.addTurn(id, turn));
ipcMain.handle('sessions:turn-update', (_e, turnId, patch) => db.updateTurn(turnId, patch));
ipcMain.handle('sessions:transcript', (_e, id, entry) => db.addTranscript(id, entry));
ipcMain.handle('open-settings', () => createSettingsWindow());

// The Setup page reports its theme colours so the window controls overlay and
// the window background follow the theme.
const HEX = /^#[0-9a-f]{6}$/i;
ipcMain.handle('window:chrome', (e, c) => {
  if (!HEX.test(c?.color || '') || !HEX.test(c?.symbolColor || '')) return;
  chrome = { color: c.color, symbolColor: c.symbolColor };
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || win.isDestroyed() || win !== settingsWin) return;
  win.setBackgroundColor(chrome.color);
  if (!isMac && !isLinux) {
    try { win.setTitleBarOverlay({ color: chrome.color, symbolColor: chrome.symbolColor, height: TITLEBAR_HEIGHT }); } catch { /* frame without overlay */ }
  }
});
ipcMain.handle('panel:set-opacity', (_e, value) => {
  if (panel && !panel.isDestroyed()) panel.setOpacity(Math.max(0.2, Math.min(1, value)));
});
ipcMain.handle('panel:set-ignore-mouse', (_e, ignore) => {
  if (panel && !panel.isDestroyed()) panel.setIgnoreMouseEvents(Boolean(ignore), { forward: true });
});
ipcMain.handle('panel:hide', () => { if (panel && !panel.isDestroyed()) panel.hide(); });

// Session report -> PDF. The renderer builds the report page (renderer/report.js);
// here it is written to a temp file, rendered in a hidden window and printed
// to PDF at the path the user picks. Returns { path } | { canceled } | { error }.
ipcMain.handle('report:export-pdf', async (_e, { html, suggestedName }) => {
  const owner = panel && !panel.isDestroyed() ? panel : undefined;
  const { canceled, filePath } = await dialog.showSaveDialog(owner, {
    title: 'Save interview report as PDF',
    defaultPath: path.join(app.getPath('documents'), suggestedName || 'Interview.pdf'),
    filters: [{ name: 'PDF', extensions: ['pdf'] }]
  });
  if (canceled || !filePath) return { canceled: true };

  const tmp = path.join(app.getPath('temp'), `interview-copilot-report-${process.pid}-${Date.now()}.html`);
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
  });
  try {
    fs.writeFileSync(tmp, html, 'utf8');
    await win.loadFile(tmp);
    const pdf = await win.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      margins: { top: 0.6, bottom: 0.7, left: 0.6, right: 0.6 },
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate:
        '<div style="width:100%;text-align:center;font-size:8px;color:#888;font-family:sans-serif">' +
        'Interview Copilot &middot; page <span class="pageNumber"></span> / <span class="totalPages"></span></div>'
    });
    fs.writeFileSync(filePath, pdf);
    shell.showItemInFolder(filePath);
    return { path: filePath };
  } catch (err) {
    return { error: err.message };
  } finally {
    win.destroy();
    fs.rmSync(tmp, { force: true });
  }
});

// Screenshot of the display the panel sits on, to attach to a question. The
// panel and the setup window are content-protected, so on Windows / macOS
// they do not appear in the shot; Linux has no such protection, so the panel
// is hidden for the capture there.
const SHOT_MAX_EDGE = 2000;
ipcMain.handle('screen:capture', async () => {
  if (isMac && systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
    throw new Error('allow Screen Recording for Interview Copilot in System Settings → Privacy & Security, then try again');
  }
  const alive = panel && !panel.isDestroyed();
  const display = alive ? screen.getDisplayMatching(panel.getBounds()) : screen.getPrimaryDisplay();
  const scale = display.scaleFactor || 1;
  const hidePanel = isLinux && alive && panel.isVisible();
  if (hidePanel) { panel.hide(); await new Promise((r) => setTimeout(r, 250)); }
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: Math.round(display.size.width * scale), height: Math.round(display.size.height * scale) }
    });
    const source = sources.find((s) => String(s.display_id) === String(display.id)) || sources[0];
    if (!source || source.thumbnail.isEmpty()) throw new Error('no screen image was returned');
    let image = source.thumbnail;
    const { width, height } = image.getSize();
    if (Math.max(width, height) > SHOT_MAX_EDGE) {
      image = image.resize(width >= height ? { width: SHOT_MAX_EDGE } : { height: SHOT_MAX_EDGE });
    }
    const size = image.getSize();
    return { mime: 'image/png', data: image.toPNG().toString('base64'), width: size.width, height: size.height };
  } finally {
    if (hidePanel) panel.show();
  }
});
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

app.whenReady().then(async () => {
  await db.open();
  ensureProfiles();
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
  db.close(); // flushes any pending write
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
