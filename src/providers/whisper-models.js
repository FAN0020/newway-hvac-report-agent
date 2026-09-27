const HUGGING_FACE_COMMIT = '5359861c739e955e79d9a303bcbc70fb988958b1';
const MODEL_BASE_URL = `https://huggingface.co/ggerganov/whisper.cpp/resolve/${HUGGING_FACE_COMMIT}`;
const RUNTIME_VERSION = 'b4938';

function definition({ id, displayName, description, quality, speed, bytes, sha256 }) {
  return Object.freeze({
    id,
    displayName,
    description,
    quality,
    speed,
    filename: `ggml-${id}.bin`,
    approximateStorageBytes: bytes,
    download: Object.freeze({
      url: `${MODEL_BASE_URL}/ggml-${id}.bin`,
      sha256,
      bytes,
      sourceRevision: HUGGING_FACE_COMMIT,
    }),
    runtime: Object.freeze({ provider: 'whisper.cpp', versions: Object.freeze([RUNTIME_VERSION]), multilingual: true }),
  });
}

// The model IDs and filenames come from the download script bundled with the
// repository-pinned whisper.cpp b4938 source. Digests and byte sizes are the
// pinned Hugging Face LFS objects at HUGGING_FACE_COMMIT.
export const WHISPER_MODEL_REGISTRY = Object.freeze([
  definition({
    id: 'tiny', displayName: 'Tiny', description: 'Fastest and lightest; lower accuracy.',
    quality: 'Entry', speed: 'Fastest', bytes: 77_691_713,
    sha256: 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21',
  }),
  definition({
    id: 'base', displayName: 'Base', description: 'Fast, balanced local transcription.',
    quality: 'Balanced', speed: 'Fast', bytes: 147_951_465,
    sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe',
  }),
  definition({
    id: 'small', displayName: 'Small', description: 'Good general transcription with moderate resource use.',
    quality: 'Good', speed: 'Moderate', bytes: 487_601_967,
    sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b',
  }),
  definition({
    id: 'medium', displayName: 'Medium', description: 'Higher accuracy with slower, heavier inference.',
    quality: 'Higher', speed: 'Slower', bytes: 1_533_763_059,
    sha256: '6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208',
  }),
  definition({
    id: 'large-v3', displayName: 'Large v3', description: 'Best local transcription quality; slowest and largest.',
    quality: 'Best', speed: 'Slowest', bytes: 3_095_033_483,
    sha256: '64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2',
  }),
  definition({
    id: 'large-v3-turbo', displayName: 'Large v3 Turbo', description: 'Near-large quality with faster inference and lower storage use.',
    quality: 'High', speed: 'Moderate', bytes: 1_624_555_275,
    sha256: '1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69',
  }),
]);

const BY_ID = new Map(WHISPER_MODEL_REGISTRY.map((entry) => [entry.id, entry]));

export const DEFAULT_WHISPER_MODEL_ID = 'base';
export const WHISPER_RUNTIME_VERSION = RUNTIME_VERSION;
export const WHISPER_MODELS = Object.freeze(Object.fromEntries(WHISPER_MODEL_REGISTRY.map((entry) => [entry.id, entry.filename])));

export function whisperModel(modelId) {
  const model = BY_ID.get(String(modelId || ''));
  if (!model) {
    throw Object.assign(new Error(`Unsupported Whisper model: ${modelId}`), {
      code: 'STT_MODEL_UNSUPPORTED', status: 400,
    });
  }
  return model;
}
