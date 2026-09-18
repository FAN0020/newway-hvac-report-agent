import { boundedString } from './tool-envelope.js';

/**
 * Attempt LLM-assisted conflict resolution with strict boundaries.
 * Returns: { resolution: 'ACCEPT_FACT_ID' | 'NEEDS_TECHNICIAN', selected_fact_id?: string, reason?: string }
 */
export async function resolveFactConflict({ conflictingFacts, field, allFacts = [], provider, model }) {
  // Deterministic: always escalate to human if no provider
  if (!provider?.generateJson || conflictingFacts.length < 2) {
    return { resolution: 'NEEDS_TECHNICIAN', reason: 'Multiple conflicting values require technician review' };
  }
  // Only handle completion_status conflicts for now (safe, well-bounded)
  if (field !== 'completion_status') {
    return { resolution: 'NEEDS_TECHNICIAN', reason: `Conflict in ${field} requires technician review` };
  }
  try {
    const response = await provider.generateJson({
      model,
      system: `You resolve HVAC completion_status conflicts by choosing the most recent or definitive statement. Return only a fact_id from the supplied conflicting_facts list. Do not invent completion states, combine facts, or add information. Return JSON only.`,
      prompt: JSON.stringify({
        field: 'completion_status',
        conflicting_facts: conflictingFacts.map(f => ({
          fact_id: f.fact_id,
          value: f.value,
          source_span: f.source_span,
          source_refs: f.source_refs,
          support_status: f.support_status
        })),
        context_hints: {
          temporal_indicators: ['最后', '后来', '现在', '目前', '完工后'],
          certainty_indicators: ['已确认', '实际上', '最终']
        },
        required_output: {
          selected_fact_id: 'fact_id from conflicting_facts',
          reason: 'Brief Chinese explanation of why this fact is preferred'
        }
      })
    });
    const selectedId = String(response?.data?.selected_fact_id || '');
    const reason = boundedString(response?.data?.reason, 500);
    const allowedIds = new Set(conflictingFacts.map(f => f.fact_id));
    if (!allowedIds.has(selectedId)) {
      return { resolution: 'NEEDS_TECHNICIAN', reason: 'LLM selected invalid fact_id, escalating to technician' };
    }
    return { resolution: 'ACCEPT_FACT_ID', selected_fact_id: selectedId, reason: reason || 'LLM selected based on context', confidence: 'MEDIUM' };
  } catch (error) {
    return { resolution: 'NEEDS_TECHNICIAN', reason: `Provider error: ${error.code || 'UNKNOWN'}` };
  }
}
