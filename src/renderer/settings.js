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

// ---- tabs: Profile (this interview) / App (the program itself) --------------
function showTab(id) {
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
showTab(document.querySelector(`.tab[data-tab="${lastTab}"]`) ? lastTab : 'profile');

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
      '(<code>brew install blackhole-2ch</code>), create a Multi-Output Device (your speakers + BlackHole) in ' +
      'Audio MIDI Setup, use it as the sound output during the call, then pick BlackHole here.'
    : 'Automatic uses Windows system loopback (whatever you hear). Pick a device only if you route the meeting through a virtual cable.';

const AUTO_LABEL = isLinux
  ? 'Automatic — mirror the default output (PulseAudio / PipeWire)'
  : isMac
    ? 'Automatic — first virtual device found (BlackHole, Loopback…)'
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
