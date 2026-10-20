// Offline speech-to-text models the app can download and run locally with
// sherpa-onnx (see ./index.js and ./worker.js). One model covers every meeting
// language the app offers (en, ro, pt-BR). The files come from the sherpa-onnx
// project's Hugging Face repositories, fetched one file at a time so progress
// is exact and an interrupted download resumes per file.
//
// The Setup page gets this list through stt:status (it cannot require this
// CommonJS module from its ES-module world).

const HF = 'https://huggingface.co';
const HF_MIRROR = 'https://hf-mirror.com'; // reachable where huggingface.co is blocked

// Silero VAD splits the audio into utterances for the non-streaming models.
const VAD_MODEL = {
  name: 'silero_vad.onnx',
  size: 643854,
  urls: ['https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx']
};

const repoSources = (repo) => [`${HF}/${repo}/resolve/main/`, `${HF_MIRROR}/${repo}/resolve/main/`];

const STT_MODELS = [
  {
    id: 'parakeet-tdt-0.6b-v3-int8',
    label: 'Parakeet v3 — best accuracy (English, Romanian, Portuguese + 22 more)',
    hint: '670 MB download, about 1.3 GB of RAM while running. Detects the language by itself.',
    type: 'nemo_transducer',
    recommended: true,
    sources: repoSources('csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8'),
    files: {
      encoder: { name: 'encoder.int8.onnx', size: 652184281 },
      decoder: { name: 'decoder.int8.onnx', size: 11845275 },
      joiner: { name: 'joiner.int8.onnx', size: 6355277 },
      tokens: { name: 'tokens.txt', size: 93939 }
    }
  },
  {
    id: 'whisper-small-int8',
    label: 'Whisper small — smaller download (English, Romanian, Portuguese + 90 more)',
    hint: '375 MB download, about 1.8 GB of RAM while running. Slower and less accurate than Parakeet; transcribes in the Meeting language.',
    type: 'whisper',
    sources: repoSources('csukuangfj/sherpa-onnx-whisper-small'),
    files: {
      encoder: { name: 'small-encoder.int8.onnx', size: 112442483 },
      decoder: { name: 'small-decoder.int8.onnx', size: 262226114 },
      tokens: { name: 'small-tokens.txt', size: 816730 }
    }
  }
];

const DEFAULT_STT_MODEL = STT_MODELS.find((m) => m.recommended).id;

const sttModel = (id) => STT_MODELS.find((m) => m.id === id) || null;

const modelSize = (m) => Object.values(m.files).reduce((n, f) => n + f.size, 0);

/** Deepgram language code -> whisper language code (Parakeet needs none). */
const whisperLanguage = (code) => ({ en: 'en', ro: 'ro', 'pt-BR': 'pt' }[code] || 'en');

module.exports = { STT_MODELS, VAD_MODEL, DEFAULT_STT_MODEL, sttModel, modelSize, whisperLanguage };
