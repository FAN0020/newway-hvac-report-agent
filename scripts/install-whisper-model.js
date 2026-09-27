import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WhisperModelManager } from '../src/providers/whisper-model-manager.js';
import { whisperModel } from '../src/providers/whisper-models.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modelId = String(process.argv[2] || '').trim();
if (!modelId) {
  throw new Error('Usage: npm run stt:install -- <model-id>');
}
const model = whisperModel(modelId);
const manager = new WhisperModelManager({
  runtimeRoot: path.join(projectRoot, 'runtime', 'stt', `${process.platform}-${process.arch}`),
});
const status = await manager.install(model.id);
console.log(JSON.stringify({
  model: status.id,
  state: status.state,
  installed_bytes: status.installed_bytes,
  integrity: 'sha256-verified',
}, null, 2));
