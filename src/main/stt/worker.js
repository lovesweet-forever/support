// Offline speech-to-text worker (an Electron utility process, see ./index.js).
// Loads one sherpa-onnx model and transcribes any number of audio sessions
// (the interviewer, the candidate) with it.
//
// The models are non-streaming, so a Silero VAD splits each session's audio
// into utterances: when the speaker pauses, the utterance is decoded and sent
// as a final result. While they are still talking, the audio heard so far is
// decoded every INTERIM_MS and sent as an interim result — the same final /
// interim rhythm the panel got from Deepgram, so the question box fills in
// live and the sentence settles when the pause comes.
//
// Messages from the parent:
//   { type: 'init', modelDir, model, vadPath, threads, language }
//   { type: 'open', id, language }          start a session
//   { type: 'audio', id, pcm }              Uint8Array of 16 kHz mono Int16 LE
//   { type: 'cut', id, until }              see cut()
//   { type: 'flush', id }                   decode what is buffered now
//   { type: 'language', language }          whisper only (Parakeet detects it)
//   { type: 'close', id }
// To the parent:
//   { type: 'ready' } | { type: 'error', message } |
//   { type: 'result', id, text, isFinal, stale? }

const path = require('path');

const SAMPLE_RATE = 16000;
const VAD_WINDOW = 512; // samples per VAD step (32 ms)
const INTERIM_MS = 1200; // how often a still-running utterance is decoded
const MIN_INTERIM_S = 0.8; // and how much speech it needs first
const MAX_UTTERANCE_S = 20; // the VAD splits a monologue into finals this long
const RING_S = 30; // recent audio kept per session for interim decodes

const port = process.parentPort;
const send = (msg) => port.postMessage(msg);

// sherpa-onnx's native addon and its shared libraries cannot run from inside
// the asar archive; electron-builder unpacks them next to it.
function loadSherpa() {
  const entry = require.resolve('sherpa-onnx-node').replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`);
  return require(entry);
}

let sherpa = null;
let recognizer = null;
let initMessage = null;
let modelType = '';
let vadPath = '';
const sessions = new Map();

function recognizerConfig({ modelDir, model, threads, language }) {
  const file = (key) => path.join(modelDir, model.files[key].name);
  const modelConfig = { tokens: file('tokens'), numThreads: threads, provider: 'cpu', debug: 0 };
  if (model.type === 'whisper') {
    modelConfig.whisper = { encoder: file('encoder'), decoder: file('decoder'), language, task: 'transcribe', tailPaddings: -1 };
  } else {
    modelConfig.transducer = { encoder: file('encoder'), decoder: file('decoder'), joiner: file('joiner') };
    modelConfig.modelType = model.type;
  }
  return { featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 }, modelConfig, decodingMethod: 'greedy_search' };
}

function createVad() {
  return new sherpa.Vad({
    sileroVad: {
      model: vadPath,
      threshold: 0.5,
      minSpeechDuration: 0.25,
      minSilenceDuration: 0.5,
      maxSpeechDuration: MAX_UTTERANCE_S,
      windowSize: VAD_WINDOW
    },
    sampleRate: SAMPLE_RATE,
    numThreads: 1,
    debug: false
  }, RING_S);
}

async function decodeSamples(samples) {
  if (samples.length < SAMPLE_RATE * 0.2) return '';
  const stream = recognizer.createStream();
  stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE });
  const result = await recognizer.decodeAsync(stream);
  return (result?.text || '').trim();
}

class Session {
  constructor(id) {
    this.id = id;
    this.vad = createVad();
    // Samples fed to the VAD since the session opened. Segment starts, the
    // ring and cuts all use this scale.
    this.position = 0;
    this.ring = new Float32Array(SAMPLE_RATE * RING_S); // the last RING_S seconds
    this.pending = new Float32Array(0); // not yet a whole VAD window
    this.speechStart = null; // sample where the running utterance began
    this.cutAt = 0; // audio before this sample belongs to a question already sent
    this.lastInterim = 0;
    this.lastInterimText = '';
    this.queue = Promise.resolve(); // decodes run one at a time, in order
    this.interimBusy = false;
    this.closed = false;
  }

  accept(pcm) {
    // Int16 -> float; keep the ring for interim decodes.
    const int16 = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength >> 1);
    const samples = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) samples[i] = int16[i] / 32768;

    let all = samples;
    if (this.pending.length) {
      all = new Float32Array(this.pending.length + samples.length);
      all.set(this.pending); all.set(samples, this.pending.length);
    }
    let offset = 0;
    for (; offset + VAD_WINDOW <= all.length; offset += VAD_WINDOW) {
      const wasSpeaking = this.vad.isDetected();
      const window = all.subarray(offset, offset + VAD_WINDOW);
      this.vad.acceptWaveform(window);
      this.writeRing(window);
      this.position += VAD_WINDOW;
      if (!wasSpeaking && this.vad.isDetected()) {
        // Detection lags the first voiced frame by minSpeechDuration or so.
        this.speechStart = Math.max(0, this.position - Math.round(SAMPLE_RATE * 0.4));
        this.lastInterim = Date.now();
        this.lastInterimText = '';
      }
      this.drainSegments();
    }
    this.pending = all.slice(offset);

    if (this.vad.isDetected() && this.speechStart !== null) this.maybeInterim();
    else if (!this.vad.isDetected()) this.speechStart = null;
  }

  writeRing(samples) {
    const n = this.ring.length;
    const start = this.position % n;
    if (start + samples.length <= n) this.ring.set(samples, start);
    else { const first = n - start; this.ring.set(samples.subarray(0, first), start); this.ring.set(samples.subarray(first), 0); }
  }

  /** Audio from absolute sample `from` up to the newest sample, out of the ring. */
  recent(from) {
    const n = this.ring.length;
    const end = this.position;
    const begin = Math.max(from, end - n, 0);
    const count = end - begin;
    if (count <= 0) return new Float32Array(0);
    const out = new Float32Array(count);
    const start = begin % n;
    if (start + count <= n) out.set(this.ring.subarray(start, start + count));
    else { const first = n - start; out.set(this.ring.subarray(start)); out.set(this.ring.subarray(0, count - first), first); }
    return out;
  }

  drainSegments() {
    while (!this.vad.isEmpty()) {
      // A copied buffer: Electron does not allow addons to hand out external ones.
      const segment = this.vad.front(false);
      this.vad.pop();
      const start = segment.start;
      const samples = segment.samples;
      // Still talking (the VAD split a long utterance): interims continue
      // from here; otherwise the utterance is over.
      this.speechStart = this.vad.isDetected() ? this.position : null;
      this.lastInterimText = '';
      // A question was sent in the middle of this utterance: the words before
      // the cut were already in the box (saved for the transcript only), the
      // rest is the beginning of the next question.
      if (this.cutAt > start) {
        const split = Math.min(samples.length, this.cutAt - start);
        this.enqueue(samples.slice(0, split), { isFinal: true, stale: true });
        this.enqueue(samples.slice(split), { isFinal: true });
      } else {
        this.enqueue(samples, { isFinal: true });
      }
    }
  }

  maybeInterim() {
    if (this.interimBusy || Date.now() - this.lastInterim < INTERIM_MS) return;
    const from = Math.max(this.speechStart, this.cutAt);
    const samples = this.recent(from);
    if (samples.length < SAMPLE_RATE * MIN_INTERIM_S) return;
    this.lastInterim = Date.now();
    this.interimBusy = true;
    this.enqueue(samples, { isFinal: false }).finally(() => { this.interimBusy = false; });
  }

  enqueue(samples, { isFinal, stale = false }) {
    const run = async () => {
      if (this.closed) return;
      const text = await decodeSamples(samples);
      if (this.closed || !text) return;
      if (!isFinal) {
        if (text === this.lastInterimText) return;
        this.lastInterimText = text;
      }
      send({ type: 'result', id: this.id, text, isFinal, stale });
    };
    this.queue = this.queue.then(run, run);
    return this.queue;
  }

  /**
   * 'now': everything heard so far went into the question just sent — a
   * running utterance restarts from this point. 'heard': an automatic answer
   * fired from a final result; speech that started after it stays.
   */
  cut(until) {
    if (until === 'now') {
      this.cutAt = this.position;
      this.lastInterimText = '';
      if (this.speechStart !== null) this.lastInterim = Date.now();
    }
  }

  flush() {
    this.vad.flush();
    this.drainSegments();
  }

  close() {
    this.closed = true;
    sessions.delete(this.id);
  }
}

port.on('message', async (e) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'init': {
        sherpa = loadSherpa();
        initMessage = msg;
        vadPath = msg.vadPath;
        modelType = msg.model.type;
        recognizer = await sherpa.OfflineRecognizer.createAsync(recognizerConfig(msg));
        send({ type: 'ready' });
        break;
      }
      case 'open':
        if (!sessions.has(msg.id)) sessions.set(msg.id, new Session(msg.id));
        break;
      case 'audio':
        sessions.get(msg.id)?.accept(msg.pcm);
        break;
      case 'cut':
        sessions.get(msg.id)?.cut(msg.until);
        break;
      case 'flush':
        sessions.get(msg.id)?.flush();
        break;
      case 'language':
        // Whisper fixes the language at load time; Parakeet detects it.
        if (initMessage && modelType === 'whisper' && msg.language !== initMessage.language) {
          initMessage = { ...initMessage, language: msg.language };
          recognizer = await sherpa.OfflineRecognizer.createAsync(recognizerConfig(initMessage));
        }
        break;
      case 'close':
        sessions.get(msg.id)?.close();
        break;
    }
  } catch (err) {
    send({ type: 'error', message: String(err?.message || err) });
  }
});
