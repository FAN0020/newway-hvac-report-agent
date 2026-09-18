import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectPcmWav } from '../src/wav.js';
import { pcmWav } from './helpers.js';

test('accepts mono 16-bit PCM WAV', () => {
  const result = inspectPcmWav(pcmWav({ samples: 16_000 }));
  assert.equal(result.channels, 1);
  assert.equal(result.bitsPerSample, 16);
  assert.equal(result.durationMs, 1000);
});

test('rejects malformed WAV', () => {
  assert.throws(() => inspectPcmWav(Buffer.from('not wav')), { code: 'INVALID_WAV' });
});
