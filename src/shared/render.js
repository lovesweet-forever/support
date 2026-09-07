// Framework-independent renderers and geometry math, lifted verbatim from the
// browser extension (they were already pure and unit-tested there). Building
// DOM nodes — never innerHTML — is what keeps model output from injecting
// markup; the only elements ever produced are <strong>, <code>, <pre>, <span>.

export const MIN_W = 260;
export const MIN_H = 180;
export const CODE_MIN_W = 140;

/**
 * Render answer text. Three markers, all built from DOM nodes:
 *   ```lang … ```   fenced code block  -> <pre class="code"> with a language tag
 *   `x`             inline code        -> <code class="inline">
 *   **x**           must-say keyword   -> <strong>
 * Unclosed markers while streaming just style to the end and self-correct when
 * the close arrives. Fences are handled first so code is never re-interpreted.
 */
export function renderRich(el, text) {
  el.textContent = '';
  const chunks = String(text || '').split('```');
  chunks.forEach((chunk, i) => {
    if (i % 2 === 1) renderCodeBlock(el, chunk);
    else if (chunk) renderProse(el, chunk);
  });
}

/** Only the fenced code blocks from `text`, for the code panel. */
export function renderCodeOnly(el, text) {
  el.textContent = '';
  const chunks = String(text || '').split('```');
  chunks.forEach((chunk, i) => {
    if (i % 2 === 1) renderCodeBlock(el, chunk);
  });
}

function renderCodeBlock(el, chunk) {
  let body = chunk;
  let lang = '';
  const tag = /^[ \t]*([A-Za-z0-9+#.-]{1,24})[ \t]*\r?\n/.exec(chunk);
  if (tag) {
    lang = tag[1];
    body = chunk.slice(tag[0].length);
  }
  body = body.replace(/^\r?\n/, '').replace(/\r?\n[ \t]*$/, '');

  const pre = document.createElement('pre');
  pre.className = 'code';
  if (lang) {
    const label = document.createElement('span');
    label.className = 'lang';
    label.textContent = lang;
    pre.append(label);
  }
  const code = document.createElement('code');
  code.textContent = body;
  pre.append(code);
  el.append(pre);
}

function renderProse(el, text) {
  const parts = text.split('`');
  parts.forEach((part, i) => {
    if (!part) return;
    if (i % 2 === 1) {
      const c = document.createElement('code');
      c.className = 'inline';
      c.textContent = part;
      el.append(c);
    } else {
      renderBold(el, part);
    }
  });
}

function renderBold(el, text) {
  const parts = text.split('**');
  parts.forEach((part, i) => {
    if (!part) return;
    if (i % 2 === 1) {
      const b = document.createElement('strong');
      b.textContent = part;
      el.append(b);
    } else {
      el.append(document.createTextNode(part));
    }
  });
}

/** Resize one edge/corner; opposite edge stays put, minimums hold, on-screen. */
export function resizeRect(edge, start, dx, dy, vw, vh, minW = MIN_W, minH = MIN_H) {
  let { left, top, width, height } = start;

  if (edge.includes('e')) width = start.width + dx;
  if (edge.includes('s')) height = start.height + dy;
  if (edge.includes('w')) {
    width = start.width - dx;
    left = start.left + dx;
  }
  if (edge.includes('n')) {
    height = start.height - dy;
    top = start.top + dy;
  }
  if (width < minW) {
    if (edge.includes('w')) left = start.left + start.width - minW;
    width = minW;
  }
  if (height < minH) {
    if (edge.includes('n')) top = start.top + start.height - minH;
    height = minH;
  }
  left = Math.max(0, left);
  top = Math.max(0, top);
  width = Math.min(width, vw - left);
  height = Math.min(height, vh - top);
  return { left, top, width, height };
}

/** Split math for the docked code panel: 'seam' keeps combined width, 'right'
 *  widens only the code panel. */
export function codeResize(mode, start, dx, vw, minMain = MIN_W, minCode = CODE_MIN_W) {
  let mainW = start.mainW;
  let codeW = start.codeW;
  if (mode === 'seam') {
    const combined = start.mainW + start.codeW;
    const maxMain = Math.max(minMain, combined - minCode);
    mainW = Math.min(Math.max(start.mainW + dx, minMain), maxMain);
    codeW = combined - mainW;
  } else {
    const maxCode = Math.max(minCode, vw - (start.mainLeft + start.mainW));
    codeW = Math.min(Math.max(start.codeW + dx, minCode), maxCode);
  }
  return { mainW, codeW };
}
