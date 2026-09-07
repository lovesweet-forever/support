// Builds the prompt from the pre-meeting inputs.
//
// Split into two parts on purpose. `grounding` (custom prompt + resume + JD) is
// byte-identical for the whole meeting, so Anthropic can cache it. `constraints`
// holds the language and style, which the user can change mid-call — keeping it
// after the cache breakpoint means switching language costs nothing.

import { ANSWER_STYLES, languageByCode } from './constants.js';
import { splitForRequest, describe } from './attachments.js';

const MAX_HISTORY_TURNS = 6;

export function buildGrounding(settings) {
  const parts = [];

  // Fixed framing first, then the user's own instructions, then the documents.
  // All three are stable for the whole meeting, so this whole block is cacheable.
  parts.push(
    'You are helping a candidate during a live job interview. You are given the candidate\'s resume, ' +
      'the job description, and the custom instructions below; then, one at a time, the questions the ' +
      'interviewer asks. Answer each question as the candidate, in the first person, the way a real ' +
      'person genuinely speaks in an interview — natural and conversational, never robotic or templated.'
  );

  if (settings.customPrompt.trim()) {
    // Labelled and given precedence so it visibly shapes every answer.
    parts.push(
      'The candidate gave you these custom instructions — follow them closely, they take precedence ' +
        'over the general guidance above where they differ:\n' +
        `<custom_instructions>\n${settings.customPrompt.trim()}\n</custom_instructions>`
    );
  }

  if (settings.resume.trim()) {
    parts.push(`<resume>\n${settings.resume.trim()}\n</resume>`);
  }
  if (settings.jobDescription.trim()) {
    parts.push(`<job_description>\n${settings.jobDescription.trim()}\n</job_description>`);
  }

  return parts.join('\n\n');
}

export function buildConstraints(settings) {
  const language = languageByCode(settings.language);
  const style = ANSWER_STYLES[settings.answerStyle] || ANSWER_STYLES.bullets;

  return [
    `Write the answer in ${language.answerName}, regardless of the language of this instruction.`,
    style.instruction,
    // The overriding principle across every style: too little is the real
    // failure. The candidate reads the answer live and silently drops whatever
    // they do not need, but they cannot invent what was never given.
    'Within the chosen format, always err on the side of more substance and more specifics rather than ' +
      'less. Giving the candidate more than they will use is good — they can quietly skip anything ' +
      'unneeded — whereas a thin answer that leaves them with nothing to say is the worst outcome. Never ' +
      'trim an answer for the sake of brevity; make sure there is always plenty to speak from.',
    'Mark the things the candidate must actually say — key technologies, numbers, decisions, named ' +
      'outcomes — by wrapping each in double asterisks, like **Platform Events** or **35% faster**. ' +
      'Aim for 3-8 such highlights per answer and keep each to a word or short phrase, never a sentence.',
    'Code is a separate case. Put any code, query, formula or configuration (SOQL, SQL, Apex, ' +
      'JavaScript, JSON, YAML…) in a fenced code block on its own lines — ```soql on the opening line, ' +
      '``` on the closing line — formatted exactly as it should be typed, with proper line breaks and ' +
      'indentation, one clause or statement per line, and valid syntax the candidate can copy as-is. ' +
      'Never inline a whole query into a sentence. Wrap short identifiers, field names, methods or ' +
      'keywords mentioned in prose in single backticks, like `OwnerId` or `HAVING`. Apart from the ' +
      'double-asterisk highlights, backticks and code fences, use no other markdown.',
    'For any technical or coding question, never answer with code alone. Structure it as: (1) the ' +
      'approach in spoken prose — what you would do and why, 3-6 sentences covering the key decision, ' +
      'trade-offs, limits or edge cases; (2) the code block; (3) a short walk-through of the important ' +
      'lines, so the candidate can narrate the code while it is on screen.',
    'Ground every claim in the resume. If the resume does not support an answer, say what the ' +
      'candidate can honestly offer instead — never invent employers, titles, dates or metrics.',
    'The transcript may contain speech-recognition errors. Infer the intended question and answer ' +
      'it; do not comment on the transcription.',
    'A question may come with attachments — a screenshot of the shared screen, an image, a PDF or a ' +
      'text/code file. They are part of the question: read whatever they show (a coding problem, a ' +
      'task description, code, an error, a diagram, a table) and answer that. For a coding problem, ' +
      'give the full working solution; for a bug, the fix; for a diagram or document, the explanation ' +
      'the interviewer is after. Do not describe the attachment itself unless asked.',
    'Output only the answer. No preamble, no "Great question", no meta-commentary.'
  ].join('\n');
}

/**
 * The user turn for one question. Previous questions and answers travel as
 * real conversation turns (see llm/index.js), so this only adds what the
 * conversation cannot know: what the candidate actually said out loud since
 * the last question — useful for "can you expand on what you just said?".
 *
 * Text attachments are inlined here; images and PDFs are sent as content parts
 * next to this text by each provider module.
 *
 * @param {{channel: string, text: string}[]} history utterances since the last question
 * @param {string} question the question being sent
 * @param {object[]} [attachments] see shared/attachments.js
 */
export function buildUserMessage(history, question, attachments = []) {
  const spoken = history.filter((t) => t.channel === 'candidate').slice(-MAX_HISTORY_TURNS);
  const lines = [];

  if (spoken.length) {
    lines.push('<what_i_said_since_the_last_question>');
    for (const turn of spoken) lines.push(turn.text);
    lines.push('</what_i_said_since_the_last_question>', '');
  }

  if (attachments.length) {
    const { inline } = splitForRequest(attachments);
    lines.push(
      `Attached to this question (${attachments.length}): ${describe(attachments)}. ` +
        'Treat them as part of the question.',
      ''
    );
    for (const a of inline) lines.push(`<attachment name="${a.name.replace(/"/g, '')}">`, a.text, '</attachment>', '');
  }

  lines.push('The interviewer just asked:', '', question, '', 'Answer it now.');
  return lines.join('\n');
}
