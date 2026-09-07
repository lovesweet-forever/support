// Settings persistence: a JSON file in userData, plus an optional bundled
// config/keys.json (same idea as the extension) that pre-fills any API key
// the user has not set. A key entered in Setup is stored in settings.json and
// takes precedence over the file; clearing it falls back to the file again.

const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  // Which profile (main/db.js) is active; its fields (resume, jobDescription,
  // customPrompt, answerStyle, language, name) overlay these defaults.
  activeProfileId: null,
  resume: '',
  jobDescription: '',
  customPrompt:
    'Answer in my voice — first person, confident but genuine and down to earth, the way I would actually speak. Only use experience that appears in my resume.',
  answerStyle: 'detailed',
  language: 'en',
  provider: 'anthropic',
  model: 'claude-sonnet-5',
  anthropicKey: '',
  openaiKey: '',
  geminiKey: '',
  deepgramKey: '',
  transcribeCandidate: true,
  autoAnswer: false,
  answerFontSize: 15,
  panelOpacity: 0.96,
  // Colour theme id (see shared/constants.js THEMES)
  theme: 'dark',
  // UI font id (see shared/constants.js FONTS) and an optional installed font name
  font: 'system',
  fontCustom: '',
  // window geometry
  panelBounds: null,
  codeShare: 0.25,
  // Capture devices ('' = automatic). System audio: Windows loopback, or on
  // macOS the first virtual audio device found (BlackHole etc.).
  systemAudioDeviceId: '',
  systemAudioDeviceLabel: '',
  micDeviceId: ''
};

const KEY_FIELDS = ['anthropicKey', 'openaiKey', 'geminiKey', 'deepgramKey'];

let cache = null;
let fileKeys = {};

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

// Look for keys.json next to the executable/app root first, then userData.
function keysFilePath() {
  const candidates = [
    path.join(process.resourcesPath || '', 'config', 'keys.json'),
    path.join(app.getAppPath(), 'config', 'keys.json'),
    path.join(app.getPath('userData'), 'keys.json')
  ];
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

function loadKeyFile() {
  const p = keysFilePath();
  if (!p) return {};
  try {
    const json = JSON.parse(fs.readFileSync(p, 'utf8'));
    const keys = {};
    for (const f of KEY_FIELDS) if (typeof json[f] === 'string' && json[f].trim()) keys[f] = json[f].trim();
    return keys;
  } catch {
    return {};
  }
}

function load() {
  if (cache) return cache;
  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
  } catch {
    stored = {};
  }
  fileKeys = loadKeyFile();
  cache = { ...DEFAULTS, ...stored };
  return cache;
}

// The effective settings: file keys fill in where the user has none, and
// keysFromFile says which key fields are currently coming from the file.
function get() {
  const s = load();
  const out = { ...s };
  const keysFromFile = {};
  for (const f of KEY_FIELDS) {
    const own = String(s[f] || '').trim();
    keysFromFile[f] = !own && Boolean(fileKeys[f]);
    if (keysFromFile[f]) out[f] = fileKeys[f];
  }
  return { ...out, keysFromFile };
}

function set(patch) {
  const s = load();
  cache = { ...s, ...patch };
  const { keysFromFile, ...toWrite } = cache;
  try {
    fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
    fs.writeFileSync(settingsPath(), JSON.stringify(toWrite, null, 2));
  } catch {
    /* best effort */
  }
  return get();
}

module.exports = { get, set, DEFAULTS };
