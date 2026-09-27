import { proposeStructuredAtomicFacts } from './structured-proposals.js';

export const SEMANTIC_EXTRACTOR_VERSION = 'semantic-extractor.v1';

// Providers may implement extractSemanticProposals directly or the structured
// JSON generation contract used by local Ollama and compatible cloud clients.
// The verifier and canonical fact contract stay outside the provider.
export class SemanticExtractor {
  constructor({ provider = null, model = '' } = {}) {
    this.provider = provider;
    this.model = model || provider?.model || '';
  }

  async extract({ scope_id: scopeId, transcript_id: transcriptId, raw_text: rawText,
    capture_context: captureContext = null, semantic_windows: semanticWindows = [],
    established_facts: establishedFacts = [], signal } = {}) {
    const provider = this.provider?.extractSemanticProposals
      ? {
          generateJson: async ({ prompt, model }) => {
            const input = JSON.parse(prompt);
            const result = await this.provider.extractSemanticProposals({
              model, raw_text: input.raw_text, semantic_windows: input.semantic_windows,
              established_facts: input.established_facts, signal,
            });
            return { provider: result?.provider || this.provider.name || 'semantic-extractor',
              model: result?.model || model,
              data: { facts: Array.isArray(result) ? result : result?.proposals || result?.facts || [] } };
          },
        }
      : this.provider;
    return proposeStructuredAtomicFacts({
      provider, model: this.model || (this.provider?.extractSemanticProposals ? 'provider-managed' : ''),
      scope_id: scopeId, transcript_id: transcriptId, raw_text: rawText,
      capture_context: captureContext, semantic_windows: semanticWindows,
      established_facts: establishedFacts, signal,
    });
  }
}
