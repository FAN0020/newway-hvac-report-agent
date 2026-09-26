import { canonicalJson } from '../domain/index.js';

export function activeCandidates(candidates = []) {
  const known = new Set(candidates.map((candidate) => candidate.candidate_id));
  const superseded = new Set(candidates.flatMap((candidate) => (
    candidate.support_type === 'TECHNICIAN_CONFIRMATION'
      ? candidate.resolution?.resolved_candidate_ids || []
      : []
  )).filter((id) => known.has(id)));
  return {
    active: candidates.filter((candidate) => !superseded.has(candidate.candidate_id)),
    superseded_candidate_ids: [...superseded],
  };
}

export function detectFieldConflicts(candidates = []) {
  const byField = new Map();
  for (const candidate of candidates) {
    if (!byField.has(candidate.field_id)) byField.set(candidate.field_id, []);
    byField.get(candidate.field_id).push(candidate);
  }
  return [...byField.entries()].flatMap(([fieldId, fieldCandidates]) => {
    const { active } = activeCandidates(fieldCandidates);
    const reliable = active.filter((candidate) => candidate.support_type !== 'AI_INFERENCE');
    const considered = reliable.length ? reliable : active;
    const claims = new Map();
    for (const candidate of considered) {
      const key = canonicalJson(candidate.claim);
      if (!claims.has(key)) claims.set(key, []);
      claims.get(key).push(candidate.candidate_id);
    }
    if (claims.size < 2) return [];
    return [{
      field_id: fieldId,
      candidate_ids: considered.map((candidate) => candidate.candidate_id),
      competing_claims: [...claims.entries()].map(([claim, candidateIds]) => ({ claim: JSON.parse(claim), candidate_ids: candidateIds })),
    }];
  });
}

