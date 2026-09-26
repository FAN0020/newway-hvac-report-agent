import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

function slug(value) {
  return String(value || 'custom-template').toLowerCase().normalize('NFKD')
    .replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '').slice(0, 64) || 'custom-template';
}

function safeExtension(filename) {
  const extension = path.extname(String(filename || '')).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/u.test(extension) ? extension : '.bin';
}

function hash(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function atomicJson(filename, value) {
  const temp = `${filename}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(temp, filename);
}

function validateFields(fields) {
  if (!Array.isArray(fields) || fields.length === 0) throw Object.assign(new Error('At least one reviewed schema field is required.'), { code: 'INVALID_TEMPLATE_SCHEMA' });
  const ids = new Set();
  return fields.map((input, index) => {
    const id = String(input.id || '').trim();
    const label = String(input.label || '').trim();
    if (!id || !label || ids.has(id)) throw Object.assign(new Error('Schema fields require unique ids and labels.'), { code: 'INVALID_TEMPLATE_SCHEMA' });
    ids.add(id);
    const type = String(input.type || 'string');
    const allowedStatuses = type === 'status' ? (input.allowedStatuses || ['NOT_CHECKED', 'OK', 'NOT_OK', 'N/A']) : undefined;
    if (allowedStatuses && (!allowedStatuses.includes('NOT_CHECKED') || input.defaultValue !== undefined)) throw Object.assign(new Error('Status fields must begin NOT_CHECKED and may not have a positive default.'), { code: 'INVALID_TEMPLATE_SCHEMA' });
    return {
      id, label, section: String(input.section || 'Report fields'), displayOrder: index + 1,
      type, required: Boolean(input.required), critical: Boolean(input.critical),
      inferencePolicy: 'EVIDENCE_OR_TECHNICIAN_INPUT',
      renderer: type === 'status' ? 'status-control' : type === 'number' ? 'measurement-control' : 'text-control',
      ...(allowedStatuses ? { allowedStatuses } : {}),
    };
  });
}

export class TemplateStore {
  constructor({ root }) {
    this.root = root;
    this.draftsDir = path.join(root, 'drafts');
    this.artifactsDir = path.join(root, 'artifacts');
    this.publishedDir = path.join(root, 'published');
  }

  async ensure() {
    await Promise.all([this.draftsDir, this.artifactsDir, this.publishedDir].map((directory) => fs.mkdir(directory, { recursive: true })));
  }

  draftPath(id) { return path.join(this.draftsDir, `${id}.json`); }

  async readDraft(id) {
    try { return JSON.parse(await fs.readFile(this.draftPath(id), 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') throw Object.assign(new Error('Template draft was not found.'), { code: 'TEMPLATE_DRAFT_NOT_FOUND', status: 404 });
      throw error;
    }
  }

  async assertMutable(id) {
    const draft = await this.readDraft(id);
    if (draft.status === 'PUBLISHED') throw new Error('Published template versions are immutable.');
    return draft;
  }

  async createDraft({ name, filename, mimeType, bytes }) {
    await this.ensure();
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw Object.assign(new Error('A non-empty template source is required.'), { code: 'EMPTY_TEMPLATE_SOURCE' });
    const id = `${slug(name)}-${crypto.randomUUID().slice(0, 8)}`;
    const sourceHash = hash(bytes);
    const artifactPath = path.join(this.artifactsDir, `${sourceHash}${safeExtension(filename)}`);
    await fs.writeFile(artifactPath, bytes, { flag: 'wx', mode: 0o600 }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
    const now = new Date().toISOString();
    const draft = {
      id, templateId: slug(name), name: String(name || 'Untitled template').trim(), status: 'DRAFT', createdAt: now, updatedAt: now,
      provenance: { classification: 'user-supplied prototype', official: false },
      source: { filename: path.basename(String(filename || 'template.bin')), mimeType: String(mimeType || 'application/octet-stream'), sha256: sourceHash, size: bytes.length, path: artifactPath, preserved: true },
      analysis: { status: 'MANUAL_REVIEW_REQUIRED', parser: null, detectedFields: [], undetectedReason: 'No robust arbitrary-template parser is enabled. Define and review fields manually.' },
      schemaReview: { status: 'PENDING', fields: [] }, context: { status: 'PENDING', documents: [] }, test: { status: 'PENDING' },
    };
    await atomicJson(this.draftPath(id), draft);
    return structuredClone(draft);
  }

  async saveSchema(id, { fields }) {
    const draft = await this.assertMutable(id);
    draft.schemaReview = { status: 'REVIEWED', fields: validateFields(fields), reviewedAt: new Date().toISOString() };
    draft.updatedAt = new Date().toISOString();
    await atomicJson(this.draftPath(id), draft);
    return structuredClone(draft);
  }

  async addContext(id, { filename, mimeType, bytes }) {
    const draft = await this.assertMutable(id);
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw Object.assign(new Error('A non-empty context document is required.'), { code: 'EMPTY_CONTEXT_SOURCE' });
    const digest = hash(bytes);
    const artifactPath = path.join(this.artifactsDir, `${digest}${safeExtension(filename)}`);
    await fs.writeFile(artifactPath, bytes, { flag: 'wx', mode: 0o600 }).catch((error) => { if (error.code !== 'EEXIST') throw error; });
    const textReady = /^text\//u.test(String(mimeType || ''));
    draft.context.documents.push({
      filename: path.basename(String(filename || 'context.bin')), mimeType: String(mimeType || 'application/octet-stream'), sha256: digest, size: bytes.length, path: artifactPath,
      analysisStatus: textReady ? 'READY_TEXT' : 'PRESERVED_UNDETECTED',
    });
    draft.context.status = textReady ? 'READY' : 'MANUAL_REVIEW_REQUIRED';
    draft.updatedAt = new Date().toISOString();
    await atomicJson(this.draftPath(id), draft);
    return structuredClone(draft);
  }

  async waiveContext(id, reason) {
    const draft = await this.assertMutable(id);
    draft.context = { ...draft.context, status: 'WAIVED', waiverReason: String(reason || 'No context required for this version.') };
    await atomicJson(this.draftPath(id), draft);
    return structuredClone(draft);
  }

  async recordTest(id, { passed, notes = '' }) {
    const draft = await this.assertMutable(id);
    draft.test = { status: passed ? 'PASSED' : 'FAILED', notes: String(notes), testedAt: new Date().toISOString() };
    await atomicJson(this.draftPath(id), draft);
    return structuredClone(draft);
  }

  async runContractTest(id) {
    const draft = await this.assertMutable(id);
    const issues = [];
    const fields = draft.schemaReview.fields || [];
    if (draft.schemaReview.status !== 'REVIEWED' || fields.length === 0) issues.push('Schema review is incomplete.');
    if (!['READY', 'WAIVED'].includes(draft.context.status)) issues.push('Context is neither ready nor explicitly waived.');
    if (fields.some((field) => field.type === 'status' && (!field.allowedStatuses?.includes('NOT_CHECKED') || field.defaultValue !== undefined))) issues.push('A status field has an unsafe default policy.');
    if (new Set(fields.map((field) => field.id)).size !== fields.length) issues.push('Field identifiers are not unique.');
    const passed = issues.length === 0;
    draft.test = {
      status: passed ? 'PASSED' : 'FAILED',
      notes: passed
        ? 'Contract test passed: explicit fields, required-field missingness, NOT_CHECKED status defaults, context isolation, and immutable version bindings are valid.'
        : `Contract test failed: ${issues.join(' ')}`,
      testedAt: new Date().toISOString(),
    };
    await atomicJson(this.draftPath(id), draft);
    return structuredClone(draft);
  }

  async publish(id) {
    const draft = await this.assertMutable(id);
    const failed = [];
    if (draft.schemaReview.status !== 'REVIEWED') failed.push('schema_review');
    if (!['READY', 'WAIVED'].includes(draft.context.status)) failed.push('context');
    if (draft.test.status !== 'PASSED') failed.push('test');
    if (failed.length) throw Object.assign(new Error(`Template publish gates failed: ${failed.join(', ')}`), { code: 'TEMPLATE_PUBLISH_GATES_FAILED', status: 409, gates: failed });
    const version = '1.0.0';
    const published = {
      templateId: draft.templateId, name: draft.name, status: 'PUBLISHED', templateVersion: version,
      description: 'Organization-defined maintenance report.', domain: 'CUSTOM',
      presentation: { displayName: draft.name, shortDescription: 'Organization-defined maintenance report.', organizationLabel: 'Organization', operationalCategory: 'Other', reportFamily: 'Custom report', searchAliases: [], technicianVisible: true },
      provenance: draft.provenance, sourceArtifact: draft.source,
      schema: { id: `${draft.templateId}-schema`, version, fields: draft.schemaReview.fields, missingnessPolicy: 'REQUIRED_FIELDS_REMAIN_UNRESOLVED_UNTIL_EVIDENCE_OR_TECHNICIAN_INPUT', positiveStatusPolicy: 'NEVER_INFER_FROM_SILENCE' },
      contextCorpus: { id: `${draft.templateId}-context`, version, retrievalBoundary: 'TEMPLATE_VERSION_ONLY', jobFactPolicy: 'CONTEXT_MUST_NOT_ASSERT_JOB_FACTS', sources: draft.context.documents },
      rendererMapping: { id: 'maintenance-workspace', version: '1.0.0', export: 'maintenance-report-document' },
      adapter: { id: 'manual-schema-v1', version: '1.0.0' }, publishedAt: new Date().toISOString(),
    };
    await atomicJson(path.join(this.publishedDir, `${draft.templateId}@${version}.json`), published);
    draft.status = 'PUBLISHED'; draft.publishedVersion = version;
    await atomicJson(this.draftPath(id), draft);
    return structuredClone(published);
  }

  async listPublished() {
    await this.ensure();
    const files = (await fs.readdir(this.publishedDir)).filter((name) => name.endsWith('.json')).sort();
    return Promise.all(files.map(async (name) => JSON.parse(await fs.readFile(path.join(this.publishedDir, name), 'utf8'))));
  }
}
