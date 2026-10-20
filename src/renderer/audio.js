// Live audio for the desktop app. System loopback = what you hear = the
// interviewer; the microphone = you (the candidate). Same two-channel split
// the extension got from tabCapture, but here it works for ANY app (Zoom /
// Teams desktop included), not just a browser tab.
//
// The interviewer arrives either as a MediaStream (Windows loopback, Linux
// monitor source, a virtual device such as BlackHole) or, on macOS 14.2+, as
// ready-made 16 kHz PCM chunks from the native system-audio helper.

import { DeepgramChannel } from '../shared/deepgram.js';
import { OfflineSttChannel } from './offline-stt.js';
import { QuestionDetector } from '../shared/question-detector.js';
import { AnswerEngine } from '../shared/llm/index.js';
import { CHANNEL } from '../shared/constants.js';
import { pickSystemAudioInput } from '../shared/devices.js';

const STT_SAMPLE_RATE = 16000;
const WORKLET_URL = new URL('../shared/audio-worklet.js', import.meta.url).href;

const api = window.copilot;
const isWin = api.platform === 'win32';
const isLinux = api.platform === 'linux';


const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function audioInputs() {
  await api.ensureMicPermission().catch(() => {});
  const all = await navigator.mediaDevices.enumerateDevices();
  return all.filter((d) => d.kind === 'audioinput');
}

// Raw capture of an input device: no echo cancellation / noise suppression /
// AGC, which would otherwise mangle a virtual-device feed of the meeting.
function captureRawInput(deviceId) {
  return navigator.mediaDevices.getUserMedia({
    audio: { deviceId: { exact: deviceId }, echoCancellation: false, noiseSuppression: false, autoGainControl: false }
  });
}

const streamSource = (stream, mode) => ({ mode, stream, label: stream.getAudioTracks()[0]?.label || '' });
export const MAC_OUTPUT_LABEL = 'Mac system audio output';
const macOutputLabel = (output) => (output ? `${MAC_OUTPUT_LABEL} (${output})` : MAC_OUTPUT_LABEL);

/**
 * macOS 14.2+: everything the Mac plays, from the native helper. No routing
 * needed — the meeting app can use any speaker or headphones.
 */
async function captureMacSystemOutput(onStatus) {
  const offStatus = api.macTap.onStatus(onStatus);
  let output;
  try {
    ({ output } = await api.macTap.start());
  } catch (err) {
    offStatus();
    // Error messages from ipcRenderer.invoke carry an "Error invoking remote method" prefix.
    throw new Error(String(err.message || err).replace(/^.*?Error: /, ''));
  }
  return {
    mode: 'mac-tap',
    label: macOutputLabel(output),
    subscribe: (feed) => api.macTap.onPcm((chunk) => {
      // Copy into an aligned buffer: the chunk's byteOffset may be odd.
      const pcm = new Int16Array(chunk.byteLength >> 1);
      new Uint8Array(pcm.buffer).set(chunk.subarray(0, pcm.byteLength));
      feed(pcm);
    }),
    stop: () => { offStatus(); api.macTap.stop().catch(() => {}); }
  };
}

/**
 * The interviewer's audio: an explicitly chosen input device, else Windows
 * system loopback, else (Linux) the source the main process remaps from the
 * default output, else (macOS 14.2+) the system output via the native helper,
 * else (older macOS) the first virtual audio device found.
 * Resolves to { mode, label, stream } or { mode, label, subscribe, stop }.
 */
async function captureSystemAudio(settings, { onMacStatus, onFallback } = {}) {
  if (settings.systemAudioDeviceId) {
    const inputs = await audioInputs();
    if (!inputs.some((d) => d.deviceId === settings.systemAudioDeviceId)) {
      const name = settings.systemAudioDeviceLabel || 'unknown';
      throw new Error(`the chosen system-audio device (${name}) is not connected — pick another in Setup → Capture`);
    }
    return streamSource(await captureRawInput(settings.systemAudioDeviceId), 'device');
  }
  if (isWin) {
    // getDisplayMedia triggers the main-process handler that supplies loopback
    // audio; we keep only the audio track.
    const sys = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    sys.getVideoTracks().forEach((t) => t.stop());
    if (!sys.getAudioTracks().length) throw new Error('no system audio track');
    return streamSource(sys, 'loopback');
  }
  if (isLinux) {
    // Ask PulseAudio / PipeWire for a source mirroring the default output, then
    // wait briefly for Chromium's device list to pick it up.
    const label = await api.ensureMonitorSource();
    for (let attempt = 0; attempt < 6; attempt++) {
      const src = (await audioInputs()).find((d) => d.label.includes(label));
      if (src) return streamSource(await captureRawInput(src.deviceId), 'monitor');
      await sleep(500);
    }
    throw new Error(
      `the "${label}" source was created but does not show up as an input — pick it (or any "Monitor" source) in Setup → Capture → System audio`
    );
  }
  // macOS 14.2+: the system output itself.
  let tapError = null;
  const tap = await api.macTap.info().catch(() => ({ supported: false }));
  if (tap.supported) {
    try {
      return await captureMacSystemOutput(onMacStatus);
    } catch (err) {
      if (err.message === 'stopped') throw err;
      tapError = err;
    }
  }
  // Older macOS (or the helper failed): the virtual driver the meeting audio is
  // routed to (BlackHole etc.); see shared/devices.js for how it is chosen.
  const virt = pickSystemAudioInput(await audioInputs());
  if (!virt) {
    if (tapError) throw new Error(`could not record the Mac's system audio output (${tapError.message})`);
    throw new Error(
      `this Mac cannot record its system audio directly (${tap.reason || 'needs macOS 14.2+'}) — install a virtual audio device such as BlackHole, route the meeting to it, and pick it in Setup → Capture → System audio source`
    );
  }
  if (tapError) onFallback?.(`Could not record the Mac's system audio output (${tapError.message}); using ${virt.label} instead.`);
  return streamSource(await captureRawInput(virt.deviceId), 'device');
}

export class AudioSession {
  /**
   * @param {object} opts
   * @param {() => object} opts.getSettings
   * @param {(e) => void} opts.emit  transcript / answer / audio-state events
   */
  constructor({ getSettings, emit }) {
    this.getSettings = getSettings;
    this.emit = emit;
    this.running = false;

    this.sttContext = null;
    this.playbackContext = null;
    this.streams = { system: null, mic: null };
    this.systemSource = null;
    this.channels = { interviewer: null, candidate: null };
    this.watchdogs = [];
    this.unsubscribers = [];

    this.history = [];
    this.questionMark = 0;

    this.detector = new QuestionDetector({
      onQuestion: (q) => {
        this.channels.interviewer?.cut('heard');
        this.engine.answer(q);
      }
    });
    this.engine = new AnswerEngine({
      getSettings,
      getHistory: () => this.history.slice(this.questionMark),
      emit: (event) => {
        if (event.type === 'start') {
          this.questionMark = this.history.length;
          emit({ type: 'answer-start', question: event.question, attachments: event.attachments || [], prompt: event.prompt });
        } else if (event.type === 'delta') emit({ type: 'answer-delta', text: event.text });
        else if (event.type === 'done') emit({ type: 'answer-done' });
        else if (event.type === 'error') emit({ type: 'answer-done', error: event.error });
      }
    });
  }

  audioState(state) {
    this.emit({ type: 'audio-state', state });
  }

  handleUtterance({ channel, text, isFinal, stale }) {
    if (!text) return;
    // Words from before the last question sent (see DeepgramChannel.cut): kept
    // for the saved transcript only — not the panel, the box or the AI context.
    if (stale) {
      this.emit({ type: 'transcript', channel, text, isFinal: true, stale: true });
      return;
    }
    this.emit({ type: 'transcript', channel, text, isFinal });
    if (!isFinal) return;

    this.history.push({ channel, text });
    if (this.history.length > 40) {
      const drop = this.history.length - 20;
      this.history = this.history.slice(drop);
      this.questionMark = Math.max(0, this.questionMark - drop);
    }
    if (channel === CHANNEL.INTERVIEWER) this.detector.push(text);
    else this.detector.reset();
  }

  async ensureStt() {
    if (this.sttContext) return this.sttContext;
    this.sttContext = new AudioContext({ sampleRate: STT_SAMPLE_RATE });
    await this.sttContext.audioWorklet.addModule(WORKLET_URL);
    if (this.sttContext.state !== 'running') await this.sttContext.resume().catch(() => {});
    return this.sttContext;
  }

  /** `input` is a MediaStream, or a source with subscribe(feed) delivering 16 kHz Int16Array chunks. */
  async pipe(input, channelName, settings) {
    const isInterviewer = channelName === CHANNEL.INTERVIEWER;
    const { language } = settings;

    // Speech-to-text: the downloaded model on this machine, or Deepgram.
    const onUtterance = ({ text, isFinal, stale }) => this.handleUtterance({ channel: channelName, text, isFinal, stale });
    const onState = (state, detail) => {
      if (state === 'error') this.emit({ type: 'error', message: `${channelName}: ${detail}` });
      if (!isInterviewer) return;
      if (state === 'connected') this.audioState('connected');
      else if (state === 'reconnecting') this.audioState('disconnected');
      else if (state === 'error') this.audioState('error');
    };
    const dg = settings.sttEngine === 'deepgram'
      ? new DeepgramChannel({ apiKey: settings.deepgramKey, language, onUtterance, onState })
      : new OfflineSttChannel({ id: channelName, language, onUtterance, onState });
    dg.connect();
    this.channels[channelName] = dg;

    let lastLoud = Date.now();
    let heard = false;
    let quiet = false;
    const feed = (pcm) => {
      dg.send(pcm.buffer);
      if (!isInterviewer) return;
      let peak = 0;
      for (let i = 0; i < pcm.length; i += 16) { const v = pcm[i] < 0 ? -pcm[i] : pcm[i]; if (v > peak) peak = v; }
      if (peak > 300) { lastLoud = Date.now(); if (!heard || quiet) { heard = true; quiet = false; this.audioState('hearing'); } }
    };
    if (isInterviewer) {
      this.watchdogs.push(setInterval(() => {
        if (quiet || Date.now() - lastLoud < 8000) return;
        quiet = true;
        this.audioState('silent');
      }, 3000));
    }

    if (input.subscribe) {
      this.unsubscribers.push(input.subscribe(feed));
      return;
    }
    const ctx = await this.ensureStt();
    const source = ctx.createMediaStreamSource(input);
    const node = new AudioWorkletNode(ctx, 'pcm-downsampler');
    node.port.onmessage = (event) => feed(event.data);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    source.connect(node);
    node.connect(mute);
    mute.connect(ctx.destination);
  }

  async start() {
    if (this.running) return;
    const settings = this.getSettings();
    if (settings.sttEngine === 'deepgram') {
      if (!settings.deepgramKey) {
        this.emit({ type: 'error', message: 'No Deepgram API key. Add one in Setup → App → API keys, or switch Transcription to Offline.' });
        return;
      }
    } else {
      const stt = await api.stt.status().catch(() => null);
      if (!stt?.supported) {
        this.emit({ type: 'error', message: `${stt?.reason || 'Offline transcription is not available'} — switch Transcription to Deepgram in Setup → App.` });
        return;
      }
      if (!stt.ready) {
        this.emit({ type: 'error', message: 'The transcription model is not downloaded yet. Setup → App → Transcription → Download.' });
        this.emit({ type: 'stt-missing' });
        return;
      }
    }
    this.running = true;
    this.history = [];
    this.questionMark = 0;
    // The AI conversation is per session, not per Start: stopping and starting
    // again (or reopening a saved session) keeps the context. See setTurns().
    this.engine.cancel();
    this.detector.reset();
    this.detector.setLanguage(settings.language);
    this.detector.setEnabled(settings.autoAnswer);
    this.audioState('disconnected');

    // The Web Audio context first, before any capture: on macOS, creating it
    // after the microphone is open while the system-audio tap runs blocks the
    // page for 20 s (Chromium's output-device lookup times out). Created
    // first it takes ~100 ms.
    try { await this.ensureStt(); } catch (err) { this.emit({ type: 'error', message: `Audio engine unavailable (${err.message}).` }); }

    // The interviewer: system loopback (Windows), the system output (macOS
    // 14.2+) or a virtual audio device — see captureSystemAudio.
    try {
      const sys = await captureSystemAudio(settings, {
        onMacStatus: (status) => this.macStatus(status),
        onFallback: (message) => this.emit({ type: 'error', message })
      });
      if (!this.running) { sys.stop?.(); sys.stream?.getTracks().forEach((t) => t.stop()); return; } // Stop pressed meanwhile
      this.systemSource = sys;
      this.streams.system = sys.stream || null;
      // Tell the panel what carries the interviewer, so a silent capture can
      // be traced to the routing or permission (see renderer.js 'silent').
      this.emit({ type: 'capture', label: sys.label, mode: sys.mode });
      await this.pipe(sys.stream || sys, CHANNEL.INTERVIEWER, settings);
    } catch (err) {
      if (!this.running) return; // stopped while waiting (e.g. for the macOS permission prompt)
      this.emit({ type: 'error', message: `Could not capture system audio: ${err.message}` });
      this.running = false;
      this.audioState('error');
      return;
    }

    if (settings.transcribeCandidate) {
      try {
        await api.ensureMicPermission().catch(() => {});
        const audio = settings.micDeviceId ? { deviceId: { exact: settings.micDeviceId } } : true;
        const mic = await navigator.mediaDevices.getUserMedia({ audio });
        this.streams.mic = mic;
        await this.pipe(mic, CHANNEL.CANDIDATE, settings);
      } catch (err) {
        this.emit({ type: 'error', message: `Microphone unavailable (${err.name}).` });
      }
    }
    this.emit({ type: 'running', running: true });
  }

  /** Status from the macOS system-audio helper while it runs. */
  macStatus(status) {
    if (status.event === 'waiting-permission') {
      this.emit({ type: 'permission-wait' });
    } else if (status.event === 'output' && this.systemSource?.mode === 'mac-tap') {
      // Still recording — the tap follows the new output (e.g. AirPods).
      this.systemSource.label = macOutputLabel(status.output);
      this.emit({ type: 'capture', label: this.systemSource.label, mode: 'mac-tap', changed: true });
    } else if (status.event === 'exit' && this.running) {
      this.emit({ type: 'error', message: `System audio recording stopped (${status.message}). Press Stop, then Start.` });
      this.audioState('error');
    }
  }

  async stop() {
    this.running = false;
    this.engine.cancel();
    this.detector.reset();
    for (const t of this.watchdogs.splice(0)) clearInterval(t);
    for (const off of this.unsubscribers.splice(0)) off();
    this.systemSource?.stop?.();
    this.systemSource = null;
    // A capture still waiting for the macOS permission prompt.
    if (api.platform === 'darwin') api.macTap.stop().catch(() => {});
    for (const k of Object.keys(this.channels)) { this.channels[k]?.close(); this.channels[k] = null; }
    for (const k of Object.keys(this.streams)) { this.streams[k]?.getTracks().forEach((t) => t.stop()); this.streams[k] = null; }
    if (isLinux) await api.releaseMonitorSource().catch(() => {});
    await this.playbackContext?.close().catch(() => {});
    await this.sttContext?.close().catch(() => {});
    this.playbackContext = null;
    this.sttContext = null;
    this.audioState('off');
    this.emit({ type: 'running', running: false });
  }

  setLanguage(language) {
    this.detector.setLanguage(language);
    for (const dg of Object.values(this.channels)) dg?.setLanguage(language);
  }

  setAutoAnswer(on) { this.detector.setEnabled(on); }

  /** Replace the AI conversation with a saved session's turns (empty = fresh). */
  setTurns(turns) { this.engine.setTurns(turns); }

  /**
   * Manual send of an exact question (from the box), with optional attachments.
   * `opts.replaceLast` re-asks the latest question (see AnswerEngine.answer).
   */
  ask(text, attachments = [], opts = {}) {
    const q = (text || '').trim();
    if (!q) return;
    // Everything the interviewer said up to now went into this question; the
    // box and transcript start fresh from here. A retry re-asks an old
    // question and must not cut into what is being said now.
    if (!opts.retry) this.channels.interviewer?.cut('now');
    this.detector.reset();
    this.engine.answer(q, attachments, opts);
  }
}
