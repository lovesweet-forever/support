// OpenAI Chat Completions, streaming.

import { sseEvents, errorText } from './sse.js';

const ENDPOINT = 'https://api.openai.com/v1/chat/completions';

// A user turn with screenshots / PDFs becomes a content array (text first,
// then image_url / file parts as data URLs). Everything else stays a string.
function toContent(m) {
  if (!m.attachments?.length) return m.content;
  return [
    { type: 'text', text: m.content },
    ...m.attachments.map((a) =>
      a.kind === 'pdf'
        ? { type: 'file', file: { filename: a.name, file_data: `data:application/pdf;base64,${a.data}` } }
        : { type: 'image_url', image_url: { url: `data:${a.mime};base64,${a.data}` } }
    )
  ];
}

export async function streamAnswer({ settings, grounding, constraints, messages, signal, onDelta }) {
  // GPT-5 and GPT-6 are reasoning models: they rename the output cap, reject a
  // custom temperature, and — crucially — spend part of that cap on hidden
  // reasoning tokens. A small cap therefore starves the *visible* answer, which
  // is the usual cause of a modern model returning something very short. So we
  // give reasoning models a big budget and ask for low reasoning effort, which
  // keeps latency down and leaves plenty of room for the answer itself.
  const isReasoning = /^(gpt-[56]|o\d)/.test(settings.model);

  const body = {
    model: settings.model,
    // System context, then the whole session so far, ending with the new question.
    messages: [
      { role: 'system', content: `${grounding}\n\n${constraints}` },
      ...messages.map((m) => ({ role: m.role, content: toContent(m) }))
    ],
    stream: true,
    ...(isReasoning
      ? { max_completion_tokens: 5120, reasoning_effort: 'low' }
      : { max_tokens: 3072, temperature: 0.5 })
  };

  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${settings.openaiKey}`
    },
    body: JSON.stringify(body),
    signal
  });

  if (!response.ok) throw new Error(await errorText(response));

  for await (const event of sseEvents(response, signal)) {
    const delta = event.choices?.[0]?.delta?.content;
    if (delta) onDelta(delta);
  }
}
