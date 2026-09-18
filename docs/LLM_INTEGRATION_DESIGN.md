# LLM Integration Design for HVAC Report Agent

**Status**: DESIGN PROPOSAL  
**Date**: 2026-09-18  
**Scope**: Intelligent enhancement of 5 decision points while maintaining MVP safety boundaries

## Executive Summary

This design enhances the HVAC report agent with LLM-driven intelligence at 5 decision points while preserving all safety gates: zero fabrication, human confirmation requirements, traceability, and backward compatibility with existing tests.

**Key Principles**:
- LLM outputs are **candidates, not facts** - all suggestions require validation against knowledge base or human confirmation
- Deterministic fallbacks remain for all LLM-enhanced paths
- Source binding and receipts unchanged
- Existing test contracts preserved

---

## 1. Smart Follow-up Questions (Priority: 1 - HIGH IMPACT)

### Current State
**Tool**: `validate-report-input.js` (lines 4-10)  
**Method**: Fixed question map (`QUESTIONS` object) + simple field-missing check  
**Limitation**: Always asks same questions regardless of context; no intelligence about what's most important

### Integration Points

#### 1.1 Modify `validateReportInput` function
**Location**: `/tmp/hvac-repo/src/tools/validate-report-input.js`

**Current logic**:
```javascript
const QUESTIONS = Object.freeze({
  customer_complaint: '客户最初反映的问题是什么？',
  inspection_findings: '你在现场检查发现了什么？',
  // ... fixed questions
});
```

**Enhanced logic**:
```javascript
async function generateContextualQuestions({ 
  missingFields, 
  uncertainFacts, 
  existingFacts, 
  provider, 
  model 
}) {
  // Deterministic fallback
  if (!provider?.generateJson || missingFields.length === 0) {
    return missingFields.slice(0, 3).map(field => ({
      field,
      question: QUESTIONS[field],
      priority: 'REQUIRED',
      reason: 'Deterministic fallback'
    }));
  }

  try {
    const response = await provider.generateJson({
      model,
      system: `You rank missing HVAC service report fields by criticality. 
Return only field priorities from the supplied missing_fields list.
Never invent fields, completion states, or technical recommendations.
Return JSON only.`,
      prompt: JSON.stringify({
        missing_fields: missingFields,
        uncertain_fact_ids: uncertainFacts.slice(0, 10),
        present_fields_summary: existingFacts
          .filter(f => f.support_status !== 'UNCERTAIN')
          .map(f => ({ field: f.field, has_value: true })),
        allowed_priorities: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'],
        required_output: {
          ranked_questions: [{
            field: 'field from missing_fields',
            question: 'Chinese question text',
            priority: 'CRITICAL|HIGH|MEDIUM|LOW',
            reason: 'Brief explanation'
          }]
        }
      })
    });

    const ranked = Array.isArray(response?.data?.ranked_questions) 
      ? response.data.ranked_questions 
      : [];
    
    // Validate: only allowed fields, bounded strings
    const valid = ranked
      .filter(q => 
        missingFields.includes(q?.field) &&
        typeof q?.question === 'string' &&
        q.question.length > 0 &&
        q.question.length <= 500 &&
        ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'].includes(q?.priority)
      )
      .slice(0, 3);

    if (valid.length === 0) {
      // LLM output invalid, use deterministic
      return missingFields.slice(0, 3).map(field => ({
        field,
        question: QUESTIONS[field],
        priority: 'REQUIRED',
        reason: 'LLM output invalid, deterministic fallback'
      }));
    }

    // Fill remaining slots with deterministic if LLM returned < 3
    const usedFields = new Set(valid.map(q => q.field));
    const remaining = missingFields
      .filter(f => !usedFields.has(f))
      .slice(0, 3 - valid.length)
      .map(field => ({
        field,
        question: QUESTIONS[field],
        priority: 'REQUIRED',
        reason: 'Deterministic supplement'
      }));

    return [...valid, ...remaining];

  } catch (error) {
    // Provider failure, deterministic fallback
    return missingFields.slice(0, 3).map(field => ({
      field,
      question: QUESTIONS[field],
      priority: 'REQUIRED',
      reason: `Provider error: ${error.code || 'UNKNOWN'}`
    }));
  }
}
```

#### 1.2 Update tool envelope
**Changes to `validateReportInput` return**:
```javascript
return toolEnvelope('validate_report_input', traceId, status, {
  missing_required_fields: missingRequiredFields,
  uncertain_fact_ids: uncertainFacts,
  conflicts,
  follow_up_questions: await generateContextualQuestions({
    missingFields: missingRequiredFields,
    uncertainFacts,
    existingFacts: facts,
    provider,
    model
  }),
  question_generation_mode: provider?.generateJson ? 'LLM_ASSISTED' : 'DETERMINISTIC',
  can_generate_draft: true,
  can_save_or_export: false,
});
```

### Safety Boundaries
- **Input**: Only server-validated missing fields and facts receipts
- **Output**: LLM can only rank/rephrase questions for **already-missing** fields
- **Constraint**: Cannot add new fields, cannot mark fields as "not needed"
- **Fallback**: Always available; invalid LLM output triggers automatic deterministic path
- **Traceability**: Log LLM vs deterministic mode in tool response

### Backward Compatibility
- Existing tests expect `follow_up_questions` array with `field` and `question` properties
- Enhanced version adds optional `priority` and `reason` fields
- Tests using `.length <= 3` check still pass
- Deterministic path returns identical structure to current implementation

---

## 2. Report Section Selection (Priority: 3 - MEDIUM IMPACT)

### Current State
**Tool**: `plan-report-sections.js` (lines 4-19)  
**Method**: Simple field presence check - if any fact.field matches a conditional section's fields, include it  
**Limitation**: No intelligence about whether sparse data warrants a full section

### Integration Points

#### 2.1 Modify `planReportSections` function
**Location**: `/tmp/hvac-repo/src/tools/plan-report-sections.js`

**Current logic**:
```javascript
const selectedConditional = config.conditional_sections.filter(
  section => section.fields.some(field => presentFields.has(field))
);
```

**Enhanced logic**:
```javascript
async function selectConditionalSections({ 
  config, 
  presentFields, 
  facts, 
  provider, 
  model 
}) {
  // Always start with field-presence baseline
  const candidateSections = config.conditional_sections.filter(
    section => section.fields.some(field => presentFields.has(field))
  );

  if (!provider?.generateJson || candidateSections.length === 0) {
    return candidateSections; // Deterministic baseline
  }

  try {
    const response = await provider.generateJson({
      model,
      system: `You decide whether sparse HVAC data warrants a dedicated report section.
Return only section inclusion decisions from the supplied candidate list.
Do not add sections, remove required sections, or invent data.
Return JSON only.`,
      prompt: JSON.stringify({
        candidate_sections: candidateSections.map(s => ({
          id: s.id,
          title: s.title,
          fields: s.fields,
          manual_or_authorized_only: s.manual_or_authorized_only || false
        })),
        field_data_density: candidateSections.map(section => {
          const sectionFacts = facts.filter(f => 
            section.fields.includes(f.field) && 
            f.support_status !== 'UNCERTAIN'
          );
          return {
            section_id: section.id,
            fact_count: sectionFacts.length,
            fields_with_data: [...new Set(sectionFacts.map(f => f.field))],
            has_substantial_content: sectionFacts.length >= 2 ||
              sectionFacts.some(f => String(f.value).length > 20)
          };
        }),
        required_output: {
          decisions: [{
            section_id: 'section from candidate_sections',
            include: true,
            reason: 'Brief Chinese explanation'
          }]
        }
      })
    });

    const decisions = Array.isArray(response?.data?.decisions) 
      ? response.data.decisions 
      : [];
    
    const validIds = new Set(candidateSections.map(s => s.id));
    const validDecisions = decisions.filter(d => 
      validIds.has(d?.section_id) &&
      typeof d?.include === 'boolean'
    );

    if (validDecisions.length === 0) {
      return candidateSections; // LLM failed, use baseline
    }

    // Apply LLM recommendations but never drop manual_or_authorized_only sections
    const selected = candidateSections.filter(section => {
      if (section.manual_or_authorized_only) return true; // Always include
      const decision = validDecisions.find(d => d.section_id === section.id);
      return decision ? decision.include : true; // Default to include
    });

    return selected;

  } catch (error) {
    return candidateSections; // Provider error, use baseline
  }
}
```

#### 2.2 Update return value
```javascript
const selectedConditional = await selectConditionalSections({
  config,
  presentFields,
  facts,
  provider,
  model
});

return toolEnvelope('plan_report_sections', traceId, 'PASS', {
  service_type: serviceType,
  schema_version: config.schema_version,
  sections: [
    ...config.fixed_sections.map(section => ({ ...section, required: true })),
    ...selectedConditional.map(section => ({ ...section, required: false }))
  ],
  selected_conditional_section_ids: selectedConditional.map(s => s.id),
  excluded_conditional_section_ids: config.conditional_sections
    .filter(s => !selectedConditional.includes(s))
    .map(s => s.id),
  section_selection_mode: provider?.generateJson ? 'LLM_ASSISTED' : 'DETERMINISTIC'
});
```

### Safety Boundaries
- **Constraint**: Cannot modify `fixed_sections` (always included)
- **Constraint**: Cannot add new sections beyond `config.conditional_sections`
- **Constraint**: `manual_or_authorized_only` sections always included if data present
- **Input validation**: LLM can only reference section IDs from server config
- **Fallback**: Baseline is "include all conditional sections with any data present"

### Backward Compatibility
- Return structure identical (sections array with required boolean)
- Tests checking `selected_conditional_section_ids` still pass
- Deterministic path matches current behavior exactly

---

## 3. Term Disambiguation with Context (Priority: 2 - HIGH VALUE)

### Current State
**Tool**: `hvac-knowledge.js` (lines 69-108) + `normalize-hvac-transcript.js` (lines 52-81)  
**Method**: Exact phrase matching → LLM selects from candidate IDs (already LLM-assisted!)  
**Limitation**: LLM doesn't receive enough context to disambiguate (e.g., "35" could be µF, volts, or PSI)

### Integration Points

#### 3.1 Enhance candidate generation with context
**Location**: `/tmp/hvac-repo/src/tools/hvac-knowledge.js`

**Current**: Candidates built purely from exact phrase matches in knowledge base  
**Enhancement**: Add context-aware filtering before presenting to normalization LLM

```javascript
export async function buildTranscriptCorrectionCandidatesWithContext({ 
  rawText, 
  knowledgeRoot = defaultKnowledgeRoot,
  provider = null,
  model = null
} = {}) {
  // First: Build baseline candidates (unchanged)
  const baseline = await buildTranscriptCorrectionCandidates({ 
    rawText, 
    knowledgeRoot 
  });

  if (!provider?.generateJson || baseline.candidates.length === 0) {
    return baseline; // No provider or no candidates, return baseline
  }

  try {
    // Group candidates by overlapping spans or proximity
    const contextGroups = groupCandidatesByContext(baseline.candidates, rawText);

    const response = await provider.generateJson({
      model,
      system: `You filter HVAC term correction candidates using sentence context.
When multiple candidates target the same span or nearby spans, select the most appropriate.
Return only candidate_id values from the supplied list.
Do not invent candidates, add service facts, or change source spans.
Return JSON only.`,
      prompt: JSON.stringify({
        raw_text: rawText,
        candidate_groups: contextGroups.map(group => ({
          sentence: group.sentence,
          sentence_span: { start: group.start, end: group.end },
          candidates: group.candidates.map(c => ({
            candidate_id: c.candidate_id,
            source_span: c.source_span,
            source_text: c.source_span.text,
            candidate: c.candidate,
            reason: c.reason,
            risk: c.risk
          }))
        })),
        disambiguation_hints: {
          numbers_with_units: '数字通常需要单位：35微法→35 µF，220伏→220V',
          brand_vs_generic: '品牌名通常出现在"换""用"等动词后',
          tool_vs_part: '工具在"用X检查"，零件在"更换X"'
        },
        required_output: {
          retained_candidate_ids: ['candidate_id']
        }
      })
    });

    const retainedIds = Array.isArray(response?.data?.retained_candidate_ids)
      ? response.data.retained_candidate_ids
      : [];
    
    const allowedIds = new Set(baseline.candidates.map(c => c.candidate_id));
    const validIds = retainedIds.filter(id => allowedIds.has(String(id)));

    if (validIds.length === 0 || validIds.length === baseline.candidates.length) {
      // No filtering or invalid output, return baseline
      return baseline;
    }

    // Return filtered candidate set
    const filtered = baseline.candidates.filter(c => 
      validIds.includes(c.candidate_id)
    );

    return Object.freeze({
      knowledge_version: baseline.knowledge_version,
      candidates: Object.freeze(filtered),
      context_filtering_applied: true
    });

  } catch (error) {
    return baseline; // Provider error, return baseline
  }
}

function groupCandidatesByContext(candidates, rawText) {
  // Simple sentence boundary detection (same as extract-service-facts.js)
  const sentences = [];
  const pattern = /[^\n。！？；;]+[\n。！？；;]?/gu;
  for (const match of rawText.matchAll(pattern)) {
    const text = match[0].trim();
    if (!text) continue;
    sentences.push({ 
      start: match.index, 
      end: match.index + match[0].length, 
      text 
    });
  }

  // Group candidates by containing sentence
  return sentences.map(sentence => ({
    sentence: sentence.text,
    start: sentence.start,
    end: sentence.end,
    candidates: candidates.filter(c =>
      c.source_span.start >= sentence.start &&
      c.source_span.end <= sentence.end
    )
  })).filter(group => group.candidates.length > 0);
}
```

#### 3.2 Update normalization call chain
**Location**: `/tmp/hvac-repo/src/server.js` or wherever candidates are built

**Current**:
```javascript
const knowledge = await buildTranscriptCorrectionCandidates({ 
  rawText: transcript.raw_text 
});
```

**Enhanced**:
```javascript
const knowledge = await buildTranscriptCorrectionCandidatesWithContext({ 
  rawText: transcript.raw_text,
  provider: ollamaProvider,
  model: process.env.HVAC_OLLAMA_MODEL
});
```

### Safety Boundaries
- **Constraint**: LLM can only **filter out** candidates, never add or modify them
- **Constraint**: All candidates still come from versioned knowledge base
- **Input**: Exact phrase matches from controlled vocabulary
- **Output**: Subset of input candidate IDs
- **Fallback**: If LLM returns empty or invalid, use full baseline candidate set
- **Traceability**: `context_filtering_applied` flag in response

### Backward Compatibility
- Return structure unchanged (knowledge_version + candidates array)
- If no provider supplied, identical to current behavior
- Existing correction receipt validation unchanged (still validates against full knowledge base)

---

## 4. Fact Conflict Resolution (Priority: 4 - LOWER RISK)

### Current State
**Tool**: `validate-report-draft.js` (lines 108-109) + `validate-report-input.js` (lines 18-19)  
**Method**: Simple value comparison - if ≥2 different `completion_status` values exist, flag conflict  
**Limitation**: No intelligence about which statement is more recent, credible, or contextually correct

### Integration Points

#### 4.1 Create new conflict resolution helper
**Location**: New file `/tmp/hvac-repo/src/tools/resolve-fact-conflicts.js`

```javascript
import { boundedString } from './tool-envelope.js';

/**
 * Attempt LLM-assisted conflict resolution with strict boundaries
 * Returns: { resolution: 'ACCEPT_FACT_ID' | 'NEEDS_TECHNICIAN', selected_fact_id?: string, reason?: string }
 */
export async function resolveFactConflict({ 
  conflictingFacts, 
  field,
  allFacts = [],
  provider, 
  model 
}) {
  // Deterministic: always escalate to human if no provider
  if (!provider?.generateJson || conflictingFacts.length < 2) {
    return {
      resolution: 'NEEDS_TECHNICIAN',
      reason: 'Multiple conflicting values require technician review'
    };
  }

  // Only handle completion_status conflicts for now (safe, well-bounded)
  if (field !== 'completion_status') {
    return {
      resolution: 'NEEDS_TECHNICIAN',
      reason: `Conflict in ${field} requires technician review`
    };
  }

  try {
    const response = await provider.generateJson({
      model,
      system: `You resolve HVAC completion_status conflicts by choosing the most recent or definitive statement.
Return only a fact_id from the supplied conflicting_facts list.
Do not invent completion states, combine facts, or add information.
Return JSON only.`,
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
      // Invalid LLM output
      return {
        resolution: 'NEEDS_TECHNICIAN',
        reason: 'LLM selected invalid fact_id, escalating to technician'
      };
    }

    return {
      resolution: 'ACCEPT_FACT_ID',
      selected_fact_id: selectedId,
      reason: reason || 'LLM selected based on context',
      confidence: 'MEDIUM'
    };

  } catch (error) {
    return {
      resolution: 'NEEDS_TECHNICIAN',
      reason: `Provider error: ${error.code || 'UNKNOWN'}`
    };
  }
}
```

#### 4.2 Integrate into validation tools
**Location**: `/tmp/hvac-repo/src/tools/validate-report-input.js`

```javascript
import { resolveFactConflict } from './resolve-fact-conflicts.js';

export async function validateReportInput({ 
  facts = [], 
  traceId, 
  knowledgeRoot,
  provider = null,
  model = null
} = {}) {
  // ... existing logic ...

  const completionFacts = facts.filter(
    fact => fact.field === 'completion_status' && 
    fact.support_status !== 'UNCERTAIN'
  );
  
  let conflicts = [];
  let autoResolved = [];

  if (new Set(completionFacts.map(f => JSON.stringify(f.value))).size > 1) {
    const resolution = await resolveFactConflict({
      conflictingFacts: completionFacts,
      field: 'completion_status',
      allFacts: facts,
      provider,
      model
    });

    if (resolution.resolution === 'ACCEPT_FACT_ID') {
      // LLM resolved it - log but don't block
      autoResolved.push({
        field: 'completion_status',
        conflicting_fact_ids: completionFacts.map(f => f.fact_id),
        selected_fact_id: resolution.selected_fact_id,
        reason: resolution.reason,
        confidence: resolution.confidence
      });
    } else {
      // Escalate to human
      conflicts.push({
        field: 'completion_status',
        fact_ids: completionFacts.map(f => f.fact_id),
        fact_values: completionFacts.map(f => f.value),
        resolution_reason: resolution.reason
      });
    }
  }

  let status = 'PASS';
  if (conflicts.length || uncertainFacts.length) status = 'NEEDS_CONFIRMATION';
  else if (missingRequiredFields.length) status = 'NEEDS_MORE_INFO';

  return toolEnvelope('validate_report_input', traceId, status, {
    missing_required_fields: missingRequiredFields,
    uncertain_fact_ids: uncertainFacts,
    conflicts, // Only unresolved conflicts
    auto_resolved_conflicts: autoResolved,
    follow_up_questions: missingRequiredFields.slice(0, 3)
      .map(field => ({ field, question: QUESTIONS[field] })),
    can_generate_draft: true,
    can_save_or_export: false,
  });
}
```

### Safety Boundaries
- **Constraint**: LLM can only choose from existing conflicting facts, cannot synthesize new value
- **Scope**: Initially only `completion_status` field (well-bounded domain)
- **Escalation**: Any uncertainty or invalid output → human confirmation required
- **Traceability**: Auto-resolved conflicts logged separately with confidence level
- **Visibility**: UI must show "LLM resolved X conflicts automatically" with expansion to see details

### Human Confirmation Gate
Even with LLM resolution, technician sees:
```
自动解决的冲突 (1):
  完成状态: 系统选择了 "问题已解决" (fact_abc123)
    原因: 出现在更晚的位置，更可能是最终结论
    [查看全部冲突值] [改为人工确认]
```

### Backward Compatibility
- If no provider supplied, behavior identical to current (all conflicts flagged)
- Return structure extended with optional `auto_resolved_conflicts` field
- Tests expecting conflicts array still pass (auto-resolved conflicts not in that array)

---

## 5. Report Language Optimization (Priority: 5 - OPTIONAL ENHANCEMENT)

### Current State
**Tool**: `generate-report-draft.js` (lines 22-31) + `hvac-schema.js` (lines 59-77)  
**Method**: Deterministic template rendering with `renderFact()` function  
**Limitation**: Awkward phrasing when combining multiple facts, no fluency optimization

### Integration Points

#### 5.1 Optional post-processing for claim text
**Location**: `/tmp/hvac-repo/src/tools/generate-report-draft.js`

```javascript
async function optimizeClaimLanguage({ 
  claim, 
  facts, 
  provider, 
  model 
}) {
  const deterministicText = claim.text;

  if (!provider?.generateJson || facts.length === 0) {
    return { 
      text: deterministicText, 
      optimization_applied: false 
    };
  }

  try {
    const response = await provider.generateJson({
      model,
      system: `You improve HVAC report sentence fluency WITHOUT changing facts.
Return only reworded text that conveys EXACTLY the same information.
Never add actions, tests, measurements, conclusions, or details not in the input.
Return JSON only.`,
      prompt: JSON.stringify({
        deterministic_text: deterministicText,
        underlying_facts: facts.map(f => ({
          field: f.field,
          value: f.value,
          source_span_text: f.source_span?.text
        })),
        constraints: {
          must_preserve: ['数量', '单位', '型号', '测试结果', '完成状态', '否定表达'],
          allowed_changes: ['词序', '连接词', '句子结构'],
          forbidden: ['新增维修动作', '新增测试', '新增数值', '改变否定/肯定']
        },
        required_output: {
          optimized_text: 'Chinese text',
          changes_made: 'Brief description'
        }
      })
    });

    const optimizedText = boundedString(response?.data?.optimized_text, 2000);
    
    if (!optimizedText || optimizedText.length === 0) {
      return { 
        text: deterministicText, 
        optimization_applied: false,
        reason: 'Invalid LLM output'
      };
    }

    // Validation: optimized text must contain all critical tokens from original
    const criticalTokens = extractCriticalTokens(facts);
    const missingTokens = criticalTokens.filter(
      token => !optimizedText.includes(token)
    );

    if (missingTokens.length > 0) {
      return {
        text: deterministicText,
        optimization_applied: false,
        reason: `Missing critical tokens: ${missingTokens.join(', ')}`
      };
    }

    return {
      text: optimizedText,
      deterministic_text: deterministicText,
      optimization_applied: true,
      changes_made: boundedString(response?.data?.changes_made, 200)
    };

  } catch (error) {
    return {
      text: deterministicText,
      optimization_applied: false,
      reason: `Provider error: ${error.code || 'UNKNOWN'}`
    };
  }
}

function extractCriticalTokens(facts) {
  const tokens = new Set();
  
  for (const fact of facts) {
    const value = fact.value;
    
    // Extract numbers
    const numbers = String(JSON.stringify(value)).match(/\d+(?:\.\d+)?/g);
    if (numbers) numbers.forEach(n => tokens.add(n));
    
    // Extract units
    const units = String(JSON.stringify(value)).match(/[µμ]F|V|A|PSI|℃|°C|kg|L/gi);
    if (units) units.forEach(u => tokens.add(u));
    
    // Extract negation markers
    if (String(value).match(/没有|未|不/)) {
      tokens.add('否定');
    }
    
    // Extract part names for parts_used
    if (fact.field === 'parts_used' && value?.name) {
      tokens.add(String(value.name));
    }
  }
  
  return [...tokens];
}
```

#### 5.2 Update claim building
```javascript
function buildClaim(section, claimFacts, provider, model) {
  const factIds = claimFacts.map(fact => fact.fact_id);
  const deterministicText = claimFacts.map(renderFact).join(' ');
  
  return {
    type: 'claim',
    claim_id: stableId('claim', section, factIds),
    section,
    text: deterministicText, // Keep deterministic for validation
    deterministic_text: deterministicText,
    fact_ids: factIds,
    claim_mode: 'FACT_RENDERED',
    // Store optimization separately, applied after validation passes
    _optimization_pending: provider ? { facts: claimFacts } : null
  };
}

// Validation still uses deterministic_text
// UI can optionally show optimized_text after validation passes
```

### Safety Boundaries
- **Critical constraint**: Optimization is **post-validation** only
- **Validation**: Always runs against deterministic `renderFact()` output
- **Tokens**: Optimized text must contain all numbers, units, negations, part names
- **Fallback**: Any validation failure → use deterministic text
- **Traceability**: Both deterministic and optimized text stored; validation uses deterministic
- **UI control**: Technician can toggle between deterministic and optimized view

### MVP Decision: DEFER
**Recommendation**: Implement optimization as **Phase 2 enhancement** after core safety proven.

**Rationale**:
1. Language optimization has highest fabrication risk
2. Deterministic rendering is already correct and sufficient
3. Other 4 enhancements deliver more value with lower risk
4. Can be added non-invasively later (post-validation layer)

---

## Implementation Priority & Roadmap

### Phase 1: High-Value, Low-Risk (Implement First)
1. **Smart Follow-up Questions** (Priority 1)
   - Highest user impact
   - Lowest fabrication risk (only ranks existing fields)
   - Clear fallback to current behavior
   - Estimated effort: 4 hours

2. **Term Disambiguation** (Priority 2)
   - Improves correction accuracy
   - Only filters existing candidates
   - No new failure modes
   - Estimated effort: 6 hours

### Phase 2: Medium Value (Implement After Phase 1 Proven)
3. **Report Section Selection** (Priority 3)
   - Cleaner reports with sparse data
   - Cannot drop required sections
   - Estimated effort: 4 hours

4. **Fact Conflict Resolution** (Priority 4)
   - Reduces technician friction
   - Always has human escalation path
   - Start with completion_status only
   - Estimated effort: 5 hours

### Phase 3: Optional (Consider for Future)
5. **Report Language Optimization** (Priority 5)
   - DEFER - Highest risk, optional value
   - Deterministic text already sufficient
   - Post-validation only if implemented
   - Estimated effort: 8 hours (if pursued)

---

## Testing Strategy

### For Each Enhancement

#### 1. Deterministic Fallback Tests
```javascript
test('enhancement X falls back to deterministic when provider is null', async () => {
  const result = await toolFunction({ 
    ...requiredParams, 
    provider: null 
  });
  // Assert result matches current deterministic behavior
});

test('enhancement X falls back when provider returns invalid JSON', async () => {
  const badProvider = {
    generateJson: async () => ({ data: 'not-an-object' })
  };
  const result = await toolFunction({ 
    ...requiredParams, 
    provider: badProvider 
  });
  // Assert deterministic fallback used
  assert.equal(result.warnings[0], 'Invalid model output was discarded...');
});

test('enhancement X falls back when provider throws error', async () => {
  const failProvider = {
    generateJson: async () => { 
      throw Object.assign(new Error('offline'), { code: 'OFFLINE' }); 
    }
  };
  const result = await toolFunction({ 
    ...requiredParams, 
    provider: failProvider 
  });
  // Assert deterministic fallback used
});
```

#### 2. Safety Boundary Tests
```javascript
test('follow-up questions cannot add fields not in missing list', async () => {
  const result = await validateReportInput({
    facts: [/* complete facts */],
    provider: attackProvider, // Returns questions for non-missing fields
    model: 'fake'
  });
  // Assert no questions for fields with data
});

test('section selection cannot add sections beyond config', async () => {
  const result = await planReportSections({
    facts: [...],
    provider: attackProvider, // Returns made-up section IDs
    model: 'fake'
  });
  // Assert only sections from config included
});

test('conflict resolution cannot synthesize new fact value', async () => {
  const resolution = await resolveFactConflict({
    conflictingFacts: [fact1, fact2],
    provider: attackProvider, // Returns new value
    model: 'fake'
  });
  // Assert resolution is NEEDS_TECHNICIAN or one of original fact_ids
});
```

#### 3. Backward Compatibility Tests
```javascript
test('enhanced tool returns compatible structure when provider is null', async () => {
  const resultOld = await toolFunction({ /* no provider */ });
  const resultNew = await toolFunctionEnhanced({ provider: null });
  
  // Assert core fields identical
  assert.deepEqual(
    Object.keys(resultOld.data).sort(),
    Object.keys(resultNew.data).filter(k => !k.endsWith('_mode')).sort()
  );
});
```

#### 4. End-to-End Contract Tests
```javascript
test('complete narration with LLM enhancements still passes all gates', async () => {
  const { validated } = await makeDraft(COMPLETE_NARRATION, ollamaProvider);
  assert.equal(validated.status, 'PASS');
  assert.equal(validated.data.provenance_coverage, 1);
});

test('sparse narration with LLM still generates proper follow-ups', async () => {
  const { inputValidation } = await makeDraft('换了电容。', ollamaProvider);
  assert.equal(inputValidation.status, 'NEEDS_MORE_INFO');
  assert.ok(inputValidation.data.follow_up_questions.length > 0);
  assert.ok(inputValidation.data.follow_up_questions.length <= 3);
});
```

---

## Rollout & Monitoring

### Gradual Rollout Plan
1. **Week 1**: Smart Follow-up Questions only, monitor for 3 days
2. **Week 2**: Add Term Disambiguation if Week 1 stable
3. **Week 3**: Add Section Selection if no regressions
4. **Week 4**: Add Conflict Resolution for completion_status only
5. **Future**: Consider Language Optimization as separate feature flag

### Monitoring Metrics
- `deterministic_fallback_rate`: % of calls that fell back (target: <5% in production)
- `llm_invalid_output_rate`: % of LLM responses that failed validation (target: <1%)
- `average_follow_up_questions`: Should stay ≤3, ideally more relevant
- `conflict_auto_resolution_rate`: % of conflicts resolved without human (target: 30-50%)
- `technician_override_rate`: % of LLM decisions technician manually changed (target: <10%)

### Feature Flags (Environment Variables)
```bash
HVAC_ENABLE_LLM_QUESTIONS=true|false      # Default: false for MVP
HVAC_ENABLE_LLM_DISAMBIGUATION=true|false  # Default: false
HVAC_ENABLE_LLM_SECTIONS=true|false        # Default: false
HVAC_ENABLE_LLM_CONFLICTS=true|false       # Default: false
HVAC_ENABLE_LLM_OPTIMIZATION=false         # Always false for now
```

---

## Code Modification Summary

### Files to Modify
1. `/tmp/hvac-repo/src/tools/validate-report-input.js`
   - Add `generateContextualQuestions()` function
   - Add provider/model parameters
   - Update return envelope with question generation mode

2. `/tmp/hvac-repo/src/tools/plan-report-sections.js`
   - Add `selectConditionalSections()` function
   - Add provider/model parameters
   - Update return envelope with selection mode

3. `/tmp/hvac-repo/src/tools/hvac-knowledge.js`
   - Add `buildTranscriptCorrectionCandidatesWithContext()` export
   - Add `groupCandidatesByContext()` helper
   - Keep original `buildTranscriptCorrectionCandidates()` for backward compat

4. `/tmp/hvac-repo/src/tools/resolve-fact-conflicts.js`
   - New file: `resolveFactConflict()` function

5. `/tmp/hvac-repo/src/tools/validate-report-input.js` (again)
   - Import and integrate `resolveFactConflict()`
   - Add `auto_resolved_conflicts` to return data

6. `/tmp/hvac-repo/src/server.js` (or API route handlers)
   - Pass `ollamaProvider` and `model` to enhanced tools
   - Add feature flag checks
   - Wire up environment variables

### Files to Create
1. `/tmp/hvac-repo/src/tools/resolve-fact-conflicts.js` - New conflict resolution module
2. `/tmp/hvac-repo/test/llm-enhancements.test.js` - New test suite for all 4 enhancements
3. `/tmp/hvac-repo/docs/LLM_INTEGRATION_DESIGN.md` - This document

### Estimated Total Effort
- Phase 1 (Questions + Disambiguation): **10 hours** implementation + 6 hours testing
- Phase 2 (Sections + Conflicts): **9 hours** implementation + 6 hours testing
- Documentation & Integration: **4 hours**
- **Total: 35 hours** for full Phases 1-2 implementation

---

## Security & Privacy Considerations

### Data Minimization
- LLM prompts receive **only** necessary data:
  - Field names and fact IDs (not full customer details)
  - Bounded value strings (max 1000 chars)
  - No audio, no customer names/addresses, no prices
  
### Prompt Injection Defense
- All LLM system prompts emphasize **JSON-only output**
- Tool validation rejects any output not matching expected schema
- LLM cannot change tool behavior (cannot add fields, cannot skip validators)
- User transcripts never concatenated into system prompts

### Audit Trail
- Every LLM call logged with:
  - Tool name, trace_id, timestamp
  - Provider/model used
  - Whether output accepted or rejected
  - Fallback reason if rejected
- Stored alongside existing tool trace records

---

## Success Criteria

### Technical Success
- [ ] All existing tests pass without modification
- [ ] New fallback tests achieve 100% coverage
- [ ] Safety boundary tests prevent all identified attack vectors
- [ ] Feature flags allow individual enhancement enable/disable

### User Experience Success
- [ ] Technicians report follow-up questions more relevant (subjective survey)
- [ ] Correction candidate sets reduced by 20-40% (fewer false positives)
- [ ] Section selection produces cleaner reports with sparse data
- [ ] Conflict resolution reduces manual decision count by 30-50%

### Safety Success
- [ ] Zero fabricated facts in 100+ test runs with LLM enhancements enabled
- [ ] Zero unauthorized data additions (new fields, new sections, new facts)
- [ ] 100% of invalid LLM outputs successfully caught by validators
- [ ] Deterministic fallback rate <5% in stable conditions

---

## Appendix: LLM Prompt Templates

### A. Smart Follow-up Questions Prompt
```
System: You rank missing HVAC service report fields by criticality.
Return only field priorities from the supplied missing_fields list.
Never invent fields, completion states, or technical recommendations.
Return JSON only.

User: {
  "missing_fields": ["customer_complaint", "test_results", "completion_status"],
  "uncertain_fact_ids": ["fact_abc", "fact_def"],
  "present_fields_summary": [
    { "field": "work_performed", "has_value": true },
    { "field": "parts_used", "has_value": true }
  ],
  "allowed_priorities": ["CRITICAL", "HIGH", "MEDIUM", "LOW"],
  "required_output": {
    "ranked_questions": [{
      "field": "field from missing_fields",
      "question": "Chinese question text",
      "priority": "CRITICAL|HIGH|MEDIUM|LOW",
      "reason": "Brief explanation"
    }]
  }
}
```

### B. Term Disambiguation Prompt
```
System: You filter HVAC term correction candidates using sentence context.
When multiple candidates target the same span or nearby spans, select the most appropriate.
Return only candidate_id values from the supplied list.
Do not invent candidates, add service facts, or change source spans.
Return JSON only.

User: {
  "raw_text": "检查发现运刑电容损坏，更换了一个三十五微法电容",
  "candidate_groups": [{
    "sentence": "更换了一个三十五微法电容",
    "sentence_span": { "start": 15, "end": 28 },
    "candidates": [
      {
        "candidate_id": "cap_001",
        "source_span": { "start": 20, "end": 25, "text": "三十五微法" },
        "candidate": "35 µF",
        "reason": "含数值与单位的格式候选",
        "risk": "CRITICAL_VALUE"
      }
    ]
  }],
  "disambiguation_hints": {
    "numbers_with_units": "数字通常需要单位：35微法→35 µF，220伏→220V",
    "brand_vs_generic": "品牌名通常出现在"换""用"等动词后",
    "tool_vs_part": "工具在"用X检查"，零件在"更换X""
  },
  "required_output": {
    "retained_candidate_ids": ["candidate_id"]
  }
}
```

### C. Section Selection Prompt
```
System: You decide whether sparse HVAC data warrants a dedicated report section.
Return only section inclusion decisions from the supplied candidate list.
Do not add sections, remove required sections, or invent data.
Return JSON only.

User: {
  "candidate_sections": [{
    "id": "refrigerant_record",
    "title": "制冷剂记录",
    "fields": ["refrigerant_record"],
    "manual_or_authorized_only": false
  }],
  "field_data_density": [{
    "section_id": "refrigerant_record",
    "fact_count": 1,
    "fields_with_data": ["refrigerant_record"],
    "has_substantial_content": false
  }],
  "required_output": {
    "decisions": [{
      "section_id": "section from candidate_sections",
      "include": true,
      "reason": "Brief Chinese explanation"
    }]
  }
}
```

### D. Conflict Resolution Prompt
```
System: You resolve HVAC completion_status conflicts by choosing the most recent or definitive statement.
Return only a fact_id from the supplied conflicting_facts list.
Do not invent completion states, combine facts, or add information.
Return JSON only.

User: {
  "field": "completion_status",
  "conflicting_facts": [
    {
      "fact_id": "fact_001",
      "value": "问题未解决，需要继续处理",
      "source_span": { "start": 10, "end": 25, "text": "问题未解决" },
      "source_refs": ["transcript:10-25"],
      "support_status": "DIRECT_TRANSCRIPT"
    },
    {
      "fact_id": "fact_002",
      "value": "问题已解决",
      "source_span": { "start": 45, "end": 55, "text": "问题已解决" },
      "source_refs": ["transcript:45-55"],
      "support_status": "DIRECT_TRANSCRIPT"
    }
  ],
  "context_hints": {
    "temporal_indicators": ["最后", "后来", "现在", "目前", "完工后"],
    "certainty_indicators": ["已确认", "实际上", "最终"]
  },
  "required_output": {
    "selected_fact_id": "fact_id from conflicting_facts",
    "reason": "Brief Chinese explanation of why this fact is preferred"
  }
}
```

---

## Document Control

**Version**: 1.0  
**Author**: Analysis of /tmp/hvac-repo for LLM integration design  
**Review Status**: Awaiting technical review  
**Next Review**: After Phase 1 implementation

**Change History**:
- 2026-09-18: Initial design document created

---

*End of LLM Integration Design Document*
