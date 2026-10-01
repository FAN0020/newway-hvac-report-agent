import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { decodeTemplateText } from '../templates/field-proposals.js';

const SOURCES = new Set(['TECHNICIAN', 'WORK_ORDER', 'KNOWLEDGE']);
const NORMATIVE_FIELD_ID = /^(?:standard|reference|terminology|procedure)\.[a-z0-9_.-]+$/u;
const TYPES = new Set(['string', 'text', 'number', 'measurement', 'boolean', 'status', 'structured']);
const invalidSchema = (message) => Object.assign(new Error(message), { code: 'INVALID_TEMPLATE_SCHEMA', status: 400 });

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

async function createImmutableJson(filename, value) {
  const temp = `${filename}.${crypto.randomUUID()}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    await fs.link(temp, filename);
  } catch (error) {
    if (error.code === 'EEXIST') throw Object.assign(new Error('A published version already exists for this template id.'), { code: 'TEMPLATE_VERSION_EXISTS', status: 409 });
    throw error;
  } finally {
    await fs.rm(temp, { force: true });
  }
}

function validateFields(fields) {
  if (!Array.isArray(fields) || fields.length === 0) throw invalidSchema('At least one reviewed schema field is required.');
  const ids = new Set();
  const normalized = fields.map((input, index) => {
    const id = String(input.id || '').trim();
    const label = String(input.label || '').trim();
    if (!/^[a-z][a-z0-9_.-]{0,63}$/u.test(id) || !label || ids.has(id)) throw invalidSchema('Schema fields require unique stable ids and labels.');
    ids.add(id);
    const type = String(input.type || 'string');
    if (!TYPES.has(type)) throw invalidSchema(`${id} has an unsupported type.`);
    const allowedSources = input.allowedSources ?? ['TECHNICIAN'];
    if (!Array.isArray(allowedSources) || !allowedSources.length || new Set(allowedSources).size !== allowedSources.length || allowedSources.some((source) => !SOURCES.has(source))) throw invalidSchema(`${id} has invalid allowed sources.`);
    if (allowedSources.length === 1 && allowedSources[0] === 'KNOWLEDGE' && (input.required || input.requiredWhen)) throw invalidSchema(`${id} cannot require knowledge as the only source of a job fact.`);
    const fieldRole = input.fieldRole || 'JOB_FACT';
    if (!['JOB_FACT', 'NORMATIVE_REFERENCE'].includes(fieldRole)) throw invalidSchema(`${id} has an invalid field role.`);
    if (fieldRole === 'NORMATIVE_REFERENCE' && (!NORMATIVE_FIELD_ID.test(id) || input.critical || input.requiresTechnicianConfirmation)) {
      throw invalidSchema(`${id} cannot classify a critical or job-fact field as a normative reference.`);
    }
    const requiredWhen = input.requiredWhen ?? null;
    if (requiredWhen && (typeof requiredWhen !== 'object' || !['HAS_VALUE', 'IS'].includes(requiredWhen.operator) || typeof requiredWhen.field !== 'string' || (requiredWhen.operator === 'IS' && (requiredWhen.value === undefined || requiredWhen.value === null)))) throw invalidSchema(`${id} has an invalid requiredWhen rule.`);
    const allowedStatuses = type === 'status' ? (input.allowedStatuses || ['NOT_CHECKED', 'OK', 'NOT_OK', 'N/A']) : undefined;
    if (allowedStatuses && (!Array.isArray(allowedStatuses) || allowedStatuses[0] !== 'NOT_CHECKED' || new Set(allowedStatuses).size !== allowedStatuses.length || allowedStatuses.some((value) => typeof value !== 'string' || !value.trim()) || input.defaultValue !== undefined)) throw invalidSchema('Status fields must begin NOT_CHECKED and may not have a positive default.');
    const allowedValues = input.allowedValues;
    if (allowedValues !== undefined && (!Array.isArray(allowedValues) || !allowedValues.length || new Set(allowedValues).size !== allowedValues.length || allowedValues.some((value) => typeof value !== 'string' || !value.trim()))) throw invalidSchema(`${id} has invalid allowed values.`);
    return {
      id, label, section: String(input.section || 'Report fields'), displayOrder: index + 1,
      type, required: input.required === true, ...(requiredWhen ? { requiredWhen: { field: requiredWhen.field, operator: requiredWhen.operator, ...(requiredWhen.operator === 'IS' ? { value: requiredWhen.value } : {}) } } : {}),
      allowedSources: [...allowedSources], critical: input.critical === true,
      fieldRole,
      requiresTechnicianConfirmation: input.requiresTechnicianConfirmation === true,
      allowExplicitNone: input.allowExplicitNone === true, allowNotApplicable: input.allowNotApplicable === true,
      inferencePolicy: 'EVIDENCE_OR_TECHNICIAN_INPUT',
      renderer: type === 'status' ? 'status-control' : type === 'number' ? 'measurement-control' : 'text-control',
      ...(allowedStatuses ? { allowedStatuses } : {}),
      ...(allowedValues ? { allowedValues: [...allowedValues] } : {}),
    };
  });
  for (const field of normalized) if (field.requiredWhen && (field.requiredWhen.field === field.id || !ids.has(field.requiredWhen.field))) throw invalidSchema(`${field.id} refers to a missing or self-dependent condition field.`);
  const byId = new Map(normalized.map((field) => [field.id, field]));
  for (const field of normalized) {
    const visited = new Set([field.id]);
    let dependency = field.requiredWhen?.field;
    while (dependency) {
      if (visited.has(dependency)) throw invalidSchema('Conditional requirements cannot form a cycle.');
      visited.add(dependency);
      dependency = byId.get(dependency)?.requiredWhen?.field;
    }
  }
  return normalized;
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

  draftPath(id) {
    if (!/^[a-z0-9-]{1,80}$/u.test(String(id))) throw Object.assign(new Error('Invalid template draft id.'), { code: 'INVALID_TEMPLATE_DRAFT_ID', status: 400 });
    return path.join(this.draftsDir, `${id}.json`);
  }

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
    const analysis = decodeTemplateText({ filename, mimeType, bytes });
    const draft = {
      id, templateId: slug(name), name: String(name || 'Untitled template').trim(), status: 'DRAFT', createdAt: now, updatedAt: now,
      provenance: { classification: 'user-supplied prototype', official: false },
      source: { filename: path.basename(String(filename || 'template.bin')), mimeType: String(mimeType || 'application/octet-stream'), sha256: sourceHash, size: bytes.length, path: artifactPath, preserved: true },
      analysis: { status: analysis.status, parser: analysis.parser || null, detectedFields: analysis.fields || [], undetectedReason: analysis.reason || null },
      schemaReview: { status: 'PENDING', fields: [] }, context: { status: 'PENDING', documents: [] }, test: { status: 'PENDING' },
    };
    await atomicJson(this.draftPath(id), draft);
    return structuredClone(draft);
  }

  async saveSchema(id, { fields }) {
    const draft = await this.assertMutable(id);
    draft.schemaReview = { status: 'REVIEWED', fields: validateFields(fields), reviewedAt: new Date().toISOString() };
    draft.test = { status: 'PENDING' };
    draft.updatedAt = new Date().toISOString();
    await atomicJson(this.draftPath(id), draft);
    return structuredClone(draft);
  }

  async proposeWithModel(id, { provider, model }) {
    const draft = await this.assertMutable(id);
    if (!draft.analysis.parser) throw Object.assign(new Error('Source text is not reliably parsed. Define fields manually.'), { code: 'TEMPLATE_MANUAL_DEFINITION_REQUIRED', status: 409 });
    if (!model) throw Object.assign(new Error('No local proposal model is configured.'), { code: 'TEMPLATE_PROPOSAL_MODEL_REQUIRED', status: 503 });
    const source = (await fs.readFile(draft.source.path, 'utf8')).slice(0, 32_000);
    const result = await provider.generateJson({ model,
      system: 'Suggest fields from the supplied report template. Your output is an untrusted draft for a human manager. Return only JSON with a fields array. Do not invent required rules, completed work, or job facts.',
      prompt: JSON.stringify({ source, schema: { fields: [{ id: 'lowercase_stable_id', label: 'Source label', section: 'Section', type: 'string', required: false, allowedSources: ['TECHNICIAN'], critical: false, requiresTechnicianConfirmation: false, allowExplicitNone: false, allowNotApplicable: false }] } }),
    });
    const suggestions = Array.isArray(result.data?.fields) ? result.data.fields.slice(0, 100) : [];
    if (!suggestions.length) throw Object.assign(new Error('The model did not propose usable fields. Define fields manually.'), { code: 'TEMPLATE_PROPOSAL_EMPTY', status: 422 });
    const fields = suggestions.map((item) => ({
      id: String(item.id || '').trim().toLowerCase().replace(/[^a-z0-9_.-]/gu, '_').slice(0, 64),
      label: String(item.label || '').trim().slice(0, 120), section: String(item.section || 'Report fields').trim().slice(0, 120),
      type: TYPES.has(item.type) ? item.type : 'string', required: item.required === true,
      requiredWhen: item.requiredWhen || null,
      allowedSources: Array.isArray(item.allowedSources) ? item.allowedSources : ['TECHNICIAN'],
      critical: item.critical === true, requiresTechnicianConfirmation: item.requiresTechnicianConfirmation === true,
      allowExplicitNone: item.allowExplicitNone === true, allowNotApplicable: item.allowNotApplicable === true,
      proposalOrigin: 'LOCAL_LLM_UNREVIEWED',
    }));
    draft.analysis = { status: 'PROPOSED_FOR_REVIEW', parser: draft.analysis.parser, detectedFields: fields,
      undetectedReason: null, proposalModel: String(model), proposedAt: new Date().toISOString() };
    draft.schemaReview = { status: 'PENDING', fields: [] };
    draft.test = { status: 'PENDING' };
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
    draft.test = { status: 'PENDING' };
    draft.updatedAt = new Date().toISOString();
    await atomicJson(this.draftPath(id), draft);
    return structuredClone(draft);
  }

  async waiveContext(id, reason) {
    const draft = await this.assertMutable(id);
    draft.context = { ...draft.context, status: 'WAIVED', waiverReason: String(reason || 'No context required for this version.') };
    draft.test = { status: 'PENDING' };
    draft.updatedAt = new Date().toISOString();
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
        ? 'Contract structure passed: reviewed fields, condition references, status defaults, and context decision are valid. Job values are checked during report processing.'
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
    const publishedPath = path.join(this.publishedDir, `${draft.templateId}@${version}.json`);
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
    await createImmutableJson(publishedPath, published);
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
