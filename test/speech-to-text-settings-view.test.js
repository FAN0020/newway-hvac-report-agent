import assert from 'node:assert/strict';
import test from 'node:test';
import {
  modelOptionLabel,
  modelSelectionView,
} from '../web/speech-to-text-settings.js';

const models = [
  { id: 'base', display_name: 'Base', description: 'Fast, balanced local transcription.', state: 'installed', ready: true, selected: true },
  { id: 'small', display_name: 'Small', description: 'Good general transcription.', state: 'not_installed', ready: false, selected: false },
  { id: 'medium', display_name: 'Medium', description: 'Higher accuracy.', state: 'installing', ready: false, selected: false },
  { id: 'large-v3', display_name: 'Large v3', description: 'Best local transcription quality.', state: 'error', ready: false, selected: false, error_code: 'STT_MODEL_CORRUPTED' },
];

test('settings option labels truthfully expose every model lifecycle state', () => {
  assert.equal(modelOptionLabel(models[0]), 'Base — Installed');
  assert.equal(modelOptionLabel(models[1]), 'Small — Not installed');
  assert.equal(modelOptionLabel(models[2]), 'Medium — Installing…');
  assert.equal(modelOptionLabel(models[3]), 'Large v3 — Unavailable');
});

test('settings selection view offers only the action supported by authoritative state', () => {
  assert.deepEqual(modelSelectionView({ models, selected_model: 'base' }, 'base'), {
    model: models[0], message: 'Fast, balanced local transcription. Installed and active.', action: 'none', actionLabel: null,
  });
  assert.deepEqual(modelSelectionView({ models, selected_model: 'base' }, 'small'), {
    model: models[1], message: 'Good general transcription. Install it before selecting it.', action: 'install', actionLabel: 'Install Small',
  });
  assert.deepEqual(modelSelectionView({ models, selected_model: 'base' }, 'medium'), {
    model: models[2], message: 'Medium is installing…', action: 'wait', actionLabel: null,
  });
  assert.deepEqual(modelSelectionView({ models, selected_model: 'base' }, 'large-v3'), {
    model: models[3], message: 'Large v3 is unavailable (STT_MODEL_CORRUPTED). Reinstall it to recover.', action: 'install', actionLabel: 'Reinstall Large v3',
  });
});
