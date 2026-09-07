// Google Gemini (Generative Language API), streaming.
//
// Gemini streams SSE only when `alt=sse` is set; without it the endpoint
// returns one big JSON array at the end, which defeats the point.

import { sseEvents, errorText } from './sse.js';

const BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

export async function streamAnswer({ settings, grounding, constraints, messages, signal, onDelta }) {
  const url = `${BASE}/${encodeURIComponent(settings.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(
    settings.geminiKey
  )}`;

  const body = {
    systemInstruction: { parts: [{ text: `${grounding}\n\n${constraints}` }] },
    // Gemini calls the assistant role "model"; otherwise the same session turns.
    // Screenshots / PDFs on a user turn go along as inlineData parts.
    contents: messages.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [
        { text: m.content },
        ...(m.attachments || []).map((a) => ({ inlineData: { mimeType: a.mime, data: a.data } }))
      ]
    })),
    // Gemini 3 models think before answering and that reasoning draws on the
    // output budget, so keep this generous or the visible answer comes back
    // truncated. The answer-style instruction is what actually bounds length.
    generationConfig: { maxOutputTokens: 4096, temperature: 0.4 }
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal
  });

  if (!response.ok) throw new Error(await errorText(response));

  for await (const event of sseEvents(response, signal)) {
    const parts = event.candidates?.[0]?.content?.parts;
    if (!parts) continue;
    for (const part of parts) if (part.text) onDelta(part.text);
  }
}
