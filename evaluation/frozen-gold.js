import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const REQUIRED_ARRAYS = [
  'technical_terms', 'numbers_units', 'equipment_ids', 'facts',
  'negated_or_deferred_actions', 'relevant_knowledge_ids', 'missing_fields',
  'report_points', 'uncertain_spans',
];

export function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// The freeze hash deliberately excludes itself, otherwise writing it would change it.
export function annotationHash(annotation) {
  const copy = structuredClone(annotation);
  if (copy.freeze) copy.freeze.annotation_sha256 = null;
  return sha256(`${JSON.stringify(copy, null, 2)}\n`);
}

export async function validateFrozenGold({ annotationsDir, caseListPath, requireAll = true }) {
  const caseList = JSON.parse(await fs.readFile(caseListPath, 'utf8'));
  if (caseList.schema_version !== 'blind-case-list.v1' || !Array.isArray(caseList.cases)) {
    throw new Error('Expected a blind-case-list.v1 case list. Do not validate Gold against the seed manifest.');
  }
  if (!/^[a-f0-9]{64}$/u.test(String(caseList.source_manifest_sha256 || ''))) {
    throw new Error('blind-cases.json must bind the package to a source_manifest_sha256. Regenerate the blind package.');
  }
  const expected = new Map(caseList.cases.map((item) => [item.case_id, item]));
  if (expected.size !== caseList.cases.length) {
    throw new Error('blind-cases.json contains duplicate case_id values.');
  }
  const names = (await fs.readdir(annotationsDir)).filter((name) => name.endsWith('.json')).sort();
  const records = [];
  const errors = [];
  const annotationNamesByCase = new Map();
  for (const name of names) {
    let document;
    try { document = JSON.parse(await fs.readFile(path.join(annotationsDir, name), 'utf8')); }
    catch (error) { errors.push({ file: name, errors: [`Invalid JSON: ${error.message}`] }); continue; }
    const issues = [];
    const expectedCase = expected.get(document.case_id);
    if (document.schema_version !== 'audio-ground-truth.blind.v1') issues.push('schema_version must be audio-ground-truth.blind.v1');
    if (!expectedCase) issues.push('case_id is absent from blind-cases.json');
    if (expectedCase && (document.scope !== expectedCase.scope || document.scenario !== expectedCase.scenario)) issues.push('scope or scenario differs from blind case metadata');
    if (expectedCase && document.audio_file_sha256 !== expectedCase.audio_file_sha256) issues.push('audio_file_sha256 differs from blind case metadata');
    if (document.source_manifest_sha256 !== caseList.source_manifest_sha256) issues.push('source_manifest_sha256 differs from blind case list');
    if (!document.synthetic) issues.push('synthetic must remain true');
    if (!document.annotation || typeof document.annotation !== 'object') issues.push('annotation object is required');
    else {
      if (!String(document.annotation.verbatim_transcript || '').trim()) issues.push('verbatim_transcript is required');
      if (!String(document.annotation.normalized_transcript || '').trim()) issues.push('normalized_transcript is required');
      for (const key of REQUIRED_ARRAYS) if (!Array.isArray(document.annotation[key])) issues.push(`annotation.${key} must be an array`);
      if (Array.isArray(document.annotation.uncertain_spans) && document.annotation.uncertain_spans.length) issues.push('uncertain_spans must be adjudicated before freeze');
    }
    if (document.human_review_status !== 'reviewed') issues.push('human_review_status must be reviewed');
    if (document.frozen_gold !== true) issues.push('frozen_gold must be true');
    if (!String(document.reviewer_id || '').trim() || !String(document.reviewed_at || '').trim()) issues.push('reviewer_id and reviewed_at are required');
    if (!String(document.freeze?.approved_by || '').trim() || !String(document.freeze?.approved_at || '').trim()) issues.push('independent freeze approval is required');
    if (String(document.freeze?.approved_by || '').trim() === String(document.reviewer_id || '').trim()) issues.push('freeze approval must be independent from reviewer_id');
    const actualHash = annotationHash(document);
    if (String(document.freeze?.annotation_sha256 || '').toLowerCase() !== actualHash) issues.push('freeze.annotation_sha256 does not match the frozen annotation');
    records.push({ file: name, case_id: document.case_id, scope: document.scope, source_manifest_sha256: document.source_manifest_sha256, annotation_sha256: actualHash, valid: !issues.length });
    if (issues.length) errors.push({ file: name, case_id: document.case_id, errors: issues });
    const sameCase = annotationNamesByCase.get(document.case_id) || [];
    sameCase.push(name);
    annotationNamesByCase.set(document.case_id, sameCase);
  }
  for (const [caseId, caseNames] of annotationNamesByCase) {
    if (caseNames.length > 1) errors.push({ case_id: caseId, errors: [`Duplicate annotation for case_id ${caseId}: ${caseNames.join(', ')}`] });
  }
  const seen = new Set(records.map((record) => record.case_id));
  if (requireAll) for (const caseId of expected.keys()) if (!seen.has(caseId)) errors.push({ case_id: caseId, errors: ['Missing annotation file'] });
  for (const caseId of seen) if (!expected.has(caseId)) errors.push({ case_id: caseId, errors: ['Unexpected annotation case'] });
  const manifests = [...new Set(records.map((record) => record.source_manifest_sha256).filter(Boolean))];
  if (manifests.length !== 1) errors.push({ errors: ['All annotations must declare one shared source_manifest_sha256'] });
  return { contract_version: 'frozen-gold-validation.v1', generated_at: new Date().toISOString(), expected_cases: expected.size, annotation_files: names.length, source_manifest_sha256: caseList.source_manifest_sha256, valid: !errors.length, records, errors };
}
