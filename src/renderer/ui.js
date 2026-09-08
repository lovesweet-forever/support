// Panel UI. Builds the DOM once and exposes methods the glue calls. The window
// itself is the panel (frameless/transparent), so there are no floating-panel
// or shadow-DOM concerns; the code view is a column inside the same window.

import { LANGUAGES, PROVIDERS, ANSWER_STYLES, THEMES } from '../shared/constants.js';
import { renderRich, renderCodeOnly, codeResize } from '../shared/render.js';
import { LIMITS } from '../shared/attachments.js';
import { fileToAttachment, namePasted, captureScreen } from './attach.js';

// One attachment as a small chip: thumbnail (images) or a type badge, the
// name, and optionally a remove button. DOM nodes only — names are user data.
function chip(a, onRemove) {
  const c = document.createElement('span');
  c.className = `chip ${a.kind}`;
  if (a.preview) {
    const img = document.createElement('img'); img.src = a.preview; img.alt = ''; c.append(img);
  } else {
    const badge = document.createElement('span'); badge.className = 'chip-icon'; badge.textContent = a.kind === 'pdf' ? 'PDF' : 'TXT'; c.append(badge);
  }
  const name = document.createElement('span'); name.className = 'chip-name'; name.textContent = a.name; name.title = a.name; c.append(name);
  if (onRemove) {
    const x = document.createElement('button'); x.className = 'chip-x'; x.textContent = '×'; x.title = 'Remove'; x.onclick = onRemove; c.append(x);
  }
  return c;
}

// The question block above an answer, with the attachments it was sent with.
function questionNode(question, attachments) {
  const q = document.createElement('div'); q.className = 'question';
  if (question) q.append(document.createTextNode(question));
  if (attachments?.length) {
    const list = document.createElement('div'); list.className = 'attachments';
    for (const a of attachments) list.append(chip(a));
    q.append(list);
  }
  return q;
}

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
      <div class="section-label">
        <span>Interviewer</span>
        <span class="section-actions">
          <select data-profile title="Profile (company / role) — resume, job description and prompt come from it"></select>
          <select data-session title="Session — pick an earlier one to continue that conversation"></select>
          <button class="mini" data-new-session title="Start a fresh session for this profile">New</button>
          <button class="mini" data-rename-session title="Rename the selected session" disabled>Rename</button>
          <button class="mini" data-delete-session title="Delete the selected session and everything saved in it" disabled>Delete</button>
        </span>
      </div>
      <dialog class="rename" data-rename-dialog>
        <form method="dialog">
          <label>Session name<input type="text" data-rename-input maxlength="120" spellcheck="false" /></label>
          <div class="dialog-actions">
            <button type="button" class="mini" data-rename-cancel>Cancel</button>
            <button type="submit" class="mini send" data-rename-ok>Rename</button>
          </div>
        </form>
      </dialog>
      <div class="transcript" data-transcript><div class="empty">Waiting for the interviewer…</div></div>
      <div class="section-label">
        <span>Question to send</span>
        <span class="section-actions">
          <button class="mini" data-snap title="Screenshot the screen and attach it (the panel is not in the shot)">Snap</button>
          <button class="mini" data-attach title="Attach images, PDFs or text/code files (or paste / drop them)">Attach</button>
          <input type="file" data-file multiple hidden accept="image/*,.pdf,text/*,.txt,.md,.json,.csv,.xml,.yaml,.yml,.sql,.js,.ts,.tsx,.jsx,.py,.java,.cs,.go,.rs,.rb,.php,.kt,.swift,.c,.h,.cpp,.sh,.html,.css" />
          <button class="mini" data-clear>Clear</button>
        </span>
      </div>
      <div class="compose">
        <textarea class="pending" data-pending rows="2"
          placeholder="The interviewer's words collect here. Edit or type your own — then Enter or Send. Paste or drop a screenshot to attach it."></textarea>
        <button class="send" data-send title="Send the question (Enter)">Send</button>
      </div>
      <div class="attachments" data-attachments></div>
      <div class="section-label">
        <span>Answer <span class="qa-counter" data-counter></span></span>
        <span class="section-actions">
          <button class="mini" data-font-dec>A&minus;</button>
          <button class="mini" data-font-inc>A+</button>
          <button class="mini" data-export title="Save every question and answer of this session as a PDF">PDF</button>
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
    theme: $('[data-theme]'), profile: $('[data-profile]'), session: $('[data-session]'),
    warning: $('[data-warning]'), transcript: $('[data-transcript]'), pending: $('[data-pending]'),
    attachments: $('[data-attachments]'), file: $('[data-file]'), snap: $('[data-snap]'),
    counter: $('[data-counter]'), content: $('[data-content]'), answer: $('[data-answer]'),
    seam: $('[data-seam]'), codeCol: $('[data-code-col]'), codeBody: $('[data-code-body]'),
    prev: $('[data-prev]'), next: $('[data-next]')
  };

  let answerEl = null;
  let interim = { interviewer: null, candidate: null };
  // The live (not yet final) words currently shown at the end of the question box.
  let interimInBox = '';
  // The box without the live words. If the user edited the box so it no longer
  // ends with them, the whole value is kept as-is.
  const pendingBase = () => {
    const v = el.pending.value;
    return interimInBox && v.endsWith(interimInBox) ? v.slice(0, v.length - interimInBox.length) : v;
  };
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
  el.profile.onchange = () => handlers.onProfile(Number(el.profile.value));
  el.session.onchange = () => handlers.onSession(el.session.value ? Number(el.session.value) : null);
  $('[data-new-session]').onclick = () => handlers.onNewSession();
  // Rename: a small in-panel dialog (window.prompt does not exist in Electron).
  const renameDialog = $('[data-rename-dialog]');
  const renameInput = $('[data-rename-input]');
  $('[data-rename-session]').onclick = () => {
    if (!el.session.value) return;
    renameInput.value = el.session.selectedOptions[0]?.dataset.title || '';
    renameDialog.showModal();
    renameInput.select();
  };
  $('[data-rename-cancel]').onclick = () => renameDialog.close();
  renameDialog.querySelector('form').onsubmit = (e) => {
    e.preventDefault();
    const title = renameInput.value.trim();
    renameDialog.close();
    if (title) handlers.onRenameSession(title);
  };
  renameInput.addEventListener('keydown', (e) => e.stopPropagation());
  $('[data-delete-session]').onclick = () => { if (el.session.value) handlers.onDeleteSession(); };
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  el.provider.onchange = () => { populateModels(el.provider.value); handlers.onProvider(el.provider.value, el.model.value); };
  el.model.onchange = () => handlers.onModel(el.model.value);

  // ---- send
  const send = () => handlers.onSend();
  $('[data-send]').onclick = send;
  $('[data-clear]').onclick = () => { el.pending.value = ''; clearAttachments(); };
  el.pending.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });

  // ---- attachments (screenshots / files sent with the question)
  let attachments = [];
  let noticeTimer = null;
  const notice = (msg) => {
    el.warning.textContent = msg;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { if (el.warning.textContent === msg) el.warning.textContent = ''; }, 6000);
  };
  function renderAttachments() {
    el.attachments.textContent = '';
    attachments.forEach((a, i) => el.attachments.append(chip(a, () => { attachments.splice(i, 1); renderAttachments(); })));
  }
  function addAttachment(a) {
    if (attachments.length >= LIMITS.maxCount) { notice(`At most ${LIMITS.maxCount} attachments per question.`); return false; }
    attachments.push(a); renderAttachments(); return true;
  }
  async function addFiles(files) {
    const failed = [];
    for (const file of Array.from(files || [])) {
      try { if (!addAttachment(await fileToAttachment(file))) break; }
      catch (err) { failed.push(err.message); }
    }
    if (failed.length) notice(failed.join(' · '));
  }
  function clearAttachments() { attachments = []; renderAttachments(); }

  $('[data-attach]').onclick = () => el.file.click();
  el.file.onchange = () => { addFiles(el.file.files); el.file.value = ''; };
  el.snap.onclick = async () => {
    el.snap.disabled = true;
    try { addAttachment(await captureScreen()); }
    catch (err) { notice(`Screenshot failed: ${err.message}`); }
    finally { el.snap.disabled = false; }
  };
  // Paste a screenshot (Win+Shift+S / Cmd+Shift+4 then Ctrl+V) into the question box.
  el.pending.addEventListener('paste', (e) => {
    const files = Array.from(e.clipboardData?.files || []);
    if (!files.length) return;
    e.preventDefault();
    addFiles(files.map((f, i) => namePasted(f, i)));
  });
  // Drop files anywhere on the panel.
  const panelEl = root.querySelector('.panel');
  root.addEventListener('dragover', (e) => { e.preventDefault(); panelEl.classList.add('dropping'); });
  root.addEventListener('dragleave', (e) => { if (!root.contains(e.relatedTarget)) panelEl.classList.remove('dropping'); });
  root.addEventListener('drop', (e) => { e.preventDefault(); panelEl.classList.remove('dropping'); addFiles(e.dataTransfer?.files); });

  // ---- font + nav + copy
  $('[data-font-dec]').onclick = () => handlers.onFont(fontPx - 1);
  $('[data-font-inc]').onclick = () => handlers.onFont(fontPx + 1);
  el.prev.onclick = () => handlers.onPrev();
  el.next.onclick = () => handlers.onNext();
  const exportBtn = $('[data-export]');
  exportBtn.onclick = async () => {
    exportBtn.disabled = true;
    try { await handlers.onExport(); } finally { exportBtn.disabled = false; }
  };
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
    /** A short status line that clears itself after a few seconds. */
    notice,
    setLanguage(code) { el.lang.value = code; },
    setStyle(id) { el.style.value = id; },
    setTheme(id) { el.theme.value = THEMES.some((t) => t.id === id) ? id : THEMES[0].id; },
    setProfiles(list, activeId) {
      el.profile.innerHTML = list.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
      el.profile.value = String(activeId ?? '');
    },
    setSessions(list, currentId) {
      const label = (s) => `${s.title} · ${s.turnCount} Q`;
      el.session.innerHTML = ['<option value="">New session</option>',
        ...list.map((s) => `<option value="${s.id}" data-title="${esc(s.title)}">${esc(label(s))}</option>`)].join('');
      el.session.value = currentId ? String(currentId) : '';
      const has = Boolean(el.session.value);
      $('[data-rename-session]').disabled = !has;
      $('[data-delete-session]').disabled = !has;
    },
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
        node.textContent = '';
        const who = document.createElement('span'); who.className = 'who'; who.textContent = channel === 'candidate' ? 'you' : channel;
        node.append(who, document.createTextNode(text));
        scroll(el.transcript); return;
      }
      interim[channel]?.remove(); interim[channel] = null;
      const node = document.createElement('div');
      node.className = `turn ${channel}`;
      const who = document.createElement('span'); who.className = 'who'; who.textContent = channel === 'candidate' ? 'you' : channel;
      node.append(who, document.createTextNode(text));
      el.transcript.append(node);
      while (el.transcript.children.length > 40) el.transcript.firstElementChild.remove();
      scroll(el.transcript);
    },
    clearTranscript() { el.transcript.innerHTML = '<div class="empty">Waiting for the next question…</div>'; interim = { interviewer: null, candidate: null }; },
    clearAnswer() {
      el.answer.innerHTML = '<div class="empty">Answers appear here when you send a question.</div>';
      answerEl = null; syncCode('');
    },

    getPending() { return el.pending.value; },
    /**
     * The interviewer's words go into the box as they are heard: the live
     * (interim) guess sits at the end and is replaced as Deepgram revises it,
     * then by the final sentence. Anything the user typed stays.
     */
    setInterimPending(text) {
      const base = pendingBase();
      const clean = (text || '').trim();
      interimInBox = clean ? `${base && !/\s$/.test(base) ? ' ' : ''}${clean}` : '';
      el.pending.value = base + interimInBox;
      el.pending.scrollTop = el.pending.scrollHeight;
    },
    appendPending(text) {
      const base = pendingBase();
      interimInBox = '';
      const clean = (text || '').trim();
      el.pending.value = clean ? (base && !/\s$/.test(base) ? `${base} ${clean}` : `${base}${clean}`) : base;
      el.pending.scrollTop = el.pending.scrollHeight;
    },
    clearPending() { el.pending.value = ''; interimInBox = ''; },
    getAttachments() { return attachments.slice(); },
    clearAttachments,

    startAnswer(question, atts) {
      el.answer.innerHTML = '';
      if (question || atts?.length) el.answer.append(questionNode(question, atts));
      answerEl = document.createElement('div'); answerEl.className = 'answer-text thinking'; el.answer.append(answerEl);
      syncCode(''); el.answer.scrollTop = 0;
    },
    updateAnswer(full) { if (!answerEl) this.startAnswer(''); renderRich(answerEl, full); syncCode(full); },
    finishAnswer(error) {
      answerEl?.classList.remove('thinking');
      if (error) { const e = document.createElement('div'); e.className = 'empty'; e.textContent = error; el.answer.append(e); }
      answerEl = null;
    },
    renderQA({ question, attachments: atts, answer, streaming, error }) {
      el.answer.innerHTML = '';
      if (question || atts?.length) el.answer.append(questionNode(question, atts));
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
