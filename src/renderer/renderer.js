// Renderer glue: wires the panel UI to the audio session, the settings store
// (over the preload bridge) and the global shortcuts. This is the desktop
// counterpart of the extension's content script + offscreen router.

import { buildPanel } from './ui.js';
import { AudioSession } from './audio.js';
import { providerAvailability, firstAvailableProvider } from '../shared/settings-util.js';
import { PROVIDERS, applyTheme, applyFont } from '../shared/constants.js';
import { DEFAULT_ATTACHMENT_QUESTION } from '../shared/attachments.js';
import { buildReportHtml, suggestedReportName } from './report.js';

const api = window.copilot;
let settings = await api.getSettings();
const startedAt = Date.now();

// The inputs an answer is grounded in. Starting without them produces generic,
// ungrounded answers, so Start requires them and sends you to Setup if missing.
const REQUIRED = [
  { key: 'resume', label: 'resume' },
  { key: 'jobDescription', label: 'job description' },
  { key: 'customPrompt', label: 'custom prompt' }
];

function missingInputs() {
  const missing = REQUIRED.filter((r) => !String(settings[r.key] || '').trim()).map((r) => r.label);
  if (!String(settings.deepgramKey || '').trim()) missing.push('Deepgram API key');
  return missing;
}

async function toggleSession() {
  if (audio.running) {
    audio.stop();
    return;
  }
  const missing = missingInputs();
  if (missing.length) {
    ui.setWarning(`Add your ${missing.join(', ')} in Setup before starting.`);
    await api.openSettings();
    return;
  }
  ui.setWarning('');
  audio.start();
}

const ui = buildPanel(document.getElementById('root'), {
  onToggleSession: toggleSession,
  onOpenSettings: () => api.openSettings(),
  onHide: () => api.hidePanel(),
  onQuit: () => api.quit(),
  onLanguage: (language) => { save({ language }); audio.setLanguage(language); },
  onStyle: (answerStyle) => save({ answerStyle }),
  onTheme: (theme) => { applyTheme(theme); save({ theme }); },
  onProvider: (provider, model) => save({ provider, model }),
  onModel: (model) => save({ model }),
  onFont: (px) => { ui.setFont(px); save({ answerFontSize: clampFont(px) }); },
  onSend: sendPending,
  onPrev: () => showQA(viewIndex - 1),
  onNext: () => showQA(viewIndex + 1),
  onExport: exportPdf,
  onCodeShare: (codeShare) => save({ codeShare })
});

const clampFont = (px) => Math.min(28, Math.max(11, Math.round(px)));

async function save(patch) {
  settings = await api.setSettings(patch);
}

// ---- Q&A history (same model as the extension) ----------------------------
const qa = [];
// Every final utterance of both sides, for the PDF report (the on-screen
// transcript only keeps the last few interviewer turns).
const transcriptLog = [];
let viewIndex = -1;

// Save everything since the app was opened — questions, attachments, answers
// and the spoken transcript — as a PDF, to review after the interview.
async function exportPdf() {
  if (!qa.length && !transcriptLog.length) { ui.notice('Nothing to export yet.'); return; }
  const html = buildReportHtml({ qa, transcript: transcriptLog, settings, startedAt });
  const res = await api.exportPdf({ html, suggestedName: suggestedReportName(startedAt) });
  if (res.path) ui.notice(`Saved ${res.path}`);
  else if (res.error) ui.setWarning(`PDF export failed: ${res.error}`);
}
let awaitingNewQuestion = false;
const latest = () => qa[qa.length - 1];
const viewingLatest = () => viewIndex === qa.length - 1;

function showQA(index) {
  if (!qa.length) return;
  viewIndex = Math.max(0, Math.min(index, qa.length - 1));
  ui.renderQA(qa[viewIndex]);
  ui.setNav({ index: viewIndex, total: qa.length });
}

function sendPending() {
  const text = ui.getPending().trim();
  const attachments = ui.getAttachments();
  if (!text && !attachments.length) return;
  // A screenshot alone is a complete question ("solve what is on screen").
  audio.ask(text || DEFAULT_ATTACHMENT_QUESTION, attachments);
  ui.clearPending();
  ui.clearAttachments();
  awaitingNewQuestion = true;
}

// ---- audio session --------------------------------------------------------
const audio = new AudioSession({
  getSettings: () => settings,
  emit: (e) => {
    switch (e.type) {
      case 'transcript':
        if (e.isFinal) transcriptLog.push({ channel: e.channel, text: e.text, at: Date.now() });
        if (e.channel !== 'interviewer') break;
        if (awaitingNewQuestion) { ui.clearTranscript(); awaitingNewQuestion = false; }
        ui.addTranscript(e);
        if (e.isFinal) ui.appendPending(e.text);
        break;
      case 'answer-start':
        ui.clearPending();
        for (const entry of qa) entry.streaming = false;
        qa.push({ question: e.question, attachments: e.attachments || [], answer: '', streaming: true, error: null, at: Date.now() });
        viewIndex = qa.length - 1;
        ui.startAnswer(e.question, e.attachments);
        ui.setNav({ index: viewIndex, total: qa.length });
        break;
      case 'answer-delta': {
        const entry = latest(); if (!entry) break;
        entry.answer += e.text;
        if (viewingLatest()) ui.updateAnswer(entry.answer);
        break;
      }
      case 'answer-done': {
        const entry = latest(); if (!entry) break;
        entry.streaming = false; entry.error = e.error || null;
        if (viewingLatest()) ui.finishAnswer(e.error);
        break;
      }
      case 'audio-state':
        ui.setAudioState(e.state);
        break;
      case 'running':
        ui.setRunning(e.running);
        if (!e.running) ui.setAudioState('off');
        break;
      case 'error':
        ui.setWarning(e.message);
        break;
    }
  }
});

// ---- reflect settings into the UI -----------------------------------------
function pushAiConfig(s) {
  const availability = providerAvailability(s);
  let provider = s.provider;
  let model = s.model;
  if (!availability[provider]) {
    const fb = firstAvailableProvider(s);
    if (fb) { provider = fb; model = PROVIDERS[fb].defaultModel; save({ provider, model }); }
  }
  ui.setAiConfig({ provider, model, answerStyle: s.answerStyle, availability });
}

function applySettings(s) {
  settings = s;
  applyTheme(s.theme);
  applyFont(s);
  ui.setTheme(s.theme);
  ui.setLanguage(s.language);
  ui.setStyle(s.answerStyle);
  ui.setFont(s.answerFontSize);
  ui.setCodeShare(s.codeShare);
  pushAiConfig(s);
  api.setPanelOpacity(s.panelOpacity);
  audio.setAutoAnswer(s.autoAnswer);
  audio.setLanguage(s.language);
}

applySettings(settings);
api.onSettingsChanged((s) => applySettings(s));

// ---- global shortcuts (fired from the main process) -----------------------
api.onShortcut('answer', sendPending);
api.onShortcut('toggle-session', toggleSession);
api.onShortcut('font-inc', () => { const px = clampFont(settings.answerFontSize + 1); ui.setFont(px); save({ answerFontSize: px }); });
api.onShortcut('font-dec', () => { const px = clampFont(settings.answerFontSize - 1); ui.setFont(px); save({ answerFontSize: px }); });

// Look-to-read: full opacity while the pointer is over the panel.
document.body.addEventListener('mouseenter', () => api.setPanelOpacity(1));
document.body.addEventListener('mouseleave', () => api.setPanelOpacity(settings.panelOpacity));

console.info('[Interview Copilot Desktop] renderer ready');
