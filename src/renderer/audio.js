// Live audio for the desktop app. System loopback = what you hear = the
// interviewer; the microphone = you (the candidate). Same two-channel split
// the extension got from tabCapture, but here it works for ANY app (Zoom /
// Teams desktop included), not just a browser tab.

import { DeepgramChannel } from '../shared/deepgram.js';
import { QuestionDetector } from '../shared/question-detector.js';
import { AnswerEngine } from '../shared/llm/index.js';
import { CHANNEL } from '../shared/constants.js';

const STT_SAMPLE_RATE = 16000;
const WORKLET_URL = new URL('../shared/audio-worklet.js', import.meta.url).href;

const api = window.copilot;
const isWin = api.platform === 'win32';
const isLinux = api.platform === 'linux';

// Inputs that carry system audio: virtual drivers on macOS (BlackHole etc.),
// and on Linux the source the main process remaps from the output's monitor
// (label "InterviewCopilotMonitor") or any user-made monitor/loopback source.
const VIRTUAL_INPUT = /copilot|monitor|blackhole|loopback|soundflower|vb-?audio|vb-?cable|virtual/i;

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

/**
 * The interviewer's audio stream: an explicitly chosen input device, else
 * Windows system loopback, else (Linux) the source the main process remaps
 * from the default output, else (macOS) the first virtual audio device found.
 */
async function captureSystemAudio(settings) {
  if (settings.systemAudioDeviceId) {
    const inputs = await audioInputs();
    if (!inputs.some((d) => d.deviceId === settings.systemAudioDeviceId)) {
      const name = settings.systemAudioDeviceLabel || 'unknown';
      throw new Error(`the chosen system-audio device (${name}) is not connected — pick another in Setup → Capture`);
    }
    return captureRawInput(settings.systemAudioDeviceId);
  }
  if (isWin) {
    // getDisplayMedia triggers the main-process handler that supplies loopback
    // audio; we keep only the audio track.
    const sys = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    sys.getVideoTracks().forEach((t) => t.stop());
    if (!sys.getAudioTracks().length) throw new Error('no system audio track');
    return sys;
  }
  if (isLinux) {
    // Ask PulseAudio / PipeWire for a source mirroring the default output, then
    // wait briefly for Chromium's device list to pick it up.
    const label = await api.ensureMonitorSource();
    for (let attempt = 0; attempt < 6; attempt++) {
      const src = (await audioInputs()).find((d) => d.label.includes(label));
      if (src) return captureRawInput(src.deviceId);
      await sleep(500);
    }
    throw new Error(
      `the "${label}" source was created but does not show up as an input — pick it (or any "Monitor" source) in Setup → Capture → System audio`
    );
  }
  const virt = (await audioInputs()).find((d) => VIRTUAL_INPUT.test(d.label));
  if (!virt) {
    throw new Error(
      'macOS needs a virtual audio device (e.g. BlackHole) that the meeting audio is routed to — install one, then pick it in Setup → Capture → System audio'
    );
  }
  return captureRawInput(virt.deviceId);
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
    this.channels = { interviewer: null, candidate: null };
    this.watchdogs = [];

    this.history = [];
    this.questionMark = 0;

    this.detector = new QuestionDetector({ onQuestion: (q) => this.engine.answer(q) });
    this.engine = new AnswerEngine({
      getSettings,
      getHistory: () => this.history.slice(this.questionMark),
      emit: (event) => {
        if (event.type === 'start') {
          this.questionMark = this.history.length;
          emit({ type: 'answer-start', question: event.question });
        } else if (event.type === 'delta') emit({ type: 'answer-delta', text: event.text });
        else if (event.type === 'done') emit({ type: 'answer-done' });
        else if (event.type === 'error') emit({ type: 'answer-done', error: event.error });
      }
    });
  }

  audioState(state) {
    this.emit({ type: 'audio-state', state });
  }

  handleUtterance({ channel, text, isFinal }) {
    if (!text) return;
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

  async pipe(stream, channelName, language, apiKey) {
    const ctx = await this.ensureStt();
    const source = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'pcm-downsampler');
    const isInterviewer = channelName === CHANNEL.INTERVIEWER;

    const dg = new DeepgramChannel({
      apiKey,
      language,
      onUtterance: ({ text, isFinal }) => this.handleUtterance({ channel: channelName, text, isFinal }),
      onState: (state, detail) => {
        if (state === 'error') this.emit({ type: 'error', message: `${channelName}: ${detail}` });
        if (!isInterviewer) return;
        if (state === 'connected') this.audioState('connected');
        else if (state === 'reconnecting') this.audioState('disconnected');
        else if (state === 'error') this.audioState('error');
      }
    });
    dg.connect();
    this.channels[channelName] = dg;

    let lastLoud = Date.now();
    let heard = false;
    let quiet = false;
    node.port.onmessage = (event) => {
      const pcm = event.data;
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

    const mute = ctx.createGain();
    mute.gain.value = 0;
    source.connect(node);
    node.connect(mute);
    mute.connect(ctx.destination);
  }

  async start() {
    if (this.running) return;
    const settings = this.getSettings();
    if (!settings.deepgramKey) {
      this.emit({ type: 'error', message: 'No Deepgram API key. Add one in Setup or config/keys.json.' });
      return;
    }
    this.running = true;
    this.history = [];
    this.questionMark = 0;
    this.engine.reset();
    this.detector.reset();
    this.detector.setLanguage(settings.language);
    this.detector.setEnabled(settings.autoAnswer);
    this.audioState('disconnected');

    // The interviewer: system loopback (Windows) or a virtual audio device
    // (macOS) — see captureSystemAudio.
    try {
      const sys = await captureSystemAudio(settings);
      this.streams.system = sys;
      await this.pipe(sys, CHANNEL.INTERVIEWER, settings.language, settings.deepgramKey);
    } catch (err) {
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
        await this.pipe(mic, CHANNEL.CANDIDATE, settings.language, settings.deepgramKey);
      } catch (err) {
        this.emit({ type: 'error', message: `Microphone unavailable (${err.name}).` });
      }
    }
    this.emit({ type: 'running', running: true });
  }

  async stop() {
    this.running = false;
    this.engine.cancel();
    this.detector.reset();
    for (const t of this.watchdogs.splice(0)) clearInterval(t);
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

  /** Manual send of an exact question (from the box). */
  ask(text) {
    const q = (text || '').trim();
    if (!q) return;
    this.detector.reset();
    this.engine.answer(q);
  }
}
