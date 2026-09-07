// Pure settings helpers shared by the renderer and the answer engine.

export const DEFAULT_SETTINGS = {
  // Pre-meeting inputs
  resume: '',
  jobDescription: '',
  customPrompt:
    'Answer in my voice — first person, confident but genuine and down to earth, the way I would actually speak. Only use experience that appears in my resume.',
  answerStyle: 'detailed',
  language: 'en',

  // Providers
  provider: 'anthropic',
  model: 'claude-sonnet-5',
  anthropicKey: '',
  openaiKey: '',
  geminiKey: '',
  deepgramKey: '',

  // Capture / UI
  transcribeCandidate: true,
  autoAnswer: false,
  answerFontSize: 15,
  theme: 'dark',
  // UI font id (see shared/constants.js FONTS) and an optional installed font name
  font: 'system',
  fontCustom: '',

  // Window (persisted geometry lives in the main process store)
  panelOpacity: 0.96
};

export function providerKey(settings) {
  return {
    anthropic: settings.anthropicKey,
    openai: settings.openaiKey,
    gemini: settings.geminiKey
  }[settings.provider];
}

export function providerAvailability(settings) {
  return {
    anthropic: Boolean(settings.anthropicKey),
    openai: Boolean(settings.openaiKey),
    gemini: Boolean(settings.geminiKey)
  };
}

export function firstAvailableProvider(settings) {
  const avail = providerAvailability(settings);
  return ['anthropic', 'openai', 'gemini'].find((id) => avail[id]) || null;
}
