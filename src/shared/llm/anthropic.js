// Anthropic Messages API, streaming, called directly from the extension.
//
// Two things are specific to running in a browser context:
//   * `anthropic-dangerous-direct-browser-access` — without it CORS blocks the
//     request outright.
//   * the resume + job description go in a cached system block, because they
//     repeat verbatim on every question for the whole interview.

import { sseEvents, errorText } from './sse.js';

const ENDPOINT = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

// A user turn with screenshots / PDFs becomes a content array: the binary
// parts first, then the text. Everything else stays a plain string.
function toContent(m) {
  if (!m.attachments?.length) return m.content;
  return [
    ...m.attachments.map((a) =>
      a.kind === 'pdf'
        ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: a.data }, title: a.name }
        : { type: 'image', source: { type: 'base64', media_type: a.mime, data: a.data } }
    ),
    { type: 'text', text: m.content }
  ];
}

function buildBody({ settings, grounding, constraints, messages, withFallbacks }) {
  const body = {
    model: settings.model,
    // Headroom for a long, detailed answer plus thinking tokens (which count
    // toward this cap); the model still stops early for the terse styles.
    max_tokens: 4096,
    // Adaptive thinking is on by default on current models; low effort keeps
    // the first token fast, which matters more here than depth.
    output_config: { effort: 'low' },
    system: [
      { type: 'text', text: grounding, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: constraints }
    ],
    // The whole session so far (user/assistant pairs) plus the new question.
    messages: messages.map((m) => ({ role: m.role, content: toContent(m) })),
    stream: true
  };
  if (withFallbacks) body.fallbacks = 'default';
  return body;
}

export async function streamAnswer({ settings, grounding, constraints, messages, signal, onDelta }) {
  const request = (withFallbacks) => {
    const headers = {
      'content-type': 'application/json',
      'x-api-key': settings.anthropicKey,
      'anthropic-version': API_VERSION,
      'anthropic-dangerous-direct-browser-access': 'true'
    };
    if (withFallbacks) headers['anthropic-beta'] = FALLBACK_BETA;

    return fetch(ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify(buildBody({ settings, grounding, constraints, messages, withFallbacks })),
      signal
    });
  };

  // Server-side refusal fallbacks are on by default. If the account is not
  // enrolled in the beta the request 400s, so retry once plainly rather than
  // failing the answer.
  let response = await request(true);
  if (response.status === 400) {
    const detail = await errorText(response);
    if (/beta|fallback/i.test(detail)) {
      response = await request(false);
    } else {
      throw new Error(detail);
    }
  }

  if (!response.ok) throw new Error(await errorText(response));

  for await (const event of sseEvents(response, signal)) {
    if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
      onDelta(event.delta.text);
    } else if (event.type === 'message_delta' && event.delta?.stop_reason === 'refusal') {
      onDelta('\n\n[The model declined to answer this one.]');
    } else if (event.type === 'error') {
      throw new Error(event.error?.message || 'Anthropic stream error');
    }
  }
}
