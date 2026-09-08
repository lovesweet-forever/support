// One streaming interface over the three providers, plus request lifecycle and
// the interview's running conversation.
//
// The API itself is stateless, so "one session per interview" is built here:
// every question is sent together with the previous questions and answers of
// this session. That is what lets a follow-up like "give me the diagram"
// resolve against what was actually discussed a moment ago.

import { buildGrounding, buildConstraints, buildUserMessage } from '../prompt.js';
import { providerKey, firstAvailableProvider } from '../settings-util.js';
import { PROVIDERS } from '../constants.js';
import { splitForRequest, trimAttachments } from '../attachments.js';
import * as anthropic from './anthropic.js';
import * as openai from './openai.js';
import * as gemini from './gemini.js';

const IMPLEMENTATIONS = { anthropic, openai, gemini };

// Bounds on the remembered conversation. The oldest pairs fall off first.
export const MAX_TURN_MESSAGES = 20; // 10 question/answer pairs
export const MAX_TURN_CHARS = 40000; // roughly 10k tokens
// Screenshots / PDFs are only resent with the most recent user turns.
export const ATTACHMENT_TURNS = 2;

/**
 * Append one Q&A pair and enforce the bounds. Pure — returns a new array.
 * `question` is the user message text or `{ content, attachments }`.
 */
export function appendTurns(turns, question, answer, limits = {}) {
  const maxMessages = limits.maxMessages ?? MAX_TURN_MESSAGES;
  const maxChars = limits.maxChars ?? MAX_TURN_CHARS;
  const chars = (arr) => arr.reduce((n, m) => n + m.content.length, 0);
  const user = typeof question === 'string' ? { role: 'user', content: question } : { role: 'user', ...question };
  if (!user.attachments?.length) delete user.attachments;

  let next = [...turns, user, { role: 'assistant', content: answer }];
  // Always keep at least the pair just added; drop whole pairs from the front.
  while (next.length > 2 && (next.length > maxMessages || chars(next) > maxChars)) next = next.slice(2);
  return next;
}

export class AnswerEngine {
  /**
   * @param {object} opts
   * @param {() => object} opts.getSettings   current settings snapshot
   * @param {() => {channel: string, text: string}[]} opts.getHistory  what the candidate said since the last question
   * @param {(e: {type: string, question?: string, text?: string, error?: string}) => void} opts.emit
   */
  constructor({ getSettings, getHistory, emit }) {
    this.getSettings = getSettings;
    this.getHistory = getHistory;
    this.emit = emit;
    this.controller = null;
    /** The session's conversation so far: alternating user/assistant messages. */
    this.turns = [];
  }

  /** New interview: forget every previous question and answer. */
  reset() {
    this.cancel();
    this.turns = [];
  }

  /**
   * Continue an earlier session: replay its questions and answers as the
   * conversation so far. `saved` is [{ prompt, answer }] in order; turns that
   * never got an answer are skipped.
   */
  setTurns(saved) {
    this.cancel();
    let turns = [];
    for (const t of saved || []) {
      if (!t.answer) continue;
      turns = appendTurns(turns, { content: t.prompt || t.question || '' }, t.answer);
    }
    this.turns = turns;
  }

  /** A newer question always wins — a stale answer is worse than none. */
  cancel() {
    if (this.controller) {
      this.controller.abort();
      this.controller = null;
    }
  }

  /**
   * @param {string} question
   * @param {object[]} [attachments] screenshots / files sent with it (shared/attachments.js)
   * @param {{replaceLast?: boolean}} [opts] replaceLast: this is the latest question asked
   *   again (a retry); its previous answer is dropped from the session memory first, so the
   *   model does not see the same question twice.
   */
  async answer(question, attachments = [], { replaceLast = false } = {}) {
    let settings = this.getSettings();
    if (replaceLast && this.turns.length >= 2) this.turns = this.turns.slice(0, -2);

    // Safety net: if the selected provider has no key but another one does,
    // answer with that one rather than failing. The worker normally persists
    // this same fallback for the UI, but the engine must never say "no key"
    // while a working key exists — that leaves the candidate with nothing.
    if (!providerKey(settings)) {
      const fallback = firstAvailableProvider(settings);
      if (fallback) {
        settings = { ...settings, provider: fallback, model: PROVIDERS[fallback].defaultModel };
      }
    }

    const impl = IMPLEMENTATIONS[settings.provider];
    if (!impl) {
      this.emit({ type: 'error', error: `Unknown provider: ${settings.provider}` });
      return;
    }
    if (!providerKey(settings)) {
      this.emit({
        type: 'error',
        error: 'No API key set for any provider. Add one to config/keys.json or the options page.'
      });
      return;
    }

    this.cancel();
    const controller = new AbortController();
    this.controller = controller;

    // Build the request *before* announcing the start: the offscreen document
    // advances its "since the last question" mark on 'start', and we want the
    // candidate's words from before this question, not after it.
    // Text attachments are inlined in the message; images and PDFs ride along
    // as `attachments` for the provider module to turn into content parts.
    const userTurn = {
      role: 'user',
      content: buildUserMessage(this.getHistory(), question, attachments),
      attachments: splitForRequest(attachments).parts
    };
    const messages = trimAttachments([...this.turns, userTurn], ATTACHMENT_TURNS);

    // `prompt` is the exact message sent, so the session store can replay it later.
    this.emit({ type: 'start', question, attachments, prompt: userTurn.content });

    let full = '';
    try {
      await impl.streamAnswer({
        settings,
        grounding: buildGrounding(settings),
        constraints: buildConstraints(settings),
        messages,
        signal: controller.signal,
        onDelta: (text) => {
          // Deltas from a superseded request must not paint over the new answer.
          if (controller.signal.aborted) return;
          full += text;
          this.emit({ type: 'delta', text });
        }
      });
      if (!controller.signal.aborted) {
        // Only a completed answer joins the session memory; an aborted one
        // would leave the model believing it said something it never finished.
        this.turns = appendTurns(this.turns, { content: userTurn.content, attachments: userTurn.attachments }, full);
        this.emit({ type: 'done' });
      }
    } catch (err) {
      if (err.name === 'AbortError') return; // superseded on purpose
      this.emit({ type: 'error', error: err.message });
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }
}
