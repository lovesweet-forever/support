// Attachments to a question: screenshots, images, PDFs and text files that
// travel with the question to the model (a coding problem on screen, an error,
// a diagram, a take-home task…). Pure helpers only — reading files is DOM work
// and lives in renderer/attach.js.
//
// Shape: { kind: 'image' | 'pdf' | 'text', name, mime, data?: base64, text?: string, preview?: dataURL }
// Text attachments are inlined into the user message; images and PDFs become
// provider-specific content parts (see llm/*.js).

export const LIMITS = {
  maxCount: 8,
  imageBytes: 10 * 1024 * 1024,
  pdfBytes: 20 * 1024 * 1024,
  textBytes: 500 * 1024,
  textChars: 60000,
  // Longest edge for images; anything larger is downscaled before sending
  // (the providers downscale anyway, and it keeps requests small).
  maxEdge: 2000
};

export const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

const TEXT_EXT =
  /\.(txt|text|md|markdown|rst|json|jsonl|csv|tsv|xml|ya?ml|toml|ini|cfg|conf|properties|log|sql|soql|graphql|gql|proto|js|mjs|cjs|jsx|ts|tsx|py|ipynb|java|kt|kts|cs|go|rs|rb|php|swift|scala|c|h|cc|cpp|hpp|m|mm|sh|bash|zsh|ps1|bat|cmd|html?|css|scss|less|vue|svelte|tf|dockerfile|env|gitignore|diff|patch)$/i;

/** 'image' | 'pdf' | 'text' | null (null = unsupported). */
export function kindOf(name, mime) {
  const type = String(mime || '').toLowerCase();
  const file = String(name || '');
  if (IMAGE_TYPES.has(type)) return 'image';
  if (type === 'application/pdf' || /\.pdf$/i.test(file)) return 'pdf';
  if (type.startsWith('text/') || TEXT_EXT.test(file)) return 'text';
  if (type === 'application/json' || type === 'application/xml' || type === 'application/javascript') return 'text';
  return null;
}

/** What is inlined in the message text vs. sent as binary parts. */
export function splitForRequest(attachments = []) {
  return {
    inline: attachments.filter((a) => a.kind === 'text'),
    parts: attachments.filter((a) => a.kind === 'image' || a.kind === 'pdf')
  };
}

/** "screenshot-1.png, task.pdf, notes.txt" */
export function describe(attachments = []) {
  return attachments.map((a) => a.name).join(', ');
}

/**
 * Keeps binary attachments only on the last `keep` user turns of a
 * conversation, so a long session does not resend every screenshot on every
 * question. Returns new message objects; text content is untouched.
 */
export function trimAttachments(messages, keep = 2) {
  let seen = 0;
  const out = [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'user' && m.attachments?.length) {
      seen++;
      out.unshift(seen <= keep ? m : { role: m.role, content: m.content });
    } else out.unshift(m);
  }
  return out;
}

export const DEFAULT_ATTACHMENT_QUESTION =
  'Answer what is shown in the attachment: the question, task, code or problem it contains.';
