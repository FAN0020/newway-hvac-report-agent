import assert from 'node:assert/strict';
import test from 'node:test';

import { PcmWavRecorder, resolveWorkletModuleUrl } from '../web/audio-recorder.js';

test('worklet URL resolves from the actual application origin', () => {
  assert.equal(
    resolveWorkletModuleUrl('http://127.0.0.1:4317/reports/capture'),
    'http://127.0.0.1:4317/pcm-capture-worklet.js',
  );
});

test('a failed worklet load releases microphone and AudioContext resources', async () => {
  let trackStops = 0;
  let contextCloses = 0;
  let requestedUrl = '';
  const stream = { getTracks: () => [{ stop: () => { trackStops += 1; } }] };
  const context = {
    audioWorklet: {
      addModule: async (url) => {
        requestedUrl = url;
        throw new DOMException('Network error', 'AbortError');
      },
    },
    close: async () => { contextCloses += 1; },
  };
  const recorder = new PcmWavRecorder({
    mediaDevices: { getUserMedia: async () => stream },
    createAudioContext: () => context,
    locationHref: 'http://127.0.0.1:4317/',
  });

  await assert.rejects(() => recorder.start(), /Network error/);
  assert.equal(requestedUrl, 'http://127.0.0.1:4317/pcm-capture-worklet.js');
  assert.equal(trackStops, 1);
  assert.equal(contextCloses, 1);
  assert.equal(recorder.stream, null);
  assert.equal(recorder.context, null);
});
