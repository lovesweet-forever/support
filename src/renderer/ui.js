// Panel UI. Builds the DOM once and exposes methods the glue calls. The window
// itself is the panel (frameless/transparent), so there are no floating-panel
// or shadow-DOM concerns; the code view is a column inside the same window.

import { LANGUAGES, PROVIDERS, ANSWER_STYLES, THEMES } from '../shared/constants.js';
import { renderRich, renderCodeOnly, codeResize } from '../shared/render.js';

const shortLabel = (l) => l.replace(/\s*\([^)]*\)\s*$/, '');
const PROVIDER_SHORT = { anthropic: 'Claude', openai: 'OpenAI', gemini: 'Gemini' };
// Same global shortcut everywhere; macOS shows Option/Shift as glyphs.
const HIDE_KEY = window.copilot?.platform === 'darwin' ? '⌥⇧I' : 'Alt+Shift+I';

export function buildPanel(root, handlers) {
  root.innerHTML = `
    <div class="panel">
      <div class="header">
        <span class="dot audio off" data-audio></span>
        <span class="title" data-title>Interview Copilot</span>
        <button class="start" data-start>Start</button>
        <select data-provider title="AI provider"></select>
        <select data-model title="Model"></select>
        <select data-style title="Answer style">
          ${Object.entries(ANSWER_STYLES).map(([id, s]) => `<option value="${id}">${shortLabel(s.label)}</option>`).join('')}
        </select>
        <select data-lang title="Language">
          ${LANGUAGES.map((l) => `<option value="${l.code}">${l.code.toUpperCase()}</option>`).join('')}
        </select>
        <select data-theme title="Theme">
          ${THEMES.map((t) => `<option value="${t.id}">${t.label}</option>`).join('')}
        </select>
        <button class="icon" data-settings title="Setup">&#9881;</button>
        <button class="icon" data-hide title="Hide (${HIDE_KEY})">&#8211;</button>
        <button class="icon" data-quit title="Quit">&times;</button>
      </div>
      <div class="warning" data-warning></div>
      <div class="section-label">Interviewer</div>
      <div class="transcript" data-transcript><div class="empty">Waiting for the interviewer…</div></div>
      <div class="section-label">
        <span>Question to send</span>
        <span class="section-actions">
          <button class="mini" data-clear>Clear</button>
          <button class="mini send" data-send>Send</button>
        </span>
      </div>
      <textarea class="pending" data-pending rows="2"
        placeholder="The interviewer's words collect here. Edit or type your own — then Enter or Send."></textarea>
      <div class="section-label">
        <span>Answer <span class="qa-counter" data-counter></span></span>
        <span class="section-actions">
          <button class="mini" data-font-dec>A&minus;</button>
          <button class="mini" data-font-inc>A+</button>
          <button class="mini" data-prev disabled>&lsaquo; Prev</button>
          <button class="mini" data-next disabled>Next &rsaquo;</button>
        </span>
      </div>
      <div class="content no-code" data-content>
        <div class="answer" data-answer><div class="empty">Answers appear here when you send a question.</div></div>
        <div class="seam" data-seam></div>
        <div class="code-col" data-code-col>
          <div class="code-head"><span class="title">Code</span><button class="mini" data-copy>Copy</button></div>
          <div class="code-body" data-code-body></div>
        </div>
      </div>
    </div>`;

  const $ = (s) => root.querySelector(s);
  const el = {
    audio: $('[data-audio]'), title: $('[data-title]'), start: $('[data-start]'),
    provider: $('[data-provider]'), model: $('[data-model]'), style: $('[data-style]'), lang: $('[data-lang]'),
    theme: $('[data-theme]'),
    warning: $('[data-warning]'), transcript: $('[data-transcript]'), pending: $('[data-pending]'),
    counter: $('[data-counter]'), content: $('[data-content]'), answer: $('[data-answer]'),
    seam: $('[data-seam]'), codeCol: $('[data-code-col]'), codeBody: $('[data-code-body]'),
    prev: $('[data-prev]'), next: $('[data-next]')
  };

  let answerEl = null;
  let interim = { interviewer: null, candidate: null };
  let codeShare = 0.25;
  let codeVisible = false;
  let availability = { anthropic: false, openai: false, gemini: false };
  let fontPx = 15;

  // ---- header actions
  el.start.onclick = () => handlers.onToggleSession();
  $('[data-settings]').onclick = () => handlers.onOpenSettings();
  $('[data-hide]').onclick = () => handlers.onHide();
  $('[data-quit]').onclick = () => handlers.onQuit();
  el.lang.onchange = () => handlers.onLanguage(el.lang.value);
  el.style.onchange = () => handlers.onStyle(el.style.value);
  el.theme.onchange = () => handlers.onTheme(el.theme.value);
  el.provider.onchange = () => { populateModels(el.provider.value); handlers.onProvider(el.provider.value, el.model.value); };
  el.model.onchange = () => handlers.onModel(el.model.value);

  // ---- send
  const send = () => handlers.onSend();
  $('[data-send]').onclick = send;
  $('[data-clear]').onclick = () => (el.pending.value = '');
  el.pending.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });

  // ---- font + nav + copy
  $('[data-font-dec]').onclick = () => handlers.onFont(fontPx - 1);
  $('[data-font-inc]').onclick = () => handlers.onFont(fontPx + 1);
  el.prev.onclick = () => handlers.onPrev();
  el.next.onclick = () => handlers.onNext();
  $('[data-copy]').onclick = async () => {
    const text = Array.from(el.codeBody.querySelectorAll('code')).map((c) => c.textContent).join('\n\n');
    try { await navigator.clipboard.writeText(text); } catch {}
  };

  // ---- seam drag (answer/code split)
  let seamStart = null;
  el.seam.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    seamStart = { x: e.clientX, mainW: el.answer.getBoundingClientRect().width, codeW: el.codeCol.getBoundingClientRect().width, mainLeft: 0 };
    el.seam.setPointerCapture(e.pointerId);
  });
  el.seam.addEventListener('pointermove', (e) => {
    if (!seamStart) return;
    const { mainW, codeW } = codeResize('seam', seamStart, e.clientX - seamStart.x, el.content.getBoundingClientRect().width);
    codeShare = codeW / (mainW + codeW);
    applyCodeWidth();
  });
  el.seam.addEventListener('pointerup', (e) => {
    if (!seamStart) return; seamStart = null;
    try { el.seam.releasePointerCapture(e.pointerId); } catch {}
    handlers.onCodeShare(codeShare);
  });

  function applyCodeWidth() {
    const total = el.content.getBoundingClientRect().width;
    el.codeCol.style.width = `${Math.round(total * codeShare)}px`;
  }

  function populateModels(providerId, keep) {
    const p = PROVIDERS[providerId] || PROVIDERS.anthropic;
    el.model.innerHTML = p.models.map((m) => `<option value="${m.id}">${shortLabel(m.label)}</option>`).join('');
    el.model.value = keep && p.models.some((m) => m.id === keep) ? keep : p.defaultModel;
  }

  const scroll = (node) => { node.scrollTop = node.scrollHeight; };

  function syncCode(fullText) {
    const has = String(fullText || '').includes('```');
    if (has) renderCodeOnly(el.codeBody, fullText); else el.codeBody.textContent = '';
    codeVisible = has;
    el.content.classList.toggle('no-code', !has);
    if (has) applyCodeWidth();
  }

  return {
    setAudioState(s) { el.audio.className = `dot audio ${s || 'off'}`; },
    setRunning(on) { el.start.textContent = on ? 'Stop' : 'Start'; el.start.classList.toggle('stop', on); },
    setWarning(msg) { el.warning.textContent = msg || ''; },
    setLanguage(code) { el.lang.value = code; },
    setStyle(id) { el.style.value = id; },
    setTheme(id) { el.theme.value = THEMES.some((t) => t.id === id) ? id : THEMES[0].id; },
    setFont(px) { fontPx = Math.min(28, Math.max(11, Math.round(px))); root.querySelector('.panel').style.setProperty('--answer-font', `${fontPx}px`); },
    setAiConfig({ provider, model, answerStyle, availability: avail }) {
      if (avail) availability = avail;
      el.provider.innerHTML = Object.entries(PROVIDERS).map(([id, p]) => {
        const has = availability[id];
        return `<option value="${id}"${has ? '' : ' disabled'}>${has ? '●' : '○'} ${PROVIDER_SHORT[id]}</option>`;
      }).join('');
      el.provider.value = provider;
      populateModels(provider, model);
      if (answerStyle) el.style.value = answerStyle;
      el.provider.classList.toggle('no-keys', !Object.values(availability).some(Boolean));
    },

    addTranscript({ channel, text, isFinal }) {
      el.transcript.querySelector('.empty')?.remove();
      if (!isFinal) {
        let node = interim[channel];
        if (!node) { node = document.createElement('div'); node.className = `turn interim ${channel}`; el.transcript.append(node); interim[channel] = node; }
        node.innerHTML = '<span class="who">interviewer</span>';
        node.append(document.createTextNode(text));
        scroll(el.transcript); return;
      }
      interim[channel]?.remove(); interim[channel] = null;
      const node = document.createElement('div');
      node.className = `turn ${channel}`;
      const who = document.createElement('span'); who.className = 'who'; who.textContent = channel;
      node.append(who, document.createTextNode(text));
      el.transcript.append(node);
      while (el.transcript.children.length > 40) el.transcript.firstElementChild.remove();
      scroll(el.transcript);
    },
    clearTranscript() { el.transcript.innerHTML = '<div class="empty">Waiting for the next question…</div>'; interim = { interviewer: null, candidate: null }; },

    getPending() { return el.pending.value; },
    appendPending(text) {
      const clean = (text || '').trim(); if (!clean) return;
      const cur = el.pending.value;
      el.pending.value = cur && !/\s$/.test(cur) ? `${cur} ${clean}` : `${cur}${clean}`;
      el.pending.scrollTop = el.pending.scrollHeight;
    },
    clearPending() { el.pending.value = ''; },

    startAnswer(question) {
      el.answer.innerHTML = '';
      if (question) { const q = document.createElement('div'); q.className = 'question'; q.textContent = question; el.answer.append(q); }
      answerEl = document.createElement('div'); answerEl.className = 'answer-text thinking'; el.answer.append(answerEl);
      syncCode(''); el.answer.scrollTop = 0;
    },
    updateAnswer(full) { if (!answerEl) this.startAnswer(''); renderRich(answerEl, full); syncCode(full); },
    finishAnswer(error) {
      answerEl?.classList.remove('thinking');
      if (error) { const e = document.createElement('div'); e.className = 'empty'; e.textContent = error; el.answer.append(e); }
      answerEl = null;
    },
    renderQA({ question, answer, streaming, error }) {
      el.answer.innerHTML = '';
      if (question) { const q = document.createElement('div'); q.className = 'question'; q.textContent = question; el.answer.append(q); }
      const node = document.createElement('div'); node.className = `answer-text${streaming ? ' thinking' : ''}`;
      renderRich(node, answer || ''); el.answer.append(node);
      if (error) { const e = document.createElement('div'); e.className = 'empty'; e.textContent = error; el.answer.append(e); }
      answerEl = streaming ? node : null;
      syncCode(answer || ''); el.answer.scrollTop = 0;
    },
    setNav({ index, total }) {
      const has = total > 0 && index >= 0;
      el.prev.disabled = !has || index <= 0;
      el.next.disabled = !has || index >= total - 1;
      el.counter.textContent = has ? `Q ${index + 1} / ${total}` : '';
    },
    setCodeShare(s) { if (typeof s === 'number' && isFinite(s)) { codeShare = Math.min(0.8, Math.max(0.1, s)); if (codeVisible) applyCodeWidth(); } }
  };
}
