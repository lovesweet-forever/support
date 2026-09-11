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
  await ensureSession();
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
  onProfile: (id) => api.selectProfile(id), // the settings:changed broadcast does the rest
  onSession: (id) => (id ? openSession(id) : closeSession()),
  onNewSession: newSession,
  onRenameSession: renameSession,
  onDeleteSession: deleteSession,
  onRetry: retryAnswer,
  onCodeShare: (codeShare) => save({ codeShare })
});

const clampFont = (px) => Math.min(28, Math.max(11, Math.round(px)));

async function save(patch) {
  settings = await api.setSettings(patch);
}

// ---- Q&A history (same model as the extension) ----------------------------
let qa = [];
// Every final utterance of both sides, for the PDF report (the on-screen
// transcript only keeps the last few interviewer turns).
const transcriptLog = [];
let viewIndex = -1;

// Save the open session — questions, attachments, answers and the spoken
// transcript — as a PDF, to review after the interview.
async function exportPdf() {
  if (!qa.length && !transcriptLog.length) { ui.notice('Nothing to export yet.'); return; }
  const began = session?.startedAt || startedAt;
  const html = buildReportHtml({ qa, transcript: transcriptLog, settings, startedAt: began, title: session?.title });
  const res = await api.exportPdf({ html, suggestedName: suggestedReportName(began, session?.title) });
  if (res.path) ui.notice(`Saved ${res.path}`);
  else if (res.error) ui.setWarning(`PDF export failed: ${res.error}`);
}

// ---- profiles + sessions (persisted in SQLite by the main process) ----------
// A session is one interview round. Its questions, answers, attachments and
// transcript are saved as they happen, and reopening it later restores the AI
// conversation so the next round continues where the last one stopped.
let session = null; // { id, title, startedAt } of the open session, or null until the first question
let sessions = [];

async function refreshProfiles() {
  const { profiles, activeId } = await api.listProfiles();
  ui.setProfiles(profiles, activeId);
}
async function refreshSessions() {
  sessions = await api.listSessions();
  ui.setSessions(sessions, session?.id);
}

// Forget the on-screen conversation (not the saved one).
function resetConversation() {
  qa = [];
  transcriptLog.length = 0;
  viewIndex = -1;
  awaitingNewQuestion = false;
  audio.setTurns([]);
  ui.clearTranscript();
  ui.clearAnswer();
  ui.setNav({ index: -1, total: 0 });
}

async function ensureSession() {
  if (!session) {
    session = await api.createSession();
    await refreshSessions();
  }
  return session;
}

async function newSession() {
  session = await api.createSession();
  resetConversation();
  await refreshSessions();
  ui.notice(`New session: ${session.title}`);
}

// Rename / delete the open session (the one selected in the picker).
async function renameSession(title) {
  const clean = String(title || '').trim();
  if (!session || !clean || clean === session.title) return;
  await api.renameSession(session.id, clean);
  session = { ...session, title: clean };
  await refreshSessions();
  ui.notice(`Renamed to "${clean}"`);
}
async function deleteSession() {
  if (!session) return;
  const n = qa.length;
  if (!window.confirm(`Delete "${session.title}"${n ? ` and its ${n} question${n === 1 ? '' : 's'}` : ''}? This cannot be undone.`)) return;
  await api.deleteSession(session.id);
  const title = session.title;
  session = null;
  resetConversation();
  await refreshSessions();
  ui.notice(`Deleted "${title}"`);
}

// "New session" picked in the dropdown: nothing is created until a question is asked.
function closeSession() {
  if (session) api.endSession(session.id);
  session = null;
  resetConversation();
  ui.setSessions(sessions, null);
}

async function openSession(id) {
  const data = await api.loadSession(id);
  if (!data) { ui.notice('That session no longer exists.'); await refreshSessions(); return; }
  if (session && session.id !== id) api.endSession(session.id);
  session = data.session;
  qa = data.turns.map((t) => ({ turnId: t.id, question: t.question, prompt: t.prompt, attachments: t.attachments, answer: t.answer,
    error: t.error, streaming: false, at: t.at }));
  transcriptLog.splice(0, transcriptLog.length, ...data.transcript);
  awaitingNewQuestion = false;
  audio.setTurns(data.turns);
  ui.clearTranscript();
  if (qa.length) showQA(qa.length - 1);
  else { ui.clearAnswer(); ui.setNav({ index: -1, total: 0 }); }
  ui.setSessions(sessions, session.id);
  ui.notice(`Continuing "${session.title}" — ${qa.length} question${qa.length === 1 ? '' : 's'} so far`);
}

async function persistTurn(entry) {
  const s = await ensureSession();
  if (entry.turnId) {
    // A retried question: the saved turn is updated, not duplicated.
    await api.updateTurn(entry.turnId, { prompt: entry.prompt, answer: entry.answer, error: entry.error });
  } else {
    entry.turnId = await api.addTurn(s.id, { question: entry.question, prompt: entry.prompt, answer: entry.answer, error: entry.error,
      at: entry.at, attachments: entry.attachments });
  }
  refreshSessions();
}
let awaitingNewQuestion = false;
// The entry an answer is currently streaming into (normally the last one; a
// retried older question streams into its own entry).
let activeIndex = -1;
const active = () => qa[activeIndex];
const viewingActive = () => viewIndex === activeIndex;

// ---- retry: ask the question on screen again -------------------------------
// For a flaky network: the answer errored, stalled, or came back cut off. The
// new answer replaces the old one in the same entry and in the saved session.
let retryIndex = null;
async function retryAnswer() {
  const entry = qa[viewIndex];
  if (!entry) return;
  retryIndex = viewIndex;
  await ensureSession();
  // If this was the latest, completed question, its old answer is already in
  // the AI's memory of the session — drop it so the retry does not see both.
  const replaceLast = viewIndex === qa.length - 1 && Boolean(entry.answer) && !entry.error;
  audio.ask(entry.question, entry.attachments, { replaceLast });
  ui.notice('Asking again…');
}

function showQA(index) {
  if (!qa.length) return;
  viewIndex = Math.max(0, Math.min(index, qa.length - 1));
  ui.renderQA(qa[viewIndex]);
  ui.setNav({ index: viewIndex, total: qa.length });
}

async function sendPending() {
  const text = ui.getPending().trim();
  const attachments = ui.getAttachments();
  if (!text && !attachments.length) return;
  await ensureSession();
  // A screenshot alone is a complete question ("solve what is on screen").
  audio.ask(text || DEFAULT_ATTACHMENT_QUESTION, attachments);
  ui.clearPending();
  ui.clearAttachments();
  awaitingNewQuestion = true;
}

// ---- audio session --------------------------------------------------------
// Which input carries the interviewer, and whether we already warned that it
// is silent (once per Start).
let captureLabel = '';
let silenceWarned = false;
function silenceAdvice() {
  const dev = captureLabel ? `"${captureLabel}"` : 'the system-audio device';
  if (api.platform === 'darwin') {
    return `No sound is reaching ${dev}. Set the Mac's sound output (Control Centre → Sound) to your Multi-Output Device, ` +
      'and in the meeting app set the Speaker to that same device (Teams: Settings → Devices → Speaker; Zoom: Settings → Audio). ' +
      'The interviewer must be audible through it.';
  }
  if (api.platform === 'linux') {
    return `No sound is reaching ${dev}. The meeting app must play through the default output; if you switched outputs, press Stop and Start again.`;
  }
  return `No sound is reaching ${dev}. Make sure the meeting is playing through the default Windows output device and is not muted.`;
}

const audio = new AudioSession({
  getSettings: () => settings,
  emit: (e) => {
    switch (e.type) {
      case 'transcript':
        // Both sides are kept: the full transcript of the interview goes into
        // the session and the PDF, where the candidate's words are shown
        // under the question they answered.
        if (e.isFinal) {
          const entry = { channel: e.channel, text: e.text, at: Date.now() };
          transcriptLog.push(entry);
          if (session) api.addTranscript(session.id, entry);
        }
        // The candidate's words are saved (session + PDF) but not shown: the
        // pane stays the interviewer only.
        if (e.channel !== 'interviewer') break;
        if (awaitingNewQuestion) { ui.clearTranscript(); awaitingNewQuestion = false; }
        ui.addTranscript(e);
        // The interviewer's words reach the question box as they are heard;
        // the final sentence replaces the live guess.
        if (e.isFinal) ui.appendPending(e.text);
        else ui.setInterimPending(e.text);
        break;
      case 'answer-start': {
        for (const entry of qa) entry.streaming = false;
        const retried = retryIndex !== null && qa[retryIndex] && qa[retryIndex].question === e.question ? qa[retryIndex] : null;
        retryIndex = null;
        if (retried) {
          // Same entry, fresh answer (the original time is kept so the
          // candidate's spoken reply still lines up with it in the PDF).
          Object.assign(retried, { prompt: e.prompt, answer: '', streaming: true, error: null });
          activeIndex = qa.indexOf(retried);
        } else {
          ui.clearPending();
          qa.push({ question: e.question, prompt: e.prompt, attachments: e.attachments || [], answer: '', streaming: true, error: null, at: Date.now() });
          activeIndex = qa.length - 1;
        }
        viewIndex = activeIndex;
        ui.startAnswer(e.question, qa[activeIndex].attachments);
        ui.setNav({ index: viewIndex, total: qa.length });
        break;
      }
      case 'answer-delta': {
        const entry = active(); if (!entry) break;
        entry.answer += e.text;
        if (viewingActive()) ui.updateAnswer(entry.answer);
        break;
      }
      case 'answer-done': {
        const entry = active(); if (!entry) break;
        entry.streaming = false; entry.error = e.error || null;
        if (viewingActive()) ui.finishAnswer(e.error);
        persistTurn(entry);
        break;
      }
      case 'capture':
        captureLabel = e.label;
        silenceWarned = false;
        ui.notice(`Listening to the interviewer on "${captureLabel || 'system audio'}"`);
        break;
      case 'audio-state':
        ui.setAudioState(e.state);
        // Connected but hearing nothing for a while: almost always the meeting
        // audio is not routed to the device we capture. Say so, with the fix.
        if (e.state === 'silent' && !silenceWarned) {
          silenceWarned = true;
          ui.setWarning(silenceAdvice());
        } else if (e.state === 'hearing' && silenceWarned) {
          silenceWarned = false;
          ui.setWarning('');
        }
        break;
      case 'running':
        ui.setRunning(e.running);
        if (!e.running) { ui.setAudioState('off'); if (session) api.endSession(session.id); }
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
  const profileChanged = s.activeProfileId !== settings.activeProfileId;
  settings = s;
  refreshProfiles();
  if (profileChanged) {
    // Another company / role: its sessions are separate, so start clean.
    if (session) api.endSession(session.id);
    session = null;
    resetConversation();
    refreshSessions();
  }
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
refreshSessions();
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
