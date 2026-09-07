// Decides when the interviewer has finished asking something worth answering.
//
// Cheap and local on purpose — an extra LLM round-trip just to classify would
// add latency to the one thing that has to be fast.
//
// The buffer holds only what was said *since the last answer fired*, and it is
// bounded three ways (age, count, length) so a long stretch of interviewer
// talk can never turn into a wall of text sent to the model.

const MAX_AGE_MS = 20_000; // anything older than this is not part of the question
const MAX_UTTERANCES = 4;
const MAX_CHARS = 600;
const CONTEXT_KEEP = 1; // non-question utterances kept as lead-in for the next one

const OPENERS = {
  en: [
    'what', 'why', 'how', 'when', 'where', 'which', 'who', 'can you', 'could you',
    'would you', 'do you', 'did you', 'have you', 'are you', 'is there', 'tell me',
    'walk me through', 'describe', 'explain', 'give me an example', 'talk about',
    'share an example', "let's talk about", 'suppose', 'imagine'
  ],
  ro: [
    'ce', 'cum', 'de ce', 'când', 'cand', 'unde', 'care', 'cine', 'poți', 'poti',
    'ai putea', 'ai', 'ești', 'esti', 'spune-mi', 'povestește-mi', 'povesteste-mi',
    'descrie', 'explică', 'explica', 'dă-mi un exemplu', 'da-mi un exemplu',
    'vorbește despre', 'vorbeste despre'
  ],
  'pt-BR': [
    'o que', 'que', 'por que', 'porque', 'como', 'quando', 'onde', 'qual', 'quais',
    'quem', 'você pode', 'voce pode', 'poderia', 'você', 'voce', 'me fale',
    'fale sobre', 'me conta', 'conte', 'descreva', 'explique', 'me dê um exemplo',
    'me de um exemplo', 'comenta sobre'
  ]
};

/** Cheap heuristic: does this utterance read like a question or a prompt? */
export function looksLikeQuestion(text, language = 'en') {
  const t = text.trim().toLowerCase();
  if (!t) return false;
  if (t.includes('?')) return true;
  // Very short fragments are usually backchannel ("mm-hm", "right", "okay").
  if (t.split(/\s+/).length < 3) return false;

  const openers = OPENERS[language] || OPENERS.en;
  return openers.some((o) => t.startsWith(o) || t.includes(` ${o} `));
}

const normalize = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

export class QuestionDetector {
  /**
   * @param {object} opts
   * @param {(question: string) => void} opts.onQuestion
   * @param {number} [opts.silenceMs] quiet period that marks the end of a question
   */
  constructor({ onQuestion, silenceMs = 900 }) {
    this.onQuestion = onQuestion;
    this.silenceMs = silenceMs;
    this.language = 'en';
    this.enabled = true;
    this.buffer = []; // { text, at }
    this.timer = null;
    this.lastFired = '';
  }

  setLanguage(language) {
    this.language = language;
  }

  setEnabled(enabled) {
    this.enabled = enabled;
    if (!enabled) this.clearTimer();
  }

  /** Feed a *final* interviewer utterance. */
  push(text) {
    const clean = text.trim();
    if (!clean) return;
    this.buffer.push({ text: clean, at: Date.now() });
    this.prune();
    this.clearTimer();
    if (!this.enabled) return;
    this.timer = setTimeout(() => this.evaluate(), this.silenceMs);
  }

  /** Enforce the three bounds. Newest utterances always survive. */
  prune() {
    const cutoff = Date.now() - MAX_AGE_MS;
    this.buffer = this.buffer.filter((u) => u.at >= cutoff).slice(-MAX_UTTERANCES);
    let chars = this.buffer.reduce((n, u) => n + u.text.length + 1, 0);
    while (this.buffer.length > 1 && chars > MAX_CHARS) {
      chars -= this.buffer.shift().text.length + 1;
    }
  }

  text() {
    return this.buffer.map((u) => u.text).join(' ').trim();
  }

  evaluate() {
    this.timer = null;
    this.prune();
    const question = this.text();
    if (!question) return;

    if (looksLikeQuestion(question, this.language)) {
      this.fire(question);
    } else {
      // Statements only. Keep a short lead-in for whatever comes next and
      // drop the rest, so it never accumulates into the next question.
      this.buffer = this.buffer.slice(-CONTEXT_KEEP);
    }
  }

  /** Manual override — always answers, question-shaped or not. */
  forceNow() {
    this.prune();
    const question = this.text();
    if (question) this.fire(question);
  }

  fire(question) {
    // Same words as last time (punctuation aside) means the source re-sent
    // an utterance we already answered — ignore it.
    if (normalize(question) === normalize(this.lastFired)) {
      this.buffer = [];
      return;
    }
    this.lastFired = question;
    this.buffer = []; // everything up to here is now "answered"
    this.clearTimer();
    this.onQuestion(question);
  }

  clearTimer() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  reset() {
    this.buffer = [];
    this.lastFired = '';
    this.clearTimer();
  }
}
