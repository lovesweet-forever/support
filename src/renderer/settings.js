import { PROVIDERS, LANGUAGES, ANSWER_STYLES, THEMES, applyTheme } from '../shared/constants.js';

const api = window.copilot;
const $ = (id) => document.getElementById(id);
const KEY_FIELD = { anthropic: 'anthropicKey', openai: 'openaiKey', gemini: 'geminiKey' };

let settings = await api.getSettings();
applyTheme(settings.theme);

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
  save({ theme: settings.theme });
});
renderThemeCards();

// The panel can change the theme too; follow it.
api.onSettingsChanged((s) => {
  if (s.theme !== settings.theme) { settings.theme = s.theme; applyTheme(s.theme); renderThemeCards(); }
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

function renderKeyLocks() {
  for (const field of ['anthropicKey', 'openaiKey', 'geminiKey', 'deepgramKey']) {
    const input = $(field);
    const fromFile = Boolean(settings.keysFromFile?.[field]);
    input.value = settings[field] || '';
    input.readOnly = fromFile;
    input.classList.toggle('from-file', fromFile);
    const note = document.querySelector(`[data-note="${field}"]`);
    if (note) note.textContent = fromFile ? 'Loaded from config/keys.json' : '';
  }
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

bindText('resume', 'resume');
bindText('jobDescription', 'jobDescription');
bindText('customPrompt', 'customPrompt');
bindText('deepgramKey', 'deepgramKey');
$('answerStyle').addEventListener('change', () => save({ answerStyle: $('answerStyle').value }));
$('language').addEventListener('change', () => save({ language: $('language').value }));
$('provider').addEventListener('change', () => { const provider = $('provider').value; save({ provider, model: PROVIDERS[provider].defaultModel }); renderProviderFields(); });
$('model').addEventListener('change', () => { $('modelCustom').value = ''; save({ model: $('model').value }); });
$('modelCustom').addEventListener('input', () => save({ model: $('modelCustom').value.trim() || $('model').value }));
$('providerKey') && null;
$('anthropicKey').addEventListener('input', () => save({ anthropicKey: $('anthropicKey').value.trim() }));
$('openaiKey').addEventListener('input', () => save({ openaiKey: $('openaiKey').value.trim() }));
$('geminiKey').addEventListener('input', () => save({ geminiKey: $('geminiKey').value.trim() }));
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
$('resume').value = settings.resume || '';
$('jobDescription').value = settings.jobDescription || '';
$('customPrompt').value = settings.customPrompt || '';
$('answerStyle').value = settings.answerStyle;
$('language').value = settings.language;
$('provider').value = settings.provider;
$('transcribeCandidate').checked = settings.transcribeCandidate;
$('autoAnswer').checked = settings.autoAnswer;
renderProviderFields();
renderKeyLocks();
