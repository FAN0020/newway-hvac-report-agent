import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const FIELD_LABELS = Object.freeze({
  'work.date_time': /^(?:date\s*(?:\/|and)\s*time|job\s*date|work\s*date)\s*[:：]\s*(.+)$/iu,
  'asset.internal_fleet_no': /^(?:bus\s*(?:\/|or)?\s*fleet\s*(?:id|no\.?|number)|fleet\s*(?:id|no\.?|number)|vehicle\s*id)\s*[:：]\s*(.+)$/iu,
  'asset.registration_no': /^(?:registration\s*(?:no\.?|number)|vehicle\s*registration)\s*[:：]\s*(.+)$/iu,
  'asset.bus_model': /^(?:bus\s*model|make\s*(?:\/|and)\s*model|vehicle\s*model)\s*[:：]\s*(.+)$/iu,
  'asset.depot': /^(?:depot|location)\s*[:：]\s*(.+)$/iu,
  'work.trigger': /^(?:reported\s*(?:defect|fault)|job\s*request|complaint|work\s*description)\s*[:：]\s*(.+)$/iu,
});
const ORDER_RE = /^(?:work\s*order\s*(?:no\.?|number|id)?|wo\s*(?:no\.?|number|id)?)\s*[:：]\s*(.+)$/iu;
const VEHICLE_RE = /^(?:stable\s*vehicle\s*id|vehicle\s*id|bus\s*(?:\/|or)?\s*fleet\s*(?:id|no\.?|number)|fleet\s*(?:id|no\.?|number))\s*[:：]\s*(.+)$/iu;

function failure(message, code, status = 400) { return Object.assign(new Error(message), { code, status }); }
function cleanIdentity(value, label) {
  const result = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{1,79}$/u.test(result)) throw failure(`${label} must be a stable identifier.`, 'INVALID_WORK_ORDER_IDENTITY');
  return result;
}
function sha(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }
function safeName(value) { return path.basename(String(value || 'work-order')).replace(/[\x00-\x1f]/gu, '').slice(0, 180); }
async function writeJson(file, value) {
  const temp = `${file}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temp, file);
}
async function documentText(filename, bytes) {
  const extension = path.extname(filename).toLowerCase();
  if (extension === '.txt' || extension === '.csv' || extension === '.md') {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.includes('\0')) throw failure('This file is not readable text.', 'WORK_ORDER_UNPARSEABLE', 422);
    return text;
  }
  if (extension === '.docx') {
    if (bytes.subarray(0, 2).toString('ascii') !== 'PK') throw failure('This DOCX is invalid.', 'WORK_ORDER_UNPARSEABLE', 422);
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'servicescribe-wo-'));
    const file = path.join(directory, 'source.docx');
    try {
      await fs.writeFile(file, bytes);
      const { stdout } = await execFileAsync('unzip', ['-p', file, 'word/document.xml'], { maxBuffer: 4 * 1024 * 1024 });
      return stdout.replace(/<\/w:p>/gu, '\n').replace(/<w:tab[^>]*\/>/gu, '\t')
        .replace(/<[^>]+>/gu, '').replace(/&(?:amp|lt|gt|quot|apos);/gu, (entity) => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" })[entity]);
    } catch { throw failure('The DOCX text could not be extracted. Review the source manually.', 'WORK_ORDER_UNPARSEABLE', 422); }
    finally { await fs.rm(directory, { recursive: true, force: true }); }
  }
  throw failure('Supported work-order formats are TXT, CSV, MD and text DOCX.', 'WORK_ORDER_UNSUPPORTED_FORMAT', 415);
}

function candidatesFrom(text) {
  const lines = text.split(/\r?\n/u).map((line) => line.trim()).filter(Boolean).map((line) => {
    const csv = /^\s*"?([^",]+)"?\s*,\s*"?([^"\r\n]+)"?\s*$/u.exec(line);
    return csv ? `${csv[1].trim()}: ${csv[2].trim()}` : line;
  });
  const candidates = { work_order_id: [], vehicle_id: [], fields: [] };
  for (const line of lines) {
    const order = ORDER_RE.exec(line);
    const vehicle = VEHICLE_RE.exec(line);
    if (order) candidates.work_order_id.push({ value: order[1].trim(), source: line });
    if (vehicle) candidates.vehicle_id.push({ value: vehicle[1].trim(), source: line });
    for (const [fieldId, pattern] of Object.entries(FIELD_LABELS)) {
      const match = pattern.exec(line);
      if (match) candidates.fields.push({ field_id: fieldId, value: match[1].trim(), source: line });
    }
  }
  return candidates;
}

export class WorkOrderStore {
  constructor({ root, clock = () => new Date().toISOString() } = {}) {
    if (!root) throw new TypeError('WorkOrderStore root is required.');
    this.root = path.resolve(root);
    this.clock = clock;
    this.lock = Promise.resolve();
  }
  async locked(action) {
    const previous = this.lock;
    let release;
    this.lock = new Promise((resolve) => { release = resolve; });
    await previous;
    try { return await action(); } finally { release(); }
  }
  file(id) { return path.join(this.root, 'records', `${id}.json`); }
  async records() {
    await fs.mkdir(path.join(this.root, 'records'), { recursive: true });
    const names = (await fs.readdir(path.join(this.root, 'records'))).filter((name) => name.endsWith('.json'));
    return Promise.all(names.map(async (name) => JSON.parse(await fs.readFile(path.join(this.root, 'records', name), 'utf8'))));
  }
  async get(uploadId) {
    if (!/^wo_[a-f0-9-]{36}$/u.test(String(uploadId))) throw failure('Work-order upload id is invalid.', 'INVALID_WORK_ORDER_ID');
    try { return JSON.parse(await fs.readFile(this.file(uploadId), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') throw failure('Work order was not found.', 'WORK_ORDER_NOT_FOUND', 404); throw error; }
  }
  async list() {
    return (await this.records()).sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at));
  }
  async upload({ filename, mime_type: mimeType, bytes, uploaded_by: uploadedBy = 'authenticated-user' }) {
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 10 * 1024 * 1024) throw failure('Work-order file must be 1 byte to 10 MB.', 'INVALID_WORK_ORDER_FILE');
    const name = safeName(filename);
    const text = await documentText(name, bytes);
    if (!text.trim()) throw failure('No readable work-order text was found.', 'WORK_ORDER_UNPARSEABLE', 422);
    const hash = sha(bytes);
    return this.locked(async () => {
      if ((await this.records()).some((record) => record.source.sha256 === hash)) throw failure('This exact file was already uploaded.', 'WORK_ORDER_DUPLICATE_UPLOAD', 409);
      const uploadId = `wo_${crypto.randomUUID()}`;
      await fs.mkdir(path.join(this.root, 'sources'), { recursive: true });
      const sourceFile = path.join(this.root, 'sources', `${hash}${path.extname(name).toLowerCase()}`);
      await fs.writeFile(sourceFile, bytes, { flag: 'wx', mode: 0o600 }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
      const record = { contract: 'WorkOrder', contract_version: '1', upload_id: uploadId, status: 'PENDING_REVIEW', uploaded_at: this.clock(), uploaded_by: uploadedBy,
        source: { filename: name, mime_type: String(mimeType || 'application/octet-stream'), sha256: hash, size: bytes.length, storage_ref: `work-order-source:${hash}` },
        candidates: candidatesFrom(text), reviewed: null, version: null };
      await writeJson(this.file(uploadId), record);
      return record;
    });
  }
  async review(uploadId, { work_order_id: orderInput, vehicle_id: vehicleInput, field_ids: fieldIds = [], correction_reason: correctionReason, reviewed_by: reviewedBy = 'authenticated-user' } = {}) {
    return this.locked(async () => {
      const record = await this.get(uploadId);
      if (record.status !== 'PENDING_REVIEW') throw failure('This work order has already been reviewed.', 'WORK_ORDER_ALREADY_REVIEWED', 409);
      const orderId = cleanIdentity(orderInput, 'Work-order ID');
      const vehicleId = cleanIdentity(vehicleInput, 'Vehicle ID');
      const candidateOrder = record.candidates.work_order_id.map((item) => item.value);
      const candidateVehicle = record.candidates.vehicle_id.map((item) => item.value);
      const changed = !candidateOrder.includes(orderId) || !candidateVehicle.includes(vehicleId);
      if (changed && !String(correctionReason || '').trim()) throw failure('Corrected identity requires a review reason.', 'WORK_ORDER_CORRECTION_REASON_REQUIRED', 409);
      const all = await this.records();
      const earlier = all.filter((item) => item.status === 'REVIEWED' && item.reviewed.work_order_id === orderId);
      if (earlier.some((item) => item.reviewed.vehicle_id !== vehicleId)) throw failure('This work-order ID is already bound to another vehicle. Resolve the identity conflict before use.', 'WORK_ORDER_VEHICLE_CONFLICT', 409);
      const selected = new Set(fieldIds);
      if (!Array.isArray(fieldIds) || fieldIds.some((id) => typeof id !== 'string')) throw failure('Selected fields are invalid.', 'INVALID_WORK_ORDER_FIELDS');
      const fields = record.candidates.fields.filter((item) => selected.has(item.field_id));
      if (selected.size !== new Set(fields.map((item) => item.field_id)).size || new Set(fields.map((item) => item.field_id)).size !== fields.length) throw failure('Selected fields must identify one candidate each.', 'INVALID_WORK_ORDER_FIELDS');
      const version = Math.max(0, ...earlier.map((item) => item.version || 0)) + 1;
      const reviewed = { work_order_id: orderId, vehicle_id: vehicleId, fields, reviewed_at: this.clock(), reviewed_by: reviewedBy, correction_reason: String(correctionReason || '').trim() || null };
      const next = { ...record, status: 'REVIEWED', version, reviewed,
        review_sha256: sha(Buffer.from(JSON.stringify({ source_sha256: record.source.sha256, version, reviewed }))) };
      await writeJson(this.file(uploadId), next);
      return next;
    });
  }
  async resolve({ job_context_ref: reference, template }) {
    if (!reference || String(reference).startsWith('new-report:')) return null;
    const match = /^work-order:(wo_[a-f0-9-]{36})@([1-9]\d*)$/u.exec(String(reference));
    if (!match) throw failure('Select a reviewed work-order version.', 'INVALID_WORK_ORDER_REFERENCE', 409);
    const record = await this.get(match[1]);
    if (record.status !== 'REVIEWED' || record.version !== Number(match[2])) throw failure('Work-order version is not reviewed or no longer matches.', 'WORK_ORDER_NOT_REVIEWED', 409);
    const reviewHash = sha(Buffer.from(JSON.stringify({ source_sha256: record.source.sha256, version: record.version, reviewed: record.reviewed })));
    if (reviewHash !== record.review_sha256) throw failure('Work-order review hash changed.', 'WORK_ORDER_REVIEW_CHANGED', 409);
    let sourceBytes;
    try { sourceBytes = await fs.readFile(path.join(this.root, 'sources', `${record.source.sha256}${path.extname(record.source.filename).toLowerCase()}`)); }
    catch { throw failure('Work-order source is missing.', 'WORK_ORDER_SOURCE_MISSING', 409); }
    const currentHash = sha(sourceBytes);
    if (currentHash !== record.source.sha256) throw failure('Work-order source hash changed.', 'WORK_ORDER_SOURCE_CHANGED', 409);
    const fields = [
      ...record.reviewed.fields.filter((item) => !['work.work_order_id', 'work.order_id', 'work_order', 'asset.internal_fleet_no', 'vehicle_id'].includes(item.field_id)),
      { field_id: template.schema.fields.find((field) => ['work.work_order_id', 'work.order_id', 'work_order'].includes(field.id))?.id, value: record.reviewed.work_order_id },
      { field_id: template.schema.fields.find((field) => ['asset.internal_fleet_no', 'vehicle_id'].includes(field.id))?.id, value: record.reviewed.vehicle_id },
    ].filter((item) => {
      if (!item.field_id || !/^(?:work\.(?:work_order_id|order_id|date_time|trigger)|work_order|asset\.(?:internal_fleet_no|registration_no|bus_model|depot))$/u.test(item.field_id)) return false;
      const definition = template.schema.fields.find((field) => field.id === item.field_id);
      const allowed = definition?.allowedSources || definition?.allowed_sources;
      return Boolean(definition) && (!Array.isArray(allowed) || allowed.includes('WORK_ORDER'));
    });
    return { record_id: reference, version: String(record.version), vehicle_id: record.reviewed.vehicle_id,
      source_sha256: record.source.sha256, review_sha256: record.review_sha256,
      fields: [...new Map(fields.map((item) => [item.field_id, { field_id: item.field_id, value: item.value }])).values()] };
  }
}
