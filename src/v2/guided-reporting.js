/**
 * Deterministic V2 follow-up questions.
 *
 * RAG may reveal which report module is required, but it must never create a
 * service fact. These questions convert missing report modules into explicit
 * technician prompts. Answers re-enter the pipeline as technician-confirmed
 * facts.
 */

const BUS_QUESTIONS = Object.freeze({
  vehicle_identification: Object.freeze({ field: 'asset.registration_no', question: 'What is the vehicle registration or fleet identifier?' }),
  works_summary: Object.freeze({ field: 'work.description', question: 'Please summarise the maintenance task and the reason it was carried out.' }),
  inspection_findings: Object.freeze({ field: 'inspection_findings', question: 'What did the inspection find before the repair?' }),
  work_performed: Object.freeze({ field: 'work_performed', question: 'What work was actually performed? Include replaced parts only if they were used.' }),
  tests_results: Object.freeze({ field: 'test.result', question: 'What post-work test was performed and what was its observed result?' }),
  completion_state: Object.freeze({ field: 'completion.state', question: 'What is the confirmed completion state: completed, deferred, off-road, or out of service?' }),
  safety_hv_notes: Object.freeze({ field: 'safety.technician_notes', question: 'Were there any safety or high-voltage isolation observations? State “none observed” only if you personally confirmed this.' }),
  compliance_audit: Object.freeze({ field: 'compliance.audit_ref', question: 'Is there a checklist, audit, work-order, or compliance reference for this job?' }),
});

const RAIL_QUESTIONS = Object.freeze({
  asset_identification: Object.freeze({ field: 'asset.train_set', question: 'What are the line, train-set, car, or subsystem identifiers for this job?' }),
  works_summary: Object.freeze({ field: 'work.description', question: 'Please summarise the maintenance task and its trigger.' }),
  trigger_findings: Object.freeze({ field: 'inspection_findings', question: 'What fault, alert, or inspection finding triggered this work?' }),
  work_performed: Object.freeze({ field: 'work_performed', question: 'What work was actually performed? Include replaced parts only if they were used.' }),
  tests_results: Object.freeze({ field: 'test.result', question: 'What post-work verification was performed and what was its observed result?' }),
  track_access_record: Object.freeze({ field: 'access.approval', question: 'Was track access required, and what was the confirmed approval or reference?' }),
  completion_state_return_to_service: Object.freeze({ field: 'completion.state', question: 'What is the technician-confirmed completion or return-to-service state?' }),
  safety_ops_notes: Object.freeze({ field: 'safety.ops_notes', question: 'What safety or operational observations must be recorded? State “none observed” only if personally confirmed.' }),
  reliability_compliance: Object.freeze({ field: 'reliability.maintenance_note', question: 'Is there a reliability, compliance, or work-order reference that applies to this job?' }),
});

const QUESTIONS_BY_SCOPE = Object.freeze({
  SBS_BUS: BUS_QUESTIONS,
  SBS_RAIL: RAIL_QUESTIONS,
});

/**
 * Build technician follow-up questions for missing report modules.
 * Provenance is system-managed and deliberately never asked of a technician.
 */
export function buildFollowUpQuestions({ scopeId, missingSections = [] } = {}) {
  const catalog = QUESTIONS_BY_SCOPE[scopeId];
  if (!catalog) throw new Error(`Unknown V2 scope "${scopeId}".`);
  return Object.freeze(missingSections
    .map((sectionId) => {
      const prompt = catalog[sectionId];
      if (!prompt) return null;
      return Object.freeze({
        section_id: sectionId,
        field: prompt.field,
        question: prompt.question,
        answer_source: 'technician_confirmation',
      });
    })
    .filter(Boolean));
}

