import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import test from 'node:test';

const source = await fs.readFile(new URL('../scripts/build-blind-annotation-package.js', import.meta.url), 'utf8');

test('blind annotation package strips seed answers and system predictions', () => {
  for (const forbidden of ['standard_text', 'expected_facts', 'expected_retrieval_ids', 'relevant_retrieval_ids', 'seed']) {
    assert.match(source, new RegExp(`'${forbidden}'`));
  }
  assert.match(source, /assertBlind/);
  assert.match(source, /audio_file_sha256/);
  assert.match(source, /frozen_gold: false/);
  assert.doesNotMatch(source, /component-results\.json|batch3-results\.json|deepeval-results\.json/);
});
