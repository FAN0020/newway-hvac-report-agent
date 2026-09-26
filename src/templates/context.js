import { templateFor } from '../../web/template-catalog.js';

/**
 * Deterministic metadata retrieval for predefined template corpora. The
 * corpus is selected from the immutable template binding before any query is
 * considered, so a query can never widen the retrieval scope.
 */
export function retrieveTemplateContext({ templateId, contextCorpusId, contextVersion, query = '' } = {}) {
  const template = templateFor(templateId);
  const corpus = template.contextCorpus;
  if (contextCorpusId && contextCorpusId !== corpus.id) throw Object.assign(new Error('Template context binding mismatch.'), { code: 'TEMPLATE_CONTEXT_MISMATCH', status: 400 });
  if (contextVersion && contextVersion !== corpus.version) throw Object.assign(new Error('Template context version mismatch.'), { code: 'TEMPLATE_CONTEXT_VERSION_MISMATCH', status: 400 });
  const terms = String(query).toLowerCase().split(/\s+/u).filter(Boolean);
  const ranked = corpus.sources.map((source) => {
    const text = `${source.title} ${source.usage}`.toLowerCase();
    const score = terms.length ? terms.filter((term) => text.includes(term)).length / terms.length : 0;
    return {
      templateId: template.templateId,
      contextCorpusId: corpus.id,
      contextVersion: corpus.version,
      title: source.title,
      url: source.url,
      summary: source.usage,
      provenance: source.provenance,
      score,
    };
  }).sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return {
    templateId: template.templateId,
    contextCorpusId: corpus.id,
    contextVersion: corpus.version,
    retrievalBoundary: corpus.retrievalBoundary,
    mayAssertJobFacts: false,
    query: String(query),
    results: ranked,
  };
}
