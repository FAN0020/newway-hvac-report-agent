import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import {
  buildIndex,
  chunkText,
  createUploadStore,
  extractPlainText,
  ingestDocument,
  tokenize,
  UploadExtractionError,
  UploadUnsupportedError,
  UPLOAD_STATUS,
} from '../../src/v2/upload.js';

const METADATA = Object.freeze({ uploader: 'tech-001', source: 'user_upload:tech-001', scenario: 'bus_depot_manual' });

async function tmpStore(name) {
  const baseDir = path.resolve('.tmp-tests', `v2-upload-${name}`);
  await fs.rm(baseDir, { recursive: true, force: true });
  return { store: createUploadStore({ baseDir }), baseDir };
}

test('txt upload ingests to READY through the full state machine and persists', async (t) => {
  const { store, baseDir } = await tmpStore('txt-ready');
  t.after(() => fs.rm(baseDir, { recursive: true, force: true }));
  const text = 'Fan belt tension check performed. Replace if worn.';
  const buffer = Buffer.from(text, 'utf8');

  const record = await ingestDocument({
    scopeId: 'SBS_BUS',
    filename: 'bus-notes.txt',
    mimeType: 'text/plain',
    buffer,
    metadata: METADATA,
    store,
  });

  assert.match(record.upload_id, /^upload_[a-f0-9]{24}$/);
  assert.equal(record.filename, 'bus-notes.txt');
  assert.equal(record.scope_id, 'SBS_BUS');
  assert.equal(record.size_bytes, buffer.length);
  assert.match(record.sha256, /^[a-f0-9]{64}$/);
  assert.equal(record.status, UPLOAD_STATUS.READY);
  assert.deepEqual(record.errors, []);
  assert.equal(record.parsed.char_count, text.length);
  assert.equal(record.parsed.text_preview, text);
  assert.ok(record.chunk_count >= 1);
  assert.ok(record.indexed.token_count >= 1);
  assert.equal(record.provenance.uploader, 'tech-001');
  assert.equal(record.provenance.source, 'user_upload:tech-001');
  assert.equal(record.provenance.scenario, 'bus_depot_manual');
  assert.ok(!Number.isNaN(Date.parse(record.provenance.uploaded_at)));

  assert.deepEqual(
    record.steps.map((step) => step.status),
    ['UPLOADED', 'PROCESSING', 'PARSED', 'CHUNKED', 'INDEXED', 'READY'],
  );

  // Persisted and retrievable from the store, including chunks.
  assert.deepEqual(await store.get(record.upload_id), record);
  const chunks = await store.getChunks(record.upload_id);
  assert.ok(chunks.length > 0);
  assert.equal(chunks[0].text, text);
});

test('sha256 is content-stable while upload_id is bound to scope + content', async (t) => {
  const { store, baseDir } = await tmpStore('sha256');
  t.after(() => fs.rm(baseDir, { recursive: true, force: true }));
  const buffer = Buffer.from('identical bytes', 'utf8');
  const opts = (scopeId) => ({ scopeId, filename: 'x.txt', mimeType: 'text/plain', buffer, metadata: METADATA, store });

  const bus = await ingestDocument(opts('SBS_BUS'));
  const busAgain = await ingestDocument(opts('SBS_BUS'));
  const rail = await ingestDocument(opts('SBS_RAIL'));

  assert.equal(bus.sha256, busAgain.sha256);
  assert.equal(bus.upload_id, busAgain.upload_id);
  assert.equal(rail.sha256, bus.sha256);
  assert.notEqual(rail.upload_id, bus.upload_id);
});

test('docx extracts text through an injected unzip mock', async (t) => {
  const { store, baseDir } = await tmpStore('docx-ok');
  t.after(() => fs.rm(baseDir, { recursive: true, force: true }));
  const xml = '<w:document><w:body><w:p><w:r><w:t>Hello &amp; welcome to the depot</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>Second paragraph</w:t></w:r></w:p></w:body></w:document>';
  const calls = [];
  const execFileMock = async (command, args) => {
    calls.push({ command, args });
    return { stdout: xml, stderr: '' };
  };

  const record = await ingestDocument({
    scopeId: 'SBS_BUS',
    filename: 'manual.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: Buffer.from('fake zip bytes'),
    metadata: METADATA,
    store,
    execFile: execFileMock,
  });

  assert.equal(record.status, UPLOAD_STATUS.READY);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'unzip');
  assert.equal(calls[0].args[0], '-p');
  assert.equal(calls[0].args[2], 'word/document.xml');
  const expected = 'Hello & welcome to the depot\nSecond paragraph';
  assert.equal(record.parsed.char_count, expected.length);
  assert.ok(record.parsed.text_preview.includes('Hello & welcome'));
});

test('docx extraction failure records FAILED and never persists chunks', async (t) => {
  const { store, baseDir } = await tmpStore('docx-fail');
  t.after(() => fs.rm(baseDir, { recursive: true, force: true }));
  const execFileMock = async () => {
    throw new Error('unzip: corrupt archive');
  };

  const record = await ingestDocument({
    scopeId: 'SBS_BUS',
    filename: 'broken.docx',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    buffer: Buffer.from('garbage'),
    metadata: METADATA,
    store,
    execFile: execFileMock,
  });

  assert.equal(record.status, UPLOAD_STATUS.FAILED);
  assert.ok(record.errors.length >= 1);
  assert.equal(record.errors[0].code, 'UPLOAD_EXTRACTION_FAILED');
  assert.equal(record.steps.at(-1).status, UPLOAD_STATUS.FAILED);
  assert.equal(record.indexed, null);
  assert.deepEqual(await store.getChunks(record.upload_id), []);
});

test('pdf extracts text through an injected pdftotext mock', async (t) => {
  const { store, baseDir } = await tmpStore('pdf-ok');
  t.after(() => fs.rm(baseDir, { recursive: true, force: true }));
  const calls = [];
  const execFileMock = async (command, args) => {
    calls.push({ command, args });
    return { stdout: 'Door motor ZX-47 intermittent failure.\n', stderr: '' };
  };

  const record = await ingestDocument({
    scopeId: 'SBS_BUS',
    filename: 'zx47.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4 fake'),
    metadata: METADATA,
    store,
    execFile: execFileMock,
  });

  assert.equal(record.status, UPLOAD_STATUS.READY);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, 'pdftotext');
  assert.ok(record.parsed.text_preview.includes('ZX-47'));
});

test('scanned/image-only pdf (no text layer) records FAILED with OCR future-scope message', async (t) => {
  const { store, baseDir } = await tmpStore('pdf-scan');
  t.after(() => fs.rm(baseDir, { recursive: true, force: true }));
  const execFileMock = async () => ({ stdout: '\n   \n', stderr: '' });

  const record = await ingestDocument({
    scopeId: 'SBS_BUS',
    filename: 'scan-only.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4'),
    metadata: METADATA,
    store,
    execFile: execFileMock,
  });

  assert.equal(record.status, UPLOAD_STATUS.FAILED);
  assert.equal(record.errors[0].code, 'PDF_TEXT_LAYER_REQUIRED');
  assert.match(record.errors[0].message, /OCR/);
  assert.deepEqual(await store.getChunks(record.upload_id), []);
});

test('missing/failing pdftotext records FAILED with the PDF unsupported boundary', async (t) => {
  const { store, baseDir } = await tmpStore('pdf-no-tool');
  t.after(() => fs.rm(baseDir, { recursive: true, force: true }));
  const execFileMock = async () => {
    const error = new Error('spawn pdftotext ENOENT');
    error.code = 'ENOENT';
    throw error;
  };

  const record = await ingestDocument({
    scopeId: 'SBS_BUS',
    filename: 'needs-pdftotext.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4'),
    metadata: METADATA,
    store,
    execFile: execFileMock,
  });

  assert.equal(record.status, UPLOAD_STATUS.FAILED);
  assert.equal(record.errors[0].code, 'PDF_TEXT_LAYER_REQUIRED');
  assert.match(record.errors[0].message, /future scope/);
});

test('unsupported upload types record FAILED', async (t) => {
  const { store, baseDir } = await tmpStore('unsupported');
  t.after(() => fs.rm(baseDir, { recursive: true, force: true }));

  const record = await ingestDocument({
    scopeId: 'SBS_BUS',
    filename: 'drawing.dwg',
    mimeType: 'application/x-dwg',
    buffer: Buffer.from('binary'),
    metadata: METADATA,
    store,
  });

  assert.equal(record.status, UPLOAD_STATUS.FAILED);
  assert.equal(record.errors[0].code, 'UPLOAD_UNSUPPORTED_TYPE');
  assert.equal(record.indexed, null);
  assert.deepEqual(await store.getChunks(record.upload_id), []);
});

test('extractPlainText decodes txt/csv/md, strips BOM and honours mimeType', async () => {
  assert.equal(await extractPlainText({ buffer: Buffer.from('\uFEFFhello'), filename: 'a.txt' }), 'hello');
  assert.equal(await extractPlainText({ buffer: Buffer.from('a,b\n1,2', 'utf8'), filename: 'a.csv' }), 'a,b\n1,2');
  assert.equal(await extractPlainText({ buffer: Buffer.from('# title', 'utf8'), filename: 'a.md' }), '# title');
  assert.equal(await extractPlainText({ buffer: Buffer.from('plain', 'utf8'), filename: 'no-extension', mimeType: 'text/plain' }), 'plain');
  // A .txt filename wins over an unhelpful octet-stream mime type.
  assert.equal(await extractPlainText({ buffer: Buffer.from('x', 'utf8'), filename: 'x.txt', mimeType: 'application/octet-stream' }), 'x');
  await assert.rejects(
    extractPlainText({ buffer: Buffer.from('x', 'utf8'), filename: 'x.bin' }),
    (error) => error instanceof UploadUnsupportedError && error.code === 'UPLOAD_UNSUPPORTED_TYPE',
  );
});

test('extractPlainText surfaces UploadUnsupportedError for a scanned pdf directly', async () => {
  await assert.rejects(
    extractPlainText({ buffer: Buffer.from('%PDF-1.4'), filename: 'scan.pdf', mimeType: 'application/pdf', execFile: async () => ({ stdout: '', stderr: '' }) }),
    (error) => error instanceof UploadUnsupportedError && error.code === 'PDF_TEXT_LAYER_REQUIRED',
  );
  await assert.rejects(
    extractPlainText({ buffer: Buffer.from('%PDF-1.4'), filename: 'scan.pdf', mimeType: 'application/pdf', execFile: async () => { throw new Error('missing'); } }),
    UploadUnsupportedError,
  );
});

test('docxXmlToText failure path throws UploadExtractionError', async () => {
  await assert.rejects(
    extractPlainText({
      buffer: Buffer.from('garbage'),
      filename: 'x.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      execFile: async () => { throw new Error('unzip failed'); },
    }),
    UploadExtractionError,
  );
});

test('chunkText prefers paragraph boundaries and packs greedily', () => {
  const text = 'First paragraph about fans.\n\nSecond paragraph about belts.\n\nThird short one.';
  const chunks = chunkText(text, { maxChars: 2_000, overlap: 0 });
  assert.equal(chunks.length, 1);
  assert.deepEqual(chunks[0], { index: 0, text, start: 0, end: text.length });

  // Two paragraphs fit in the budget, the third forces a new chunk.
  const p1 = 'alpha '.repeat(100); // 600 chars
  const p2 = 'beta '.repeat(100); // 600 chars
  const p3 = 'gamma '.repeat(100); // 600 chars
  const packed = chunkText(`${p1}\n\n${p2}\n\n${p3}`, { maxChars: 1_250, overlap: 0 });
  assert.equal(packed.length, 2);
  assert.ok(packed[0].text.includes('alpha') && packed[0].text.includes('beta'));
  assert.ok(packed[1].text.includes('gamma'));
  assert.ok(!packed[1].text.includes('alpha'));
});

test('chunkText applies overlap between consecutive chunks with consistent offsets', () => {
  const text = `${'a'.repeat(500)}\n\n${'b'.repeat(500)}`;
  const chunks = chunkText(text, { maxChars: 600, overlap: 100 });
  assert.equal(chunks.length, 2);
  for (const chunk of chunks) {
    assert.equal(chunk.text, text.slice(chunk.start, chunk.end));
    assert.ok(chunk.text.length <= 600);
  }
  assert.equal(chunks[1].start, chunks[0].end - 100);
  assert.ok(chunks[1].text.startsWith(chunks[0].text.slice(-100)));
  assert.equal(chunks[0].text, 'a'.repeat(500) + '\n\n');
  assert.equal(chunks[1].text, 'a'.repeat(98) + '\n\n' + 'b'.repeat(500));
});

test('chunkText sub-splits oversized paragraphs and stays within maxChars', () => {
  const long = 'word '.repeat(400); // 2000 chars, no paragraph breaks
  const chunks = chunkText(long, { maxChars: 600, overlap: 50 });
  assert.ok(chunks.length >= 3);
  for (const chunk of chunks) {
    assert.equal(chunk.text, long.slice(chunk.start, chunk.end));
    assert.ok(chunk.text.length <= 600);
  }
  // Chunks tile the text without gaps.
  assert.equal(chunks[0].start, 0);
  assert.equal(chunks.at(-1).end, long.length);
});

test('chunkText prefers sentence boundaries when splitting a long run', () => {
  const text = 'Alpha sentence one. Beta sentence two. Gamma sentence three. Delta sentence four.';
  const chunks = chunkText(text, { maxChars: 40, overlap: 0 });
  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) {
    assert.equal(chunk.text, text.slice(chunk.start, chunk.end));
    assert.ok(chunk.text.length <= 40);
  }
  assert.ok(chunks[0].text.endsWith('.'));
});

test('chunkText handles empty input and degenerate limits', () => {
  assert.deepEqual(chunkText(''), []);
  assert.deepEqual(chunkText('   \n\n  '), []);
  const chunks = chunkText('ab', { maxChars: 1, overlap: 0 });
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].text, 'a');
  assert.equal(chunks[1].text, 'b');
});

test('tokenize is lowercase and split on non-letter/number runs', () => {
  assert.deepEqual(tokenize('ZX-47 Door motor'), ['zx', '47', 'door', 'motor']);
  assert.deepEqual(tokenize('  Mixed CASE '), ['mixed', 'case']);
  assert.deepEqual(tokenize(''), []);
});

test('buildIndex maps terms to chunk indices and counts tokens', () => {
  const chunks = [
    { text: 'Fan belt tension' },
    { text: 'belt pulley alignment' },
    { text: 'Fan speed control' },
  ];
  const index = buildIndex(chunks);
  assert.ok(index.term_to_chunk instanceof Map);
  assert.deepEqual(index.term_to_chunk.get('fan'), [0, 2]);
  assert.deepEqual(index.term_to_chunk.get('belt'), [0, 1]);
  assert.deepEqual(index.term_to_chunk.get('pulley'), [1]);
  assert.equal(index.token_count, 9);
});

test('upload store round-trips records, buffers and chunks', async (t) => {
  const { store, baseDir } = await tmpStore('store');
  t.after(() => fs.rm(baseDir, { recursive: true, force: true }));
  const record = {
    upload_id: `upload_${'a'.repeat(24)}`,
    filename: 'a.txt',
    scope_id: 'SBS_BUS',
    size_bytes: 5,
    sha256: 'c'.repeat(64),
    status: UPLOAD_STATUS.READY,
    provenance: { uploaded_at: new Date().toISOString(), source: 's', uploader: 'u', scenario: 'sc' },
    errors: [],
    steps: [],
  };
  await store.put(record, Buffer.from('bytes'), [{ index: 0, text: 'hi', start: 0, end: 2 }]);

  assert.deepEqual(await store.get(record.upload_id), record);
  assert.equal((await store.getChunks(record.upload_id)).length, 1);
  assert.equal((await store.list({ scopeId: 'SBS_BUS' })).length, 1);
  assert.equal((await store.list({ scopeId: 'SBS_RAIL' })).length, 0);
  assert.equal((await store.list({})).length, 1);

  await assert.rejects(store.get(`upload_${'b'.repeat(24)}`), /not found/);
  await assert.rejects(store.get('not-an-id'), /Invalid upload_id/);
  assert.deepEqual(await store.getChunks(`upload_${'d'.repeat(24)}`), []);
  assert.deepEqual(await createUploadStore({ baseDir: path.join(baseDir, 'empty') }).list({}), []);
});

test('ingestDocument validates required inputs', async (t) => {
  const { store, baseDir } = await tmpStore('validate');
  t.after(() => fs.rm(baseDir, { recursive: true, force: true }));
  const buffer = Buffer.from('x', 'utf8');
  await assert.rejects(ingestDocument({ scopeId: '', filename: 'a.txt', buffer, metadata: METADATA, store }), TypeError);
  await assert.rejects(ingestDocument({ scopeId: 'SBS_BUS', filename: '', buffer, metadata: METADATA, store }), TypeError);
  await assert.rejects(ingestDocument({ scopeId: 'SBS_BUS', filename: 'a.txt', buffer, store }), TypeError);
});
