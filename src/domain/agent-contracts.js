import {
  contentAddressedId,
  copy,
  deepFreeze,
  requiredString,
  requiredTimestamp,
} from './contract-utils.js';

export function createAgentRun(input = {}) {
  const code = 'INVALID_AGENT_RUN';
  const state = copy(input.agent_state);
  if (!state || state.contract !== 'AuthoritativeAgentState' || state.session_id !== input.session_id) {
    throw Object.assign(new TypeError('AgentRun requires a matching AuthoritativeAgentState.'), { code });
  }
  const revision = Number(input.session_revision);
  if (!Number.isSafeInteger(revision) || revision < 0 || state.session_revision !== revision) {
    throw Object.assign(new TypeError('AgentRun requires an exact non-negative session revision.'), { code });
  }
  const body = {
    contract: 'AgentRun',
    contract_version: '1',
    authority: 'SERVER',
    session_id: requiredString(input.session_id, 'session_id', code),
    session_revision: revision,
    processing_version: requiredString(input.processing_version, 'processing_version', code),
    created_at: requiredTimestamp(input.created_at, 'created_at', code),
    agent_state: state,
  };
  return deepFreeze({ run_id: contentAddressedId('agent_run', body, input.run_id), ...body });
}
