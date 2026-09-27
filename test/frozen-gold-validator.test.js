import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { annotationHash, validateFrozenGold } from '../evaluation/frozen-gold.js';

const MANIFEST_HASH = 'a'.repeat(64);

function annotation(overrides = {}) {
  const document = {
    schema_version: 'audio-ground-truth.blind.v1',
    case_id: 'CASE-001',
    scope: 'SBS_BUS',
    scenario: 'normal',
    synthetic: true,
    source_manifest_sha256: MANIFEST_HASH,
    audio_file: 'CASE-001.wav',
    audio_file_sha256: 'b'.repeat(64),
    annotation: {
      verbatim_transcript: 'Bus 8300-354 was inspected.',
      normalized_transcript: 'Bus 8300-354 was inspected.',
      technical_terms: [],
      numbers_units: [],
      equipment_ids: ['8300-354'],
      facts: [],
      negated_or_deferred_actions: [],
      relevant_knowledge_ids: [],
      missing_fields: [],
      report_points: [],
      uncertain_spans: [],
      reviewer_notes: null,
    },
    human_review_status: 'reviewed',
    reviewer_id: 'reviewer-a',
    reviewed_at: '2026-09-27T04:00:00.000Z',
    frozen_gold: true,
    freeze: {
      approved_by: 'reviewer-b',
      approved_at: '2026-09-27T05:00:00.000Z',
      annotation_sha256: null,
    },
    ...overrides,
  };
  document.freeze.annotation_sha256 = annotationHash(document);
  return document;
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'frozen-gold-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const annotationsDir = path.join(root, 'annotations');
  await fs.mkdir(annotationsDir);
  const caseListPath = path.join(root, 'blind-cases.json');
  await fs.writeFile(caseListPath, `${JSON.stringify({
    schema_version: 'blind-case-list.v1',
    source_manifest_sha256: MANIFEST_HASH,
    cases: [{
      case_id: 'CASE-001',
      scope: 'SBS_BUS',
      scenario: 'normal',
      audio_file: 'audio/CASE-001.wav',
      audio_file_sha256: 'b'.repeat(64),
    }],
  }, null, 2)}\n`);
  return { annotationsDir, caseListPath };
}

test('frozen Gold validation accepts a complete independently approved annotation batch', async (t) => {
  const { annotationsDir, caseListPath } = await fixture(t);
  await fs.writeFile(path.join(annotationsDir, 'CASE-001.json'), `${JSON.stringify(annotation(), null, 2)}\n`);

  const result = await validateFrozenGold({ annotationsDir, caseListPath });

  assert.equal(result.valid, true);
  assert.equal(result.annotation_files, 1);
  assert.equal(result.source_manifest_sha256, MANIFEST_HASH);
  assert.deepEqual(result.errors, []);
});

test('frozen Gold validation rejects content tampering and a manifest mismatch', async (t) => {
  const { annotationsDir, caseListPath } = await fixture(t);
  const document = annotation({ source_manifest_sha256: 'c'.repeat(64) });
  document.annotation.verbatim_transcript = 'Tampered after approval.';
  await fs.writeFile(path.join(annotationsDir, 'CASE-001.json'), `${JSON.stringify(document, null, 2)}\n`);

  const result = await validateFrozenGold({ annotationsDir, caseListPath });

  assert.equal(result.valid, false);
  assert.match(JSON.stringify(result.errors), /source_manifest_sha256 differs from blind case list/);
  assert.match(JSON.stringify(result.errors), /annotation_sha256 does not match/);
});

test('frozen Gold validation rejects duplicate case annotations and self-approval', async (t) => {
  const { annotationsDir, caseListPath } = await fixture(t);
  const selfApproved = annotation({
    freeze: {
      approved_by: 'reviewer-a',
      approved_at: '2026-09-27T05:00:00.000Z',
      annotation_sha256: null,
    },
  });
  selfApproved.freeze.annotation_sha256 = annotationHash(selfApproved);
  await fs.writeFile(path.join(annotationsDir, 'CASE-001.json'), `${JSON.stringify(selfApproved, null, 2)}\n`);
  await fs.writeFile(path.join(annotationsDir, 'duplicate.json'), `${JSON.stringify(selfApproved, null, 2)}\n`);

  const result = await validateFrozenGold({ annotationsDir, caseListPath });

  assert.equal(result.valid, false);
  assert.match(JSON.stringify(result.errors), /Duplicate annotation for case_id CASE-001/);
  assert.match(JSON.stringify(result.errors), /freeze approval must be independent/);
});
