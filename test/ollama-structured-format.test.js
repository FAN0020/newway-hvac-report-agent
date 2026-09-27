import assert from 'node:assert/strict';
import test from 'node:test';
import { OllamaProvider } from '../src/providers/ollama.js';

test('semantic JSON schema reaches the local Ollama chat request as its format contract', async () => {
  let request;
  const provider = new OllamaProvider({ fetcher: async (_url, options) => {
    request = JSON.parse(options.body);
    return { ok: true, json: async () => ({ message: { content: '{"facts":[]}' } }) };
  } });
  const schema = { type: 'object', properties: { facts: { type: 'array' } }, required: ['facts'] };
  const result = await provider.generateJson({ model: 'local-test', system: 'Extract', prompt: 'Input', formatSchema: schema });
  assert.deepEqual(request.format, schema);
  assert.deepEqual(result.data, { facts: [] });
});

test('legacy JSON requests keep the existing JSON mode', async () => {
  let request;
  const provider = new OllamaProvider({ fetcher: async (_url, options) => {
    request = JSON.parse(options.body);
    return { ok: true, json: async () => ({ message: { content: '{}' } }) };
  } });
  await provider.generateJson({ model: 'local-test', system: 'System', prompt: 'Prompt' });
  assert.equal(request.format, 'json');
});
