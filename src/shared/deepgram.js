// Deepgram streaming client for one audio channel.
//
// Browser WebSockets cannot set an Authorization header, so the key travels as
// a subprotocol pair — the form Deepgram documents for browser clients.

const ENDPOINT = 'wss://api.deepgram.com/v1/listen';
const KEEPALIVE_MS = 8000; // Deepgram closes an idle socket at ~10s
const MAX_BACKOFF_MS = 8000;

export class DeepgramChannel {
  /**
   * @param {object} opts
   * @param {string} opts.apiKey
   * @param {string} opts.language  Deepgram language code (en | ro | pt-BR)
   * @param {(u: {text: string, isFinal: boolean}) => void} opts.onUtterance
   * @param {(state: string, detail?: string) => void} [opts.onState]
   */
  constructor({ apiKey, language, onUtterance, onState = () => {} }) {
    this.apiKey = apiKey;
    this.language = language;
    this.onUtterance = onUtterance;
    this.onState = onState;

    this.model = 'nova-3';
    this.socket = null;
    this.keepaliveTimer = null;
    this.retries = 0;
    this.closedByUs = false;
    this.pendingFinals = [];
    // Audio that arrives before the socket opens, so the first words are not lost.
    this.queue = [];
  }

  url() {
    const params = new URLSearchParams({
      model: this.model,
      language: this.language,
      encoding: 'linear16',
      sample_rate: '16000',
      channels: '1',
      interim_results: 'true',
      smart_format: 'true',
      punctuate: 'true',
      endpointing: '300'
    });
    return `${ENDPOINT}?${params}`;
  }

  connect() {
    this.closedByUs = false;
    const socket = new WebSocket(this.url(), ['token', this.apiKey]);
    socket.binaryType = 'arraybuffer';
    this.socket = socket;

    socket.onopen = () => {
      this.retries = 0;
      this.onState('connected');
      for (const chunk of this.queue) socket.send(chunk);
      this.queue = [];
      this.startKeepalive();
    };

    // Same reason as onclose: ignore late results from a superseded socket,
    // which would otherwise arrive transcribed in the previous language.
    socket.onmessage = (event) => {
      if (this.socket === socket) this.handleMessage(event);
    };

    socket.onerror = () => this.onState('error', 'Deepgram socket error');

    socket.onclose = (event) => {
      // A language switch closes the old socket and opens a new one straight
      // away. The old socket's close event lands after that, so identity — not
      // the closedByUs flag — is what decides whether this close still matters.
      if (this.socket !== socket) return;
      this.stopKeepalive();
      if (this.closedByUs) return;

      // 1008 is Deepgram's "bad request" — usually this model/language pair.
      if (event.code === 1008 && this.model === 'nova-3') {
        this.onState('info', `nova-3 rejected ${this.language}; falling back to nova-2`);
        this.model = 'nova-2';
        this.connect();
        return;
      }
      if (event.code === 4001 || event.code === 4008) {
        this.onState('error', 'Deepgram rejected the API key');
        return;
      }
      this.scheduleReconnect();
    };
  }

  handleMessage(event) {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }
    if (data.type !== 'Results') return;

    const alt = data.channel?.alternatives?.[0];
    const text = alt?.transcript?.trim();
    if (!text && !data.speech_final) return;

    if (data.is_final) {
      if (text) this.pendingFinals.push(text);
      // speech_final means Deepgram detected the end of an utterance.
      if (data.speech_final && this.pendingFinals.length) {
        this.onUtterance({ text: this.pendingFinals.join(' '), isFinal: true });
        this.pendingFinals = [];
      }
    } else if (text) {
      // Interim: show the settled part plus the guess still being revised.
      this.onUtterance({ text: [...this.pendingFinals, text].join(' '), isFinal: false });
    }
  }

  /** Flush anything Deepgram finalised but never endpointed (e.g. on stop). */
  flush() {
    if (this.pendingFinals.length) {
      this.onUtterance({ text: this.pendingFinals.join(' '), isFinal: true });
      this.pendingFinals = [];
    }
  }

  send(pcmChunk) {
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(pcmChunk);
    } else if (this.queue.length < 100) {
      this.queue.push(pcmChunk);
    }
  }

  startKeepalive() {
    this.stopKeepalive();
    this.keepaliveTimer = setInterval(() => {
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ type: 'KeepAlive' }));
      }
    }, KEEPALIVE_MS);
  }

  stopKeepalive() {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = null;
  }

  scheduleReconnect() {
    const delay = Math.min(500 * 2 ** this.retries++, MAX_BACKOFF_MS);
    this.onState('reconnecting', `retrying in ${Math.round(delay / 1000)}s`);
    setTimeout(() => {
      if (!this.closedByUs) this.connect();
    }, delay);
  }

  /** Change language mid-call: Deepgram fixes it at connect time, so reconnect. */
  setLanguage(language) {
    if (language === this.language) return;
    this.language = language;
    this.model = 'nova-3';
    this.flush();
    this.hardClose();
    this.connect();
  }

  hardClose() {
    this.closedByUs = true;
    this.stopKeepalive();
    if (this.socket && this.socket.readyState <= WebSocket.OPEN) {
      // CloseStream tells Deepgram to finish transcribing what it already has.
      if (this.socket.readyState === WebSocket.OPEN) {
        try {
          this.socket.send(JSON.stringify({ type: 'CloseStream' }));
        } catch { /* socket already gone */ }
      }
      this.socket.close();
    }
    this.socket = null;
  }

  close() {
    this.flush();
    this.hardClose();
  }
}
