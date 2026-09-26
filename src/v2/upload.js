import { execFile as execFileCallback } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileDefault = promisify(execFileCallback);
const TEXT_PREVIEW_CHARS = 500;
const EXEC_MAX_BUFFER = 64 * 1024 * 1024;

/** Observable states of the Upload -> Processing -> Parsed/Chunked/Indexed -> READY state machine. */
export const UPLOAD_STATUS = Object.freeze({
  UPLOADED: 'UPLOADED',
  PROCESSING: 'PROCESSING',
  PARSED: 'PARSED',
  CHUNKED: 'CHUNKED',
  INDEXED: 'INDEXED',
  READY: 'READY',
  FAILED: 'FAILED',
});

/**
 * Raised when a document cannot be ingested: unsupported type, a PDF
 * without a text layer (scanned/image-only), or a missing/failing system
 * extractor (pdftotext). The message and code tell the caller which boundary
 * was hit; ingestDocument converts this into a FAILED record.
 */
export class UploadUnsupportedError extends Error {
  constructor(message, code = 'UPLOAD_UNSUPPORTED') {
    super(message);
    this.name = 'UploadUnsupportedError';
    this.code = code;
  }
}

/** Raised when a system extractor exists but fails mid-extraction (e.g. unzip on a corrupt docx). */
export class UploadExtractionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UploadExtractionError';
    this.code = 'UPLOAD_EXTRACTION_FAILED';
  }
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeUploadId(uploadId) {
  return /^upload_[a-f0-9]{24}$/.test(String(uploadId || '')) ? String(uploadId) : null;
}

/**
 * Filesystem-backed upload store: one JSON record, one raw-bytes file and
 * (when present) one chunk sidecar per upload under baseDir. fsModule can be
 * injected for tests.
 *
 * @param {{ baseDir?: string, fsModule?: object }} [options]
 */
export function createUploadStore({ baseDir, fsModule = fs } = {}) {
  if (!baseDir) throw new TypeError('Upload store baseDir is required.');
  const root = path.resolve(String(baseDir));
  const mod = fsModule || fs;
  const recordPath = (id) => path.join(root, `${id}.json`);
  const bufferPath = (id) => path.join(root, `${id}.bin`);
  const chunksPath = (id) => path.join(root, `${id}.chunks.json`);

  return Object.freeze({
    /**
     * Persists an upload record plus its raw bytes; optionally persists the
     * retrieval chunks (only written when the ingest reached READY, so a
     * FAILED document is never partially indexed).
     */
    async put(record, buffer, chunks = null) {
      const id = normalizeUploadId(record?.upload_id);
      if (!id) throw Object.assign(new Error('Invalid upload_id.'), { code: 'INVALID_UPLOAD_ID' });
      await mod.mkdir(root, { recursive: true });
      await mod.writeFile(recordPath(id), `${JSON.stringify(record, null, 2)}\n`);
      if (buffer != null) {
        await mod.writeFile(bufferPath(id), Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer));
      }
      if (Array.isArray(chunks)) {
        await mod.writeFile(chunksPath(id), `${JSON.stringify(chunks, null, 2)}\n`);
      }
      return Object.freeze({ ...record });
    },

    /** @returns {Promise<object>} the upload record */
    async get(uploadId) {
      const id = normalizeUploadId(uploadId);
      if (!id) throw Object.assign(new Error('Invalid upload_id.'), { code: 'INVALID_UPLOAD_ID' });
      try {
        return JSON.parse(await mod.readFile(recordPath(id), 'utf8'));
      } catch (error) {
        if (error?.code === 'ENOENT') {
          throw Object.assign(new Error('Upload record was not found.'), { code: 'UPLOAD_NOT_FOUND' });
        }
        throw error;
      }
    },

    /** @returns {Promise<Array<{ index: number, text: string, start: number, end: number }>>} */
    async getChunks(uploadId) {
      const id = normalizeUploadId(uploadId);
      if (!id) throw Object.assign(new Error('Invalid upload_id.'), { code: 'INVALID_UPLOAD_ID' });
      try {
        return JSON.parse(await mod.readFile(chunksPath(id), 'utf8'));
      } catch (error) {
        if (error?.code === 'ENOENT') return [];
        throw error;
      }
    },

    /**
     * Lists upload records, optionally filtered by scope_id. Deterministic
     * ordering by upload_id.
     *
     * @param {{ scopeId?: string }} [options]
     * @returns {Promise<object[]>}
     */
    async list({ scopeId } = {}) {
      let names;
      try {
        names = await mod.readdir(root);
      } catch (error) {
        if (error?.code === 'ENOENT') return [];
        throw error;
      }
      const records = [];
      for (const name of names) {
        if (!name.endsWith('.json') || name.endsWith('.chunks.json')) continue;
        try {
          records.push(JSON.parse(await mod.readFile(path.join(root, name), 'utf8')));
        } catch {
          // Corrupt sidecar; skip rather than failing the whole listing.
        }
      }
      const filtered = scopeId ? records.filter((record) => record.scope_id === scopeId) : records;
      return filtered.sort((a, b) => String(a.upload_id).localeCompare(String(b.upload_id)));
    },
  });
}

function resolveType({ filename, mimeType }) {
  const name = String(filename || '').toLowerCase();
  const mime = String(mimeType || '').toLowerCase();
  if (mime === 'text/plain' || mime === 'text/csv' || mime === 'text/markdown' || /\.(txt|csv|md)$/.test(name)) return 'text';
  if (mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' || name.endsWith('.docx')) return 'docx';
  if (mime === 'application/pdf' || name.endsWith('.pdf')) return 'pdf';
  return null;
}

function decodeXmlEntities(value) {
  return value
    .replace(/&#(\d+);/g, (_, digits) => String.fromCodePoint(Number(digits)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function docxXmlToText(xml) {
  let out = String(xml);
  out = out.replace(/<\/w:p>/g, '\n');
  out = out.replace(/<[^>]+>/g, '');
  out = decodeXmlEntities(out);
  out = out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n');
  return out.trim();
}

async function withTempFile(bytes, extension, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'v2-upload-'));
  const file = path.join(dir, `document.${extension}`);
  try {
    await fs.writeFile(file, bytes);
    return await fn(file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

/**
 * Default document-to-text extractor. txt/csv/md are decoded as UTF-8;
 * docx uses system `unzip -p <file> word/document.xml` then strips XML;
 * pdf uses system `pdftotext <file> -`. execFile may be injected for tests
 * (signature: (command, args, options) => Promise<{ stdout, stderr }>).
 *
 * A PDF without a usable text layer (scanned/image-only) or a missing
 * pdftotext binary throws UploadUnsupportedError explaining that OCR is
 * future scope; unsupported types throw UploadUnsupportedError as well.
 *
 * @param {{ buffer: Buffer, filename: string, mimeType?: string, execFile?: Function }} params
 * @returns {Promise<string>}
 */
export async function extractPlainText({ buffer, filename, mimeType, execFile = execFileDefault }) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  const type = resolveType({ filename, mimeType });
  const run = typeof execFile === 'function' ? execFile : execFileDefault;

  if (type === 'text') {
    return bytes.toString('utf8').replace(/^\uFEFF/, '');
  }

  if (type === 'docx') {
    return withTempFile(bytes, 'docx', async (file) => {
      let stdout = '';
      try {
        ({ stdout } = await run('unzip', ['-p', file, 'word/document.xml'], { maxBuffer: EXEC_MAX_BUFFER }));
      } catch (error) {
        throw new UploadExtractionError(`Failed to extract text from DOCX "${filename}": ${error?.message || error}`);
      }
      return docxXmlToText(stdout);
    });
  }

  if (type === 'pdf') {
    return withTempFile(bytes, 'pdf', async (file) => {
      let stdout = '';
      try {
        ({ stdout } = await run('pdftotext', [file, '-'], { maxBuffer: EXEC_MAX_BUFFER }));
      } catch (error) {
        throw new UploadUnsupportedError(
          `PDF "${filename}" cannot be parsed on this system (pdftotext missing or failed: ${error?.message || error}). ` +
          'Scanned/image-only PDFs require OCR, which is future scope.',
          'PDF_TEXT_LAYER_REQUIRED',
        );
      }
      const text = String(stdout || '');
      if (!text.trim()) {
        throw new UploadUnsupportedError(
          `PDF "${filename}" has no extractable text layer; scanned/image-only PDFs require OCR, which is future scope.`,
          'PDF_TEXT_LAYER_REQUIRED',
        );
      }
      return text;
    });
  }

  throw new UploadUnsupportedError(
    `Unsupported upload type for "${filename}"${mimeType ? ` (${mimeType})` : ''}. ` +
    'Supported types: txt, csv, md, docx, pdf.',
    'UPLOAD_UNSUPPORTED_TYPE',
  );
}

function splitParagraphs(source) {
  const ranges = [];
  let start = 0;
  const re = /\n{2,}/g;
  let match;
  while ((match = re.exec(source)) !== null) {
    ranges.push({ start, end: match.index + match[0].length });
    start = match.index + match[0].length;
  }
  ranges.push({ start, end: source.length });
  return ranges.filter((range) => source.slice(range.start, range.end).trim() !== '');
}

function splitLongRange(source, group, pieceBudget) {
  const pieces = [];
  let segStart = group.start;
  while (segStart < group.end) {
    const windowEnd = Math.min(segStart + pieceBudget, group.end);
    const window = source.slice(segStart, windowEnd);
    let lastBreak = -1;
    const re = /[。！？!?；;，,.\n]/g;
    let match;
    while ((match = re.exec(window)) !== null) lastBreak = match.index + 1;
    const cut = lastBreak > 0 ? lastBreak : windowEnd - segStart;
    const end = Math.min(segStart + cut, group.end);
    if (end <= segStart) break;
    pieces.push({ start: segStart, end });
    segStart = end;
  }
  return pieces;
}

/**
 * Splits plain text into overlapping chunks, preferring paragraph
 * boundaries: paragraphs are packed greedily up to maxChars, and only a
 * paragraph that alone exceeds maxChars is sub-split (at sentence
 * punctuation, falling back to a hard cut). Every chunk after the first
 * re-includes the previous chunk's trailing `overlap` characters so each
 * chunk text stays <= maxChars.
 *
 * @param {string} text
 * @param {{ maxChars?: number, overlap?: number }} [options]
 * @returns {Array<{ index: number, text: string, start: number, end: number }>}
 */
export function chunkText(text, { maxChars = 1200, overlap = 100 } = {}) {
  const source = String(text ?? '');
  const maxCharsN = Math.max(1, Math.floor(maxChars));
  const overlapN = Math.min(Math.max(0, Math.floor(overlap)), maxCharsN - 1);
  if (!source.trim()) return [];
  const pieceBudget = Math.max(1, maxCharsN - overlapN);

  const paragraphs = splitParagraphs(source);
  const groups = [];
  let current = null;
  for (const paragraph of paragraphs) {
    if (current === null) {
      current = { start: paragraph.start, end: paragraph.end };
      continue;
    }
    const budget = groups.length === 0 ? maxCharsN : pieceBudget;
    if (current.end - current.start + (paragraph.end - paragraph.start) <= budget) {
      current.end = paragraph.end;
    } else {
      groups.push(current);
      current = { start: paragraph.start, end: paragraph.end };
    }
  }
  if (current !== null) groups.push(current);

  const raw = [];
  for (const group of groups) {
    if (group.end - group.start <= maxCharsN) {
      raw.push(group);
    } else {
      raw.push(...splitLongRange(source, group, pieceBudget));
    }
  }

  const chunks = [];
  for (let i = 0; i < raw.length; i += 1) {
    if (i === 0) {
      chunks.push({ index: 0, text: source.slice(raw[0].start, raw[0].end), start: raw[0].start, end: raw[0].end });
      continue;
    }
    const effectiveOverlap = Math.min(overlapN, raw[i - 1].end - raw[i - 1].start);
    const start = raw[i - 1].end - effectiveOverlap;
    chunks.push({ index: i, text: source.slice(start, raw[i].end), start, end: raw[i].end });
  }
  return chunks;
}

/**
 * Simple dependency-free tokenizer: lowercase, split on any run of
 * non-letter/non-number characters (Unicode-aware). Used by buildIndex and
 * by scope-gated retrieval scoring.
 *
 * @param {string} value
 * @returns {string[]}
 */
export function tokenize(value) {
  const tokens = [];
  const source = String(value ?? '').toLowerCase();
  // Preserve decimal measurement tokens before punctuation splitting. This
  // distinguishes nearby standards paragraphs containing 0.8 m / 0.85 from
  // unrelated paragraphs that merely contain many other numbers.
  for (const match of source.matchAll(/\d+(?:[.,]\d+)?\s*(?:kv|mm|km|cm|m|%|bar|kpa|mpa|°c|℃|千米|公里|毫米|厘米|米)/giu)) {
    tokens.push(match[0]
      .replace(/\s+/g, '')
      .replace(/千米|公里/gu, 'km')
      .replace(/毫米/gu, 'mm')
      .replace(/厘米/gu, 'cm')
      .replace(/米/gu, 'm')
      .replace(/℃/gu, '°c'));
  }
  const runs = source.match(/[\p{Script=Han}]+|[\p{L}\p{N}]+/gu) || [];
  for (const run of runs) {
    if (!/^[\p{Script=Han}]+$/u.test(run)) {
      tokens.push(run);
      continue;
    }
    // Chinese text has no whitespace word boundaries. Retain the full run
    // and add character bigrams so a short dictated phrase can match the
    // same phrase inside a much longer standards paragraph.
    tokens.push(run);
    if (run.length > 1) {
      for (let index = 0; index < run.length - 1; index += 1) {
        tokens.push(run.slice(index, index + 2));
      }
    }
  }
  return tokens;
}

/**
 * Builds a lightweight inverted index over chunks: token_count is the total
 * number of (term, chunk) pairs and term_to_chunk maps each term to the
 * ascending chunk indices that contain it.
 *
 * @param {Array<{ text: string }>} chunks
 * @returns {{ token_count: number, term_to_chunk: Map<string, number[]> }}
 */
export function buildIndex(chunks) {
  const termToChunk = new Map();
  let tokenCount = 0;
  chunks.forEach((chunk, chunkIndex) => {
    const terms = new Set(tokenize(chunk?.text ?? ''));
    tokenCount += terms.size;
    for (const term of terms) {
      if (!termToChunk.has(term)) termToChunk.set(term, []);
      termToChunk.get(term).push(chunkIndex);
    }
  });
  return { token_count: tokenCount, term_to_chunk: termToChunk };
}

function bounded(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

function toErrorEntry({ step, error }) {
  return {
    step,
    code: error?.code || 'UPLOAD_PROCESSING_FAILED',
    message: String(error?.message || error || 'Upload processing failed.').slice(0, 1000),
  };
}

/**
 * Runs the UPLOADED -> PROCESSING -> PARSED -> CHUNKED -> INDEXED -> READY
 * state machine for one document. Any step failure leaves the record as
 * FAILED with errors[] (chunks are persisted only on READY, so a failed
 * document is never partially indexed). The returned record carries
 * provenance + scenario metadata per the V2 upload contract §6.3.
 *
 * @param {{ scopeId: string, filename: string, buffer: Buffer, mimeType?: string, metadata: { uploader: string, source: string, scenario: string }, store: object, execFile?: Function }} params
 * @returns {Promise<object>} the persisted upload record
 */
export async function ingestDocument({ scopeId, filename, buffer, mimeType, metadata, store, execFile }) {
  const scope = bounded(scopeId, 80);
  const name = bounded(filename, 300);
  if (!scope) throw new TypeError('ingestDocument requires a non-empty scopeId.');
  if (!name) throw new TypeError('ingestDocument requires a filename.');
  if (!metadata || typeof metadata !== 'object') throw new TypeError('ingestDocument requires a metadata object with uploader, source and scenario.');
  if (!store || typeof store.put !== 'function') throw new TypeError('ingestDocument requires an upload store with put().');

  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  const digest = sha256Hex(bytes);
  const reportSessionId = bounded(metadata.report_session_id, 160);
  const uploadId = `upload_${sha256Hex(`${scope}\n${reportSessionId}\n${digest}`).slice(0, 24)}`;
  const uploadedAt = new Date().toISOString();
  const steps = [];
  const errors = [];
  const pushStep = (status, detail = {}) => {
    steps.push({ status, at: new Date().toISOString(), ...detail });
  };

  const record = {
    upload_id: uploadId,
    filename: name,
    scope_id: scope,
    size_bytes: bytes.length,
    sha256: digest,
    status: UPLOAD_STATUS.UPLOADED,
    parsed: null,
    chunk_count: 0,
    indexed: null,
    provenance: {
      uploaded_at: uploadedAt,
      source: bounded(metadata.source, 300),
      uploader: bounded(metadata.uploader, 200),
      scenario: bounded(metadata.scenario, 200),
      ...(reportSessionId ? { report_session_id: reportSessionId } : {}),
    },
    document_version: `sha256:${digest}`,
    errors: [],
    steps: [],
  };

  pushStep(UPLOAD_STATUS.UPLOADED);
  record.status = UPLOAD_STATUS.PROCESSING;
  pushStep(UPLOAD_STATUS.PROCESSING);

  try {
    const text = await extractPlainText({ buffer: bytes, filename: name, mimeType, execFile });
    record.parsed = { char_count: text.length, text_preview: text.slice(0, TEXT_PREVIEW_CHARS) };
    pushStep(UPLOAD_STATUS.PARSED, { char_count: text.length });

    const chunks = chunkText(text);
    record.chunk_count = chunks.length;
    pushStep(UPLOAD_STATUS.CHUNKED, { chunk_count: chunks.length });

    const index = buildIndex(chunks);
    record.indexed = { token_count: index.token_count };
    pushStep(UPLOAD_STATUS.INDEXED, { token_count: index.token_count });

    record.status = UPLOAD_STATUS.READY;
    pushStep(UPLOAD_STATUS.READY);
    record.steps = steps;
    await store.put(record, bytes, chunks);
    return Object.freeze({ ...record, steps: steps.map((step) => Object.freeze(step)) });
  } catch (error) {
    record.status = UPLOAD_STATUS.FAILED;
    const entry = toErrorEntry({ step: record.steps.at(-1)?.status || UPLOAD_STATUS.PROCESSING, error });
    errors.push(entry);
    record.errors = errors;
    pushStep(UPLOAD_STATUS.FAILED, { failed_at: entry.step, code: entry.code, message: entry.message });
    record.steps = steps;
    await store.put(record, bytes, null);
    return Object.freeze({ ...record, steps: steps.map((step) => Object.freeze(step)), errors: errors.map((item) => Object.freeze(item)) });
  }
}
