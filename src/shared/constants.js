// Shared constants — framework-independent, identical in spirit to the browser
// extension's registry so the same logic drives both.

export const LANGUAGES = [
  { code: 'en', label: 'English', deepgram: 'en', answerName: 'English' },
  { code: 'ro', label: 'Romanian', deepgram: 'ro', answerName: 'Romanian' },
  { code: 'pt-BR', label: 'Portuguese (Brazil)', deepgram: 'pt-BR', answerName: 'Brazilian Portuguese' }
];

export const DEFAULT_LANGUAGE = 'en';

// Colour themes. The id is the <html data-theme> value; the CSS for each lives
// in renderer/themes.css. `swatch` / `accent` are only for the picker preview.
export const THEMES = [
  { id: 'dark', label: 'Dark', swatch: '#10131a', accent: '#60a5fa' },
  { id: 'light', label: 'Light', swatch: '#f4f6fa', accent: '#2563eb' },
  { id: 'ocean', label: 'Ocean', swatch: '#081628', accent: '#22d3ee' },
  { id: 'forest', label: 'Forest', swatch: '#0b1a14', accent: '#4ade80' },
  { id: 'sunset', label: 'Sunset', swatch: '#221210', accent: '#fb923c' },
  { id: 'violet', label: 'Violet', swatch: '#181026', accent: '#a78bfa' }
];

export const DEFAULT_THEME = 'dark';

export function themeById(id) {
  return THEMES.find((t) => t.id === id) || THEMES[0];
}

/** Sets the theme on the document root; unknown ids fall back to the default. */
export function applyTheme(id, doc = document) {
  doc.documentElement.dataset.theme = themeById(id).id;
}

export function languageByCode(code) {
  return LANGUAGES.find((l) => l.code === code) || LANGUAGES[0];
}

export const PROVIDERS = {
  anthropic: {
    label: 'Anthropic Claude',
    keyLabel: 'Anthropic API key',
    keyHint: 'Starts with sk-ant-',
    defaultModel: 'claude-sonnet-5',
    models: [
      { id: 'claude-sonnet-5', label: 'Claude Sonnet 5 (recommended — fast + smart)' },
      { id: 'claude-opus-5', label: 'Claude Opus 5 (top quality, slower)' },
      { id: 'claude-fable-5-1', label: 'Claude Fable 5.1 (most capable, slowest)' },
      { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 (fastest)' }
    ]
  },
  openai: {
    label: 'OpenAI GPT',
    keyLabel: 'OpenAI API key',
    keyHint: 'Starts with sk-',
    defaultModel: 'gpt-5.6-terra',
    models: [
      { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra (recommended — balanced)' },
      { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol (flagship)' },
      { id: 'gpt-6-astra', label: 'GPT-6 Astra (most capable, slowest)' },
      { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna (fastest, cheapest)' }
    ]
  },
  gemini: {
    label: 'Google Gemini',
    keyLabel: 'Gemini API key',
    keyHint: 'From aistudio.google.com',
    defaultModel: 'gemini-3.8-flash',
    models: [
      { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash (recommended)' },
      { id: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro (most capable, slower)' },
      { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite (fastest, cheapest)' }
    ]
  }
};

export const ANSWER_STYLES = {
  bullets: {
    label: 'Concise bullets',
    instruction:
      'Reply with 4-6 tight bullet points — the kind a strong senior engineer would actually make, not ' +
      'vague one-liners. Lead each bullet with the key claim, then a concrete detail that carries weight: ' +
      'the architectural or design decision and the trade-off behind it, the scale or scope involved, the ' +
      'measurable outcome with real numbers, or the ownership and leadership angle (driving direction, ' +
      'mentoring, cross-team influence). Pitch the depth to the seniority the resume and job description ' +
      'imply — for a senior or staff role, show system-level thinking and judgement, never filler. Keep ' +
      'each bullet to one or two lines so it can be glanced at and spoken from, ground every point in the ' +
      'resume, and give no preamble or closing summary.'
  },
  detailed: {
    label: 'Detailed (natural)',
    instruction:
      'Give a rich, thorough spoken answer — the kind a strong candidate gives when they really open up. ' +
      'Aim for about 90-150 seconds of speech (roughly 220-350 words); a short, thin answer is a failure ' +
      'for this style, so err on the side of more substance. Answer in the first person, natural and ' +
      'conversational, in flowing sentences — never bullet points, headers, or labelled sections, and ' +
      'never the words Situation / Task / Action / Result. Open with a genuine, direct take on the ' +
      'question, then go deep on a specific example from the resume: set the context, walk through what ' +
      'you actually did and the reasoning and trade-offs behind your decisions, and land on the concrete ' +
      'outcome with numbers wherever the resume supports them. Bring in a second example or a broader ' +
      'reflection when it strengthens the answer. Think out loud a little so it sounds considered rather ' +
      'than rehearsed, weave specifics (technologies, scale, results) in the way a person naturally would ' +
      'rather than as a list, and close on a natural, forward-looking note.'
  },
  keywords: {
    label: 'Keyword cues',
    instruction:
      'Reply with a scannable list of 8-12 keyword-led talking points that a strong senior engineer ' +
      'would raise. Start each line with the key term or phrase (a few words), then a dash and a short, ' +
      'concrete cue of what to actually say about it — a specific from the resume, a number, a decision ' +
      'or trade-off, an outcome. This is a memory-jogger the candidate speaks from, so keep each point to ' +
      'a single line, but make every point substantive and grounded in the resume, and give plenty of ' +
      'them so there is always more than enough to talk about. No preamble, no closing summary.'
  }
};

export const CHANNEL = {
  INTERVIEWER: 'interviewer',
  CANDIDATE: 'candidate'
};

export const MODE = {
  DEEPGRAM: 'deepgram'
};
