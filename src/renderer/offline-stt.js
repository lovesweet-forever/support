// Offline speech-to-text for one audio channel: the same shape as
// shared/deepgram.js's DeepgramChannel (connect / send / cut / flush /
// setLanguage / close, results through onUtterance), but the audio goes to the
// main process, which runs a downloaded sherpa-onnx model (main/stt). Nothing
// leaves the machine.

const api = window.copilot;

export class OfflineSttChannel {
  /**
   * @param {object} opts
   * @param {string} opts.id  'interviewer' | 'candidate'
   * @param {string} opts.language
   * @param {(u: {text: string, isFinal: boolean, stale?: boolean}) => void} opts.onUtterance
   * @param {(state: string, detail?: string) => void} [opts.onState]
   */
  constructor({ id, language, onUtterance, onState = () => {} }) {
    this.id = id;
    this.language = language;
    this.onUtterance = onUtterance;
    this.onState = onState;
    this.open = false;
    this.closed = false;
    this.queue = []; // audio while the model loads
    this.offResult = api.stt.onResult((r) => {
      if (r.type === 'error') { this.onState('error', r.message); return; }
      if (r.id !== undefined && !String(r.id).endsWith(`:${this.id}`)) return;
      this.onUtterance({ text: r.text, isFinal: r.isFinal, stale: r.stale });
    });
  }

  connect() {
    this.onState('reconnecting', 'loading the transcription model');
    api.stt.open(this.id).then(() => {
      if (this.closed) return;
      this.open = true;
      for (const chunk of this.queue) api.stt.audio(this.id, chunk);
      this.queue = [];
      this.onState('connected');
    }, (err) => {
      this.onState('error', String(err?.message || err).replace(/^.*?Error: /, ''));
    });
  }

  send(pcmChunk) {
    const bytes = new Uint8Array(pcmChunk);
    if (this.open) api.stt.audio(this.id, bytes);
    else if (this.queue.length < 300) this.queue.push(bytes); // 30 s
  }

  /** See DeepgramChannel.cut: 'now' after a manual Send, 'heard' for an automatic answer. */
  cut(until = 'now') { api.stt.cut(this.id, until); }

  flush() { if (this.open) api.stt.flush(this.id); }

  setLanguage(language) {
    if (language === this.language) return;
    this.language = language;
    api.stt.setLanguage(language).catch(() => {});
  }

  close() {
    this.flush();
    this.closed = true;
    this.offResult();
    api.stt.close(this.id).catch(() => {});
  }
}
