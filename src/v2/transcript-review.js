/**
 * Scope-aware review of likely speech-to-text errors.
 *
 * Nothing in this module silently changes the technician transcript. It only
 * proposes bounded replacements and raises clarification questions when the
 * wording changes whether work was actually performed.
 */

const RAIL_RULES = Object.freeze([
  Object.freeze({
    id: 'rail_asset_c751a_z751a',
    pattern: /\bZ751A\b/iu,
    replacement: 'C751A',
    reason: 'C751A is present in the active Rail asset vocabulary; Z751A is not.',
    confidence: 'HIGH',
    category: 'ASSET_IDENTIFIER',
  }),
  Object.freeze({
    id: 'rail_door_module_model_40',
    pattern: /\bdoor\s+control\s+model\s+40\b/iu,
    replacement: 'door control module faulty',
    reason: 'The active Rail door vocabulary supports “door control module”; the audio phrase remains safety-relevant and requires technician confirmation.',
    confidence: 'MEDIUM',
    category: 'DOMAIN_TERMINOLOGY',
  }),
  Object.freeze({
    id: 'rail_door_module_model',
    pattern: /\bdoor\s+control\s+model\b/iu,
    replacement: 'door control module',
    reason: 'The active Rail door vocabulary supports “door control module”.',
    confidence: 'MEDIUM',
    category: 'DOMAIN_TERMINOLOGY',
  }),
]);

const BUS_RULES = Object.freeze([
  Object.freeze({
    id: 'bus_model_man_a95_spoken_digits',
    pattern: /\bMAN\s+9[-\s]?5\b/iu,
    replacement: 'MAN A95',
    reason: 'MAN A95 is present in the active Bus model vocabulary; “MAN 9-5” is a common spoken-letter ASR rendering.',
    confidence: 'HIGH',
    category: 'ASSET_IDENTIFIER',
  }),
  Object.freeze({
    id: 'bus_door_module_model',
    pattern: /\bdoor\s+control\s+model\b/iu,
    replacement: 'door control module',
    reason: 'The active Bus parts vocabulary supports “door control module”.',
    confidence: 'MEDIUM',
    category: 'DOMAIN_TERMINOLOGY',
  }),
]);

const FUTURE_ACTION_RE = /\b(?:I|we|the\s+technician)\s+(?:will|plan(?:ned)?\s+to|intend(?:ed)?\s+to)\s+(replace|place|install|repair|renew|change)\b/giu;

function correctionMatches(text, rules) {
  const suggestions = [];
  const occupied = [];
  for (const rule of rules) {
    const flags = rule.pattern.flags.includes('g') ? rule.pattern.flags : `${rule.pattern.flags}g`;
    const matcher = new RegExp(rule.pattern.source, flags);
    let ordinal = 0;
    for (const match of text.matchAll(matcher)) {
      const start = match.index;
      const end = start + match[0].length;
      if (occupied.some((range) => start < range.end && end > range.start)) continue;
      occupied.push({ start, end });
      suggestions.push(Object.freeze({
        correction_id: `${rule.id}_${ordinal}`,
        start,
        end,
        source_text: match[0],
        suggested_text: rule.replacement,
        reason: rule.reason,
        confidence: rule.confidence,
        category: rule.category,
        requires_confirmation: true,
      }));
      ordinal += 1;
    }
  }
  return suggestions.sort((a, b) => a.start - b.start);
}

/**
 * Returns review items for the selected domain without modifying rawText.
 */
export function reviewV2Transcript({ scopeId, rawText } = {}) {
  const text = String(rawText ?? '');
  const rules = scopeId === 'SBS_RAIL' ? RAIL_RULES : scopeId === 'SBS_BUS' ? BUS_RULES : [];
  const correctionSuggestions = correctionMatches(text, rules);
  const confirmationQuestions = [];

  if (scopeId === 'SBS_BUS') {
    for (const match of text.matchAll(/\b(?:SBS|SG)\d{1,4}[A-Z]\b/giu)) {
      confirmationQuestions.push(Object.freeze({
        question_id: `registration_identity_${match.index}`,
        field: 'asset.registration_no',
        source_text: match[0],
        question: `Please confirm the vehicle registration “${match[0]}” against the vehicle or work order. Identity fields are never corrected automatically.`,
        reason: 'A single ASR letter error can bind the report to the wrong vehicle.',
        critical: true,
      }));
    }
  }

  for (const match of text.matchAll(FUTURE_ACTION_RE)) {
    confirmationQuestions.push(Object.freeze({
      question_id: `action_tense_${match.index}`,
      field: 'work_performed',
      source_text: match[0],
      question: `The transcript says “${match[0]}”, which describes a future or planned action. Was this work actually completed? Edit the transcript to the observed past-tense action only if the technician confirms it.`,
      reason: 'Planned work must never be reported as completed work.',
      critical: true,
    }));
  }

  if ((scopeId === 'OILFIELD' || scopeId === 'POWER_GRID')
    && /(?:错了|更正|改为|correction|corrected)/iu.test(text)) {
    confirmationQuestions.push(Object.freeze({
      question_id: 'industrial_standard_self_correction',
      field: 'standard.reference',
      source_text: text.match(/(?:错了|更正|改为)[^。\n]*/iu)?.[0] || '',
      question: 'The technician corrected the inspection standard aloud. Please confirm the final standard and clause before issuing the report.',
      reason: 'A spoken self-correction can leave both the superseded and final references in the transcript.',
      critical: true,
    }));
  }

  if ((scopeId === 'OILFIELD' || scopeId === 'POWER_GRID')
    && /恢复运行|恢复服务|回役|return(?:ed)?\s+to\s+service|back\s+in\s+service/iu.test(text)) {
    confirmationQuestions.push(Object.freeze({
      question_id: 'industrial_return_to_service_confirmation',
      field: 'safety.assertion',
      source_text: text.match(/[^。\n]*(?:恢复运行|恢复服务|回役|return(?:ed)?\s+to\s+service|back\s+in\s+service)[^。\n]*/iu)?.[0]?.trim() || '',
      question: 'Please confirm that the asset was authorised to return to service after the stated safety checks.',
      reason: 'Return-to-service is safety-critical and requires explicit technician confirmation.',
      critical: true,
    }));
  }

  return Object.freeze({
    correction_suggestions: Object.freeze(correctionSuggestions),
    confirmation_questions: Object.freeze(confirmationQuestions),
  });
}

/**
 * Test/helper path for applying only explicitly accepted suggestions.
 */
export function applyConfirmedTranscriptCorrections(rawText, suggestions = [], acceptedIds = []) {
  const accepted = new Set((acceptedIds || []).map(String));
  const selected = (suggestions || [])
    .filter((item) => accepted.has(String(item?.correction_id)))
    .sort((a, b) => Number(b.start) - Number(a.start));
  let output = String(rawText ?? '');
  for (const item of selected) {
    const start = Number(item.start);
    const end = Number(item.end);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end > output.length) continue;
    if (output.slice(start, end) !== item.source_text) continue;
    output = `${output.slice(0, start)}${item.suggested_text}${output.slice(end)}`;
  }
  return output;
}
