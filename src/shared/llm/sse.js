// Minimal SSE reader shared by the three providers.
//
// All of them stream `data: <json>` lines; only the payload shape differs.

export async function* sseEvents(response, signal) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Events are separated by a blank line; a chunk may split one in half.
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);

        for (const line of raw.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (!data || data === '[DONE]') continue;
          try {
            yield JSON.parse(data);
          } catch {
            // Ignore keepalive comments and any non-JSON payload.
          }
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

/** Reads an error body without throwing, for a useful message in the overlay. */
export async function errorText(response) {
  try {
    const body = await response.text();
    try {
      const json = JSON.parse(body);
      return json.error?.message || json.message || body.slice(0, 300);
    } catch {
      return body.slice(0, 300);
    }
  } catch {
    return `HTTP ${response.status}`;
  }
}
