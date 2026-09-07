// Turns files (picked, dropped or pasted) and screen captures into attachment
// objects the answer engine can send. Images are downscaled to LIMITS.maxEdge
// on the longest side; text files are read as UTF-8 and truncated.

import { LIMITS, kindOf } from '../shared/attachments.js';

const api = window.copilot;
let screenshotCount = 0;

const readDataUrl = (file) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error(`could not read ${file.name}`));
    r.readAsDataURL(file);
  });

const loadImage = (src) =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('not a readable image'));
    img.src = src;
  });

const base64Of = (dataUrl) => dataUrl.slice(dataUrl.indexOf(',') + 1);

async function imageAttachment(file) {
  if (file.size > LIMITS.imageBytes) throw new Error(`${file.name} is over ${LIMITS.imageBytes / 1024 / 1024} MB`);
  let dataUrl = await readDataUrl(file);
  let mime = file.type;
  const img = await loadImage(dataUrl);
  const longest = Math.max(img.naturalWidth, img.naturalHeight);
  // GIFs keep their frames; everything else is redrawn when too large.
  if (longest > LIMITS.maxEdge && mime !== 'image/gif') {
    const scale = LIMITS.maxEdge / longest;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    mime = mime === 'image/jpeg' ? 'image/jpeg' : 'image/png';
    dataUrl = canvas.toDataURL(mime, 0.92);
  }
  return { kind: 'image', name: file.name || 'image.png', mime, data: base64Of(dataUrl), preview: dataUrl };
}

async function pdfAttachment(file) {
  if (file.size > LIMITS.pdfBytes) throw new Error(`${file.name} is over ${LIMITS.pdfBytes / 1024 / 1024} MB`);
  const dataUrl = await readDataUrl(file);
  return { kind: 'pdf', name: file.name, mime: 'application/pdf', data: base64Of(dataUrl) };
}

async function textAttachment(file) {
  if (file.size > LIMITS.textBytes) throw new Error(`${file.name} is over ${LIMITS.textBytes / 1024} KB`);
  let text = await file.text();
  if (/\0/.test(text.slice(0, 8192))) throw new Error(`${file.name} is not a text file`);
  if (text.length > LIMITS.textChars) text = `${text.slice(0, LIMITS.textChars)}\n…[truncated]`;
  return { kind: 'text', name: file.name, mime: 'text/plain', text };
}

/** One File -> attachment. Throws with a short reason when the file is unusable. */
export async function fileToAttachment(file) {
  const kind = kindOf(file.name, file.type);
  if (kind === 'image') return imageAttachment(file);
  if (kind === 'pdf') return pdfAttachment(file);
  if (kind === 'text') return textAttachment(file);
  throw new Error(`${file.name || 'file'}: unsupported type (use images, PDF or text/code files)`);
}

/** Pasted images arrive with generic names; give them a useful one. */
export function namePasted(file, index = 0) {
  if (file.name && file.name !== 'image.png' && file.name !== 'blob') return file;
  const ext = (file.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
  return new File([file], `pasted-${Date.now()}${index ? `-${index}` : ''}.${ext}`, { type: file.type });
}

/** Grab the screen the panel is on (the panel itself is excluded from capture). */
export async function captureScreen() {
  let shot;
  try {
    shot = await api.captureScreen();
  } catch (err) {
    // Electron prefixes IPC errors with the method name; keep only the reason.
    throw new Error(String(err.message || err).replace(/^.*?:\s*Error:\s*/, ''));
  }
  screenshotCount++;
  return {
    kind: 'image',
    name: `screenshot-${screenshotCount}.png`,
    mime: shot.mime,
    data: shot.data,
    preview: `data:${shot.mime};base64,${shot.data}`
  };
}
