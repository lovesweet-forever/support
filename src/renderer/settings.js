import { PROVIDERS, LANGUAGES, ANSWER_STYLES, THEMES, FONTS, applyTheme, applyFont } from '../shared/constants.js';

const api = window.copilot;
const $ = (id) => document.getElementById(id);
const KEY_FIELD = { anthropic: 'anthropicKey', openai: 'openaiKey', gemini: 'geminiKey' };

let settings = await api.getSettings();
applyTheme(settings.theme);
applyFont(settings);
document.documentElement.classList.add(api.platform === 'darwin' ? 'mac' : api.platform === 'linux' ? 'linux' : 'win');

// The window's title bar and controls are drawn by the OS; tell the main
// process the theme colours so they match this page.
function reportChrome() {
  const cs = getComputedStyle(document.documentElement);
  const color = cs.getPropertyValue('--bg-page').trim();
  const symbolColor = cs.getPropertyValue('--fg').trim();
  api.setWindowChrome({ color, symbolColor }).catch(() => {});
}
reportChrome();

// ---- tabs: Profile (this interview) / App (the program itself) / Guide -------
function showTab(id) {
  if (!document.querySelector(`.tab[data-tab="${id}"]`)) return;
  for (const b of document.querySelectorAll('.tab')) b.classList.toggle('active', b.dataset.tab === id);
  for (const p of document.querySelectorAll('.tab-page')) p.hidden = p.dataset.tab !== id;
  try { localStorage.setItem('setupTab', id); } catch { /* storage unavailable */ }
  window.scrollTo(0, 0);
}
$('tabs').addEventListener('click', (e) => {
  const b = e.target.closest('.tab');
  if (b) showTab(b.dataset.tab);
});
let lastTab = 'profile';
try { lastTab = localStorage.getItem('setupTab') || 'profile'; } catch { /* storage unavailable */ }
// Opened from the panel's Guide button (or the menu): that tab wins.
const requestedTab = new URLSearchParams(location.search).get('tab');
showTab(requestedTab || lastTab);
if (!document.querySelector('.tab.active')) showTab('profile');
api.onShowTab((tab) => showTab(tab));

// ---- font picker ------------------------------------------------------------
// Each card is rendered in its own font so the choice is visible before clicking.
$('fonts').innerHTML = FONTS.map(
  (f) => `<button type="button" class="font-card" data-font-id="${f.id}" style="font-family:${f.stack.replace(/"/g, '&quot;')}">
    <span class="sample">Aa</span><span class="meta"><span class="name">${f.label}</span><span class="hint">${f.hint}</span></span></button>`
).join('');
function renderFontCards() {
  for (const card of document.querySelectorAll('.font-card')) {
    card.classList.toggle('active', card.dataset.fontId === (settings.font || 'system'));
  }
}
$('fonts').addEventListener('click', (e) => {
  const card = e.target.closest('.font-card');
  if (!card) return;
  settings.font = card.dataset.fontId;
  applyFont(settings);
  renderFontCards();
  save({ font: settings.font });
});
$('fontCustom').value = settings.fontCustom || '';
$('fontCustom').addEventListener('input', () => {
  settings.fontCustom = $('fontCustom').value;
  applyFont(settings);
  save({ fontCustom: settings.fontCustom.trim() });
});
renderFontCards();

// ---- theme picker -----------------------------------------------------------
$('themes').innerHTML = THEMES.map(
  (t) => `<button type="button" class="theme-card" data-theme-id="${t.id}">
    <span class="swatch" style="background:${t.swatch};--sw-accent:${t.accent}"></span>${t.label}</button>`
).join('');
function renderThemeCards() {
  for (const card of document.querySelectorAll('.theme-card')) {
    card.classList.toggle('active', card.dataset.themeId === (settings.theme || 'dark'));
  }
}
$('themes').addEventListener('click', (e) => {
  const card = e.target.closest('.theme-card');
  if (!card) return;
  settings.theme = card.dataset.themeId;
  applyTheme(settings.theme);
  renderThemeCards();
  reportChrome();
  save({ theme: settings.theme });
});
renderThemeCards();

// ---- profiles ---------------------------------------------------------------
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
async function renderProfiles() {
  const { profiles, activeId } = await api.listProfiles();
  $('profile').innerHTML = profiles.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  $('profile').value = String(activeId ?? '');
}
// The active profile's fields, into the form.
function fillProfileFields(s) {
  $('name').value = s.name || '';
  $('resume').value = s.resume || '';
  $('jobDescription').value = s.jobDescription || '';
  $('customPrompt').value = s.customPrompt || '';
  $('priorNotes').value = s.priorNotes || '';
  $('answerStyle').value = s.answerStyle;
  $('language').value = s.language;
}
$('profile').addEventListener('change', () => api.selectProfile(Number($('profile').value)));
$('profileNew').addEventListener('click', () => api.createProfile({ name: 'New profile' }));
$('profileCopy').addEventListener('click', () => api.duplicateProfile(Number($('profile').value)));
$('profileDelete').addEventListener('click', async () => {
  const sel = $('profile');
  const label = sel.options[sel.selectedIndex]?.text || 'this profile';
  if (!window.confirm(`Delete "${label}" and every interview session saved under it?`)) return;
  const res = await api.deleteProfile(Number(sel.value));
  if (res?.error) window.alert(res.error);
});
renderProfiles();

// The panel can change the theme or switch profile too; follow it.
api.onSettingsChanged((s) => {
  const switched = s.activeProfileId !== settings.activeProfileId;
  settings = s;
  applyTheme(s.theme); renderThemeCards(); reportChrome();
  applyFont(s); renderFontCards();
  if (switched) fillProfileFields(s);
  renderProfiles();
  renderKeyLocks(); // e.g. a cleared key falling back to config/keys.json (skips the field being edited)
  renderStt();
});

$('language').innerHTML = LANGUAGES.map((l) => `<option value="${l.code}">${l.label}</option>`).join('');
$('answerStyle').innerHTML = Object.entries(ANSWER_STYLES).map(([id, s]) => `<option value="${id}">${s.label}</option>`).join('');
$('provider').innerHTML = Object.entries(PROVIDERS).map(([id, p]) => `<option value="${id}">${p.label}</option>`).join('');

function renderProviderFields() {
  const provider = PROVIDERS[$('provider').value];
  $('model').innerHTML = provider.models.map((m) => `<option value="${m.id}">${m.label}</option>`).join('');
  const known = provider.models.some((m) => m.id === settings.model);
  $('model').value = known ? settings.model : provider.defaultModel;
  $('modelCustom').value = known ? '' : settings.model || '';
}

// ---- API keys: masked (first 5 … last 5), never revealed --------------------
// A field shows the mask. Focusing it empties it so a new key can be pasted;
// Enter / blur saves a non-empty value, Esc or leaving it empty keeps the old
// key. Remove deletes the user's own key (a file key then shows again).
const KEY_FIELDS = ['anthropicKey', 'openaiKey', 'geminiKey', 'deepgramKey'];
const keyValues = {}; // the real values (never shown in full)
const keyPlaceholder = {};
const maskKey = (v) => (v.length > 10 ? `${v.slice(0, 5)}${'•'.repeat(8)}${v.slice(-5)}` : v);

function renderKeyLocks() {
  for (const field of KEY_FIELDS) {
    const input = $(field);
    keyValues[field] = settings[field] || '';
    const fromFile = Boolean(settings.keysFromFile?.[field]);
    if (document.activeElement !== input) input.value = maskKey(keyValues[field]);
    input.classList.toggle('from-file', fromFile);
    document.querySelector(`[data-remove="${field}"]`).hidden = !keyValues[field] || fromFile;
    const note = document.querySelector(`[data-note="${field}"]`);
    if (note) note.textContent = fromFile ? 'From config/keys.json — paste a key here to override it' : '';
  }
}
for (const field of KEY_FIELDS) {
  const input = $(field);
  keyPlaceholder[field] = input.placeholder;
  let cancelled = false;
  input.addEventListener('focus', () => {
    cancelled = false;
    input.value = '';
    input.placeholder = keyValues[field] ? `Paste a new key — leave empty to keep ${maskKey(keyValues[field])}` : keyPlaceholder[field];
  });
  input.addEventListener('blur', () => {
    const v = input.value.trim();
    if (v && !cancelled) { keyValues[field] = v; save({ [field]: v }); }
    input.value = maskKey(keyValues[field]);
    input.placeholder = keyPlaceholder[field];
    document.querySelector(`[data-remove="${field}"]`).hidden = !keyValues[field] || (Boolean(settings.keysFromFile?.[field]) && !v);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { cancelled = true; input.value = ''; input.blur(); }
  });
  document.querySelector(`[data-remove="${field}"]`).addEventListener('click', () => {
    keyValues[field] = '';
    input.value = '';
    document.querySelector(`[data-remove="${field}"]`).hidden = true;
    save({ [field]: '' }); // the settings:changed broadcast re-renders (file fallback, if any)
  });
}

let saveTimer = null;
function flash() {
  const el = $('saved'); el.classList.add('show');
  clearTimeout(flash._t); flash._t = setTimeout(() => el.classList.remove('show'), 1000);
}
function save(patch) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => { settings = await api.setSettings(patch); flash(); }, 250);
}
const bindText = (id, key) => $(id).addEventListener('input', () => save({ [key]: $(id).value }));
const bindCheck = (id, key) => $(id).addEventListener('change', () => save({ [key]: $(id).checked }));

bindText('name', 'name');
bindText('resume', 'resume');
bindText('jobDescription', 'jobDescription');
bindText('customPrompt', 'customPrompt');
bindText('priorNotes', 'priorNotes');

// ---- earlier rounds: import a PDF (e.g. a saved report) or a text file ------
const PRIOR_MAX = 60000;
$('priorImport').addEventListener('click', () => $('priorFile').click());
$('priorClear').addEventListener('click', () => { $('priorNotes').value = ''; save({ priorNotes: '' }); });
$('priorFile').addEventListener('change', async () => {
  const file = $('priorFile').files[0];
  $('priorFile').value = '';
  if (!file) return;
  const hint = $('priorHint');
  hint.textContent = `Reading ${file.name}…`;
  try {
    const { extractText } = await import('./extract.js');
    let text = (await extractText(file)).trim();
    if (!text) throw new Error('no text found in the file (a scanned PDF has none)');
    const stamp = new Date().toLocaleDateString();
    const current = $('priorNotes').value.trim();
    let next = `${current ? `${current}\n\n` : ''}--- Imported from ${file.name} (${stamp}) ---\n${text}`;
    let note = `Added ${text.length.toLocaleString()} characters from ${file.name}.`;
    if (next.length > PRIOR_MAX) { next = `${next.slice(0, PRIOR_MAX)}\n…[trimmed]`; note += ` Trimmed to ${PRIOR_MAX.toLocaleString()} characters.`; }
    $('priorNotes').value = next;
    $('priorNotes').scrollTop = $('priorNotes').scrollHeight;
    save({ priorNotes: next });
    hint.textContent = note;
  } catch (err) {
    hint.textContent = `Could not import ${file.name}: ${err.message}`;
  }
});
$('answerStyle').addEventListener('change', () => save({ answerStyle: $('answerStyle').value }));
$('language').addEventListener('change', () => save({ language: $('language').value }));
$('provider').addEventListener('change', () => { const provider = $('provider').value; save({ provider, model: PROVIDERS[provider].defaultModel }); renderProviderFields(); });
$('model').addEventListener('change', () => { $('modelCustom').value = ''; save({ model: $('model').value }); });
$('modelCustom').addEventListener('input', () => save({ model: $('modelCustom').value.trim() || $('model').value }));
bindCheck('transcribeCandidate', 'transcribeCandidate');
bindCheck('autoAnswer', 'autoAnswer');

// ---- proxy ------------------------------------------------------------------
$('proxyUrl').value = settings.proxyUrl || '';
$('proxyUrl').addEventListener('input', () => save({ proxyUrl: $('proxyUrl').value.trim() }));
$('proxyCheck').addEventListener('click', async () => {
  const btn = $('proxyCheck');
  const out = $('proxyResult');
  btn.disabled = true;
  out.className = 'proxy-result';
  out.textContent = 'Checking… (up to 10 s per endpoint)';
  try {
    const res = await api.checkProxy($('proxyUrl').value);
    out.textContent = '';
    if (res.error) { out.className = 'proxy-result bad'; out.textContent = res.error; return; }
    const head = document.createElement('div');
    head.className = 'proxy-head';
    head.textContent = res.ok
      ? `Proxy works (${res.proxy === 'system' ? 'system settings' : res.proxy}): all four services reachable.`
      : `Some services are not reachable through ${res.proxy === 'system' ? 'the system settings' : res.proxy}.`;
    out.append(head);
    for (const r of res.results) {
      const line = document.createElement('div');
      line.className = `proxy-line ${r.ok ? 'ok' : 'bad'}`;
      line.textContent = r.ok ? `✓ ${r.name} — ${r.ms} ms (HTTP ${r.status})` : `✗ ${r.name} — ${r.error} (${r.ms} ms)`;
      out.append(line);
    }
    out.className = `proxy-result ${res.ok ? 'good' : 'bad'}`;
  } catch (err) {
    out.className = 'proxy-result bad';
    out.textContent = `Check failed: ${String(err.message || err).replace(/^.*?:\s*Error:\s*/, '')}`;
  } finally {
    btn.disabled = false;
  }
});

// ---- capture devices --------------------------------------------------------
// Windows captures system audio through Electron's loopback, so the picker is
// only needed for unusual setups; macOS has no loopback and needs a virtual
// audio device (BlackHole etc.) that the meeting output is routed to.
const isMac = api.platform === 'darwin';
const isLinux = api.platform === 'linux';
$('systemAudioHint').innerHTML = isLinux
  ? 'Automatic creates a temporary PulseAudio / PipeWire source mirroring your default output ' +
    '(<code>pactl load-module module-remap-source</code>) while a session runs and removes it afterwards. ' +
    'If that fails, make your own source from the output’s monitor and pick it here, or reroute this app’s ' +
    'recording stream to “Monitor of …” in pavucontrol.'
  : isMac
    ? 'macOS has no built-in system-audio capture. Install <a href="https://existential.audio/blackhole/" target="_blank">BlackHole</a> ' +
      '(<code>brew install --cask blackhole-2ch</code>, then reboot or <code>sudo killall coreaudiod</code>), create a Multi-Output Device (your speakers + BlackHole — not the Teams / Zoom device) in ' +
      'Audio MIDI Setup, use it as the sound output during the call, then pick BlackHole here.'
    : 'Automatic uses Windows system loopback (whatever you hear). Pick a device only if you route the meeting through a virtual cable.';

// macOS 14.2+ records the system output directly (native helper); older macOS
// still needs a virtual device.
const macTap = isMac ? await api.macTap.info().catch(() => ({ supported: false, reason: '' })) : { supported: false };
if (macTap.supported) {
  $('systemAudioHint').innerHTML =
    'Automatic records the Mac\'s system audio output — everything you hear, from any meeting app, through any speaker or headphones. ' +
    'No BlackHole or Multi-Output Device needed. macOS asks once for <b>System Audio Recording</b> permission. ' +
    'Pick a device here only to capture a virtual device (BlackHole, Loopback) instead.';
}

const AUTO_LABEL = isLinux
  ? 'Automatic — mirror the default output (PulseAudio / PipeWire)'
  : isMac
    ? macTap.supported
      ? 'Automatic — Mac system audio output (everything you hear)'
      : 'Automatic — first virtual device found (BlackHole, Loopback…)'
    : 'Automatic — Windows system loopback (what you hear)';

async function fillDevices() {
  await api.ensureMicPermission().catch(() => {});
  // Device labels are blank until an input has been opened once.
  try {
    const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
    probe.getTracks().forEach((t) => t.stop());
  } catch { /* no permission or no input — the list will show ids only */ }
  let inputs = [];
  try {
    inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
  } catch { /* enumerate unavailable */ }

  const options = (autoLabel, savedId, savedLabel) => {
    const items = inputs.map((d, i) => ({ id: d.deviceId, label: d.label || `Audio input ${i + 1}` }));
    if (savedId && !items.some((d) => d.id === savedId)) items.push({ id: savedId, label: `${savedLabel || 'Saved device'} (not connected)` });
    return [{ id: '', label: autoLabel }, ...items]
      .map((d) => `<option value="${d.id}">${d.label.replace(/</g, '&lt;')}</option>`)
      .join('');
  };
  $('systemAudioDevice').innerHTML = options(AUTO_LABEL, settings.systemAudioDeviceId, settings.systemAudioDeviceLabel);
  $('systemAudioDevice').value = settings.systemAudioDeviceId || '';
  $('micDevice').innerHTML = options('System default microphone', settings.micDeviceId, '');
  $('micDevice').value = settings.micDeviceId || '';
}

$('systemAudioDevice').addEventListener('change', () => {
  const sel = $('systemAudioDevice');
  save({ systemAudioDeviceId: sel.value, systemAudioDeviceLabel: sel.value ? sel.options[sel.selectedIndex].text : '' });
});
$('micDevice').addEventListener('change', () => save({ micDeviceId: $('micDevice').value }));
$('refreshDevices').addEventListener('click', (e) => { e.preventDefault(); fillDevices(); });
navigator.mediaDevices?.addEventListener('devicechange', fillDevices);
fillDevices();

// initial fill
fillProfileFields(settings);
$('provider').value = settings.provider;
$('transcribeCandidate').checked = settings.transcribeCandidate;
$('autoAnswer').checked = settings.autoAnswer;
renderProviderFields();
renderKeyLocks();

// ---- guide ------------------------------------------------------------------
// Steps for this computer's platform by default; the switch shows the others
// (e.g. to help someone on Windows).
const OS_ID = isMac ? 'mac' : isLinux ? 'linux' : 'win';
function showGuideOs(os) {
  document.querySelector('.guide').dataset.guideOs = os;
  for (const b of document.querySelectorAll('[data-os-pick]')) b.classList.toggle('active', b.dataset.osPick === os);
  const mod = os === 'mac' ? '⌥⇧' : 'Alt+Shift+';
  for (const k of document.querySelectorAll('kbd[data-key]')) k.textContent = mod + k.dataset.key;
}
$('guideOs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-os-pick]');
  if (b) showGuideOs(b.dataset.osPick);
});
showGuideOs(OS_ID);

api.appInfo().then(({ version, macosVersion }) => {
  const osName = isMac ? `macOS ${macosVersion}` : isLinux ? 'Linux' : 'Windows';
  $('guideVersion').textContent = `Interview Copilot ${version} · ${osName}`;
}).catch(() => {});

// What Automatic does on this very machine, so the guide matches the app.
$('guideCaptureText').innerHTML = isMac
  ? macTap.supported
    ? 'On this Mac, <b>Automatic</b> records the <b>system audio output</b>: everything you hear, from Zoom, Teams, Meet or any other app, ' +
      'through your speakers, headphones or AirPods. You don\'t need BlackHole, a Multi-Output Device, or to change the speaker in the meeting app. ' +
      'If you can hear the interviewer, so can the app. macOS asks once for <b>System Audio Recording</b> permission.'
    : `This Mac can't record its system audio directly (${macTap.reason || 'needs macOS 14.2 or later'}). ` +
      'Route the meeting through a virtual audio device such as BlackHole. See <b>Older macOS: BlackHole</b> under Troubleshooting.'
  : isLinux
    ? '<b>Automatic</b> creates a temporary source that mirrors your default output (PulseAudio / PipeWire) while a session runs: whatever you hear.'
    : '<b>Automatic</b> records Windows system audio (loopback): whatever you hear through the default output device.';

// ---- transcription: engine + offline model download -------------------------
// The model list and what is on disk come from the main process (main/stt);
// the download runs there too, this page only shows its progress.
let stt = null;
const fmtBytes = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${Math.round(n / 1e6)} MB`);

function renderStt() {
  if (!stt) return;
  const engine = settings.sttEngine || 'offline';
  for (const r of document.querySelectorAll('input[name="sttEngine"]')) r.checked = r.value === engine;
  $('sttOffline').hidden = engine !== 'offline';
  const sel = $('sttModel');
  if (sel.options.length !== stt.models.length) {
    sel.innerHTML = stt.models.map((m) => `<option value="${m.id}">${m.label.replace(/</g, '&lt;')}</option>`).join('');
  }
  sel.value = stt.model;
  const m = stt.models.find((x) => x.id === stt.model) || stt.models[0];
  $('sttModelHint').textContent = m.hint;

  const state = $('sttState');
  const dl = stt.downloading && stt.downloading.modelId === m.id ? stt.downloading : null;
  if (!stt.supported) {
    state.textContent = stt.reason;
    state.className = 'bad';
  } else if (dl) {
    const pct = dl.total ? Math.floor((dl.received / dl.total) * 100) : 0;
    state.textContent = `Downloading… ${pct}% (${fmtBytes(dl.received)} of ${fmtBytes(dl.total)})${dl.file ? ` — ${dl.file}` : ''}`;
    state.className = '';
    $('sttBar').style.width = `${pct}%`;
  } else if (m.installed) {
    state.textContent = `Installed · ${fmtBytes(m.size)} on disk · ready to use`;
    state.className = 'ok';
  } else {
    state.textContent = m.onDisk ? `Partly downloaded (${fmtBytes(m.onDisk)} of ${fmtBytes(m.size)}) — Download continues where it stopped` : `Not downloaded · ${fmtBytes(m.size)}`;
    state.className = '';
  }
  $('sttProgress').hidden = !dl;
  $('sttDownload').hidden = Boolean(dl) || m.installed || !stt.supported;
  $('sttDownload').disabled = Boolean(stt.downloading);
  $('sttCancel').hidden = !dl;
  $('sttDelete').hidden = Boolean(dl) || !(m.installed || m.onDisk);
  $('sttNote').textContent = stt.supported
    ? 'The model runs on the CPU while a session is on. Download once per computer; the files are stored under ' + stt.dir
    : '';
}

async function refreshStt() {
  stt = await api.stt.status().catch(() => null);
  renderStt();
}

$('sttEngine').addEventListener('change', (e) => {
  if (e.target.name !== 'sttEngine') return;
  settings.sttEngine = e.target.value;
  save({ sttEngine: e.target.value });
  renderStt();
});
$('sttModel').addEventListener('change', () => {
  settings.sttModel = $('sttModel').value;
  if (stt) stt.model = settings.sttModel;
  save({ sttModel: settings.sttModel });
  renderStt();
});
$('sttDownload').addEventListener('click', async () => {
  const modelId = $('sttModel').value;
  $('sttDownload').disabled = true;
  await refreshStt();
  const res = await api.stt.download(modelId);
  await refreshStt();
  if (!res.ok && res.error !== 'cancelled') {
    $('sttState').textContent = `Download failed: ${res.error}`;
    $('sttState').className = 'bad';
  }
});
$('sttCancel').addEventListener('click', () => api.stt.cancelDownload());
$('sttDelete').addEventListener('click', async () => {
  stt = await api.stt.deleteModel($('sttModel').value);
  renderStt();
});
$('sttFolder').addEventListener('click', () => api.stt.openFolder());
api.stt.onDownloadProgress((p) => {
  if (!stt) return;
  stt.downloading = p;
  if (p.received >= p.total) stt.downloading = null; // the final status refresh marks it installed
  renderStt();
});
refreshStt();
