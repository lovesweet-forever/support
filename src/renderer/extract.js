// Text out of a file picked in Setup: PDFs through pdf.js (bundled with the
// app, no network), text / Markdown files as they are. Used for the "Earlier
// rounds" notes, so a report PDF this app saved — or any interview notes —
// can be fed back to the AI for the next round.

const PDFJS = new URL('../../node_modules/pdfjs-dist/build/pdf.mjs', import.meta.url).href;
const PDFJS_WORKER = new URL('../../node_modules/pdfjs-dist/build/pdf.worker.mjs', import.meta.url).href;

let pdfjsPromise = null;
function pdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(PDFJS).then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
      return lib;
    });
  }
  return pdfjsPromise;
}

/** Text of a PDF, page by page, with the reading order pdf.js gives. */
export async function pdfToText(arrayBuffer) {
  const lib = await pdfjs();
  const doc = await lib.getDocument({ data: new Uint8Array(arrayBuffer) }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    // Items carry an EOL hint; join with spaces otherwise so words do not fuse.
    let line = '';
    const lines = [];
    for (const item of content.items) {
      if (!('str' in item)) continue;
      line += item.str;
      if (item.hasEOL) { lines.push(line.trimEnd()); line = ''; } else if (item.str && !/\s$/.test(item.str)) line += ' ';
    }
    if (line.trim()) lines.push(line.trimEnd());
    pages.push(lines.join('\n').replace(/[ \t]+\n/g, '\n').trim());
  }
  await doc.destroy();
  return pages.filter(Boolean).join('\n\n');
}

/** @param {File} file  PDF, or a text / Markdown file */
export async function extractText(file) {
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  if (isPdf) return pdfToText(await file.arrayBuffer());
  const text = await file.text();
  if (/\0/.test(text.slice(0, 4096))) throw new Error('not a text file');
  return text;
}
