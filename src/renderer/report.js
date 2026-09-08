// Builds the session report (every question, its attachments and answer, plus
// the spoken transcript) as a self-contained HTML page. The main process
// renders it in a hidden window and prints it to PDF (see main.js
// 'report:export-pdf'). Answers are rendered with the same renderRich used on
// screen, so highlights and code blocks look the same in the PDF.

import { renderRich } from '../shared/render.js';
import { PROVIDERS, languageByCode, ANSWER_STYLES } from '../shared/constants.js';

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const time = (ms) => (ms ? new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '');

function answerHtml(text) {
  const div = document.createElement('div');
  renderRich(div, text || '');
  return div.innerHTML;
}

function attachmentsHtml(atts = []) {
  if (!atts.length) return '';
  const items = atts.map((a) =>
    a.preview
      ? `<figure><img src="${a.preview}" alt=""><figcaption>${esc(a.name)}</figcaption></figure>`
      : `<div class="file">${a.kind === 'pdf' ? 'PDF' : 'TXT'} &nbsp;${esc(a.name)}</div>`
  );
  return `<div class="attachments">${items.join('')}</div>`;
}

const CSS = `
  * { box-sizing: border-box; }
  body { margin: 0; padding: 0; font: 11.5pt/1.5 "Segoe UI", -apple-system, Helvetica, Arial, sans-serif; color: #1b1f27; }
  h1 { margin: 0 0 2px; font-size: 20pt; }
  .meta { margin: 0 0 18px; color: #555; font-size: 10pt; }
  .meta span { margin-right: 14px; }
  .qa { margin: 0 0 22px; padding-top: 12px; border-top: 1px solid #ddd; }
  .qa-head { display: flex; justify-content: space-between; margin-bottom: 4px; font-size: 9.5pt; color: #666; text-transform: uppercase; letter-spacing: .6px; }
  .question { margin: 0 0 10px; padding: 8px 12px; background: #f3f5f9; border-left: 3px solid #2563eb; border-radius: 4px; white-space: pre-wrap; break-inside: avoid; }
  .attachments { display: flex; flex-wrap: wrap; gap: 10px; margin: 8px 0 0; }
  .attachments figure { margin: 0; max-width: 48%; break-inside: avoid; }
  .attachments img { display: block; max-width: 100%; max-height: 3.2in; border: 1px solid #ccc; border-radius: 4px; }
  .attachments figcaption { font-size: 8.5pt; color: #666; }
  .attachments .file { font-size: 9.5pt; color: #444; padding: 3px 8px; border: 1px solid #ccc; border-radius: 4px; align-self: flex-start; }
  .answer { white-space: pre-wrap; }
  .answer strong { color: #9a3412; }
  .answer code.inline { padding: 0 4px; font: .92em Consolas, Menlo, monospace; color: #6d28d9; background: #eef0f4; border-radius: 3px; }
  .answer pre.code { margin: 8px 0; padding: 8px 10px; font: 9.5pt/1.45 Consolas, Menlo, monospace; white-space: pre-wrap; background: #f6f7f9; border: 1px solid #ddd; border-left: 3px solid #2563eb; border-radius: 4px; }
  .answer pre.code .lang { display: block; margin-bottom: 4px; font-size: 8pt; font-weight: 700; letter-spacing: .6px; text-transform: uppercase; color: #2563eb; }
  .error { margin-top: 6px; color: #b91c1c; font-style: italic; }
  .block-label { margin: 12px 0 4px; font-size: 9.5pt; font-weight: 700; letter-spacing: .6px; text-transform: uppercase; color: #666; }
  .block-label.ai { color: #2563eb; }
  .block-label.said { color: #059669; }
  .answered { padding: 8px 12px; background: #f0faf5; border-left: 3px solid #059669; border-radius: 4px; white-space: pre-wrap; }
  .answered .t { color: #888; font-size: 9pt; margin-right: 6px; font-variant-numeric: tabular-nums; }
  .answered .none { color: #888; font-style: italic; }
  h2 { margin: 28px 0 8px; font-size: 14pt; break-after: avoid; }
  .transcript { font-size: 10pt; }
  .turn { display: grid; grid-template-columns: 86px 84px 1fr; gap: 8px; padding: 2px 0; border-bottom: 1px dotted #e3e5ea; }
  .turn .t { color: #888; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .turn .who { font-weight: 700; text-transform: uppercase; font-size: 8.5pt; letter-spacing: .5px; }
  .turn.interviewer .who { color: #2563eb; }
  .turn.candidate .who { color: #059669; }
  .empty { color: #888; font-style: italic; }
`;

/**
 * @param {object} p
 * @param {Array} p.qa            [{ question, attachments, answer, error, at }]
 * @param {Array} p.transcript    [{ channel, text, at }]
 * @param {object} p.settings     current settings (provider / model / language / style)
 * @param {number} p.startedAt    when the session started
 * @param {string} [p.title]      session title (profile name + date)
 */
export function buildReportHtml({ qa, transcript, settings, startedAt, title }) {
  const now = new Date();
  const provider = PROVIDERS[settings.provider]?.label || settings.provider;
  const style = ANSWER_STYLES[settings.answerStyle]?.label || settings.answerStyle;
  const lang = languageByCode(settings.language).label;

  // What the candidate actually said in reply to each question: their
  // utterances from when the question was sent until the next one.
  const candidateSaid = (i) => {
    const from = qa[i].at || 0;
    const to = qa[i + 1]?.at ?? Infinity;
    return transcript.filter((t) => t.channel === 'candidate' && t.at >= from && t.at < to);
  };
  const saidHtml = (lines) =>
    lines.length
      ? lines.map((t) => `<div><span class="t">${time(t.at)}</span>${esc(t.text)}</div>`).join('')
      : `<span class="none">${
          settings.transcribeCandidate === false
            ? 'Not captured — turn on "Also transcribe my microphone" in Setup → App → Capture.'
            : 'Nothing was heard from you before the next question.'
        }</span>`;

  const qaHtml = qa.length
    ? qa
        .map(
          (e, i) => `<section class="qa">
  <div class="qa-head"><span>Question ${i + 1} of ${qa.length}</span><span>${time(e.at)}</span></div>
  <div class="block-label">Interviewer asked</div>
  <div class="question">${esc(e.question)}${attachmentsHtml(e.attachments)}</div>
  <div class="block-label ai">AI suggested</div>
  <div class="answer">${answerHtml(e.answer)}</div>
  ${e.error ? `<div class="error">${esc(e.error)}</div>` : ''}
  <div class="block-label said">You answered</div>
  <div class="answered">${saidHtml(candidateSaid(i))}</div>
</section>`
        )
        .join('\n')
    : '<p class="empty">No questions were answered in this session.</p>';

  const transcriptHtml = transcript.length
    ? transcript
        .map((t) => `<div class="turn ${esc(t.channel)}"><span class="t">${time(t.at)}</span><span class="who">${t.channel === 'candidate' ? 'you' : esc(t.channel)}</span><span>${esc(t.text)}</span></div>`)
        .join('\n')
    : '<p class="empty">No speech was transcribed (the session was not started, or nothing was heard).</p>';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Interview Copilot report</title><style>${CSS}</style></head>
<body>
<h1>${esc(title || 'Interview report')}</h1>
<p class="meta">
  ${settings.name ? `<span>Profile: ${esc(settings.name)}</span>` : ''}
  <span>Session: ${esc(startedAt ? new Date(startedAt).toLocaleString() : '')} – ${esc(now.toLocaleString())}</span>
  <span>Questions: ${qa.length}</span>
  <span>AI: ${esc(provider)} · ${esc(settings.model)}</span>
  <span>Style: ${esc(style)}</span>
  <span>Language: ${esc(lang)}</span>
</p>
${qaHtml}
<h2>Full transcript</h2>
<p class="meta">Everything heard from both sides, in order — including talk that was never sent as a question.</p>
<div class="transcript">
${transcriptHtml}
</div>
</body></html>`;
}

/** e.g. Interview-2026-09-08-1432.pdf */
export function suggestedReportName(startedAt = Date.now()) {
  const d = new Date(startedAt);
  const p = (n) => String(n).padStart(2, '0');
  return `Interview-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}.pdf`;
}
