function categoryFor(template) {
  if (template.presentation?.operationalCategory) return template.presentation.operationalCategory;
  if (template.domain === 'HVAC') return 'HVAC';
  if (template.domain === 'SBS_BUS') return 'Bus';
  if (template.domain === 'SBS_RAIL') return 'Rail';
  return 'Other';
}

function organizationFor(template) {
  if (template.presentation?.organizationLabel) return template.presentation.organizationLabel;
  if (template.domain === 'HVAC') return 'Newway';
  if (String(template.domain || '').startsWith('SBS_')) return 'SBS Transit';
  return 'Organization';
}

function normalize(value) {
  return String(value || '').toLocaleLowerCase('en').normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/gu, ' ');
}

export function technicianTemplateProjection(template) {
  if (!template || template.status !== 'PUBLISHED' || template.presentation?.technicianVisible === false) return null;
  return {
    templateId: template.templateId,
    displayName: template.presentation?.displayName || template.name,
    description: template.presentation?.shortDescription || template.description || 'Organization-defined maintenance report.',
    organizationLabel: organizationFor(template),
    category: categoryFor(template),
    reportFamily: template.presentation?.reportFamily || template.name,
    searchAliases: [...(template.presentation?.searchAliases || [])],
  };
}

export function selectTechnicianTemplates(templates, { query = '', category = 'All' } = {}) {
  const normalizedQuery = normalize(query);
  const normalizedCategory = normalize(category);
  return templates
    .map((template) => ({ template, item: technicianTemplateProjection(template) }))
    .filter(({ item }) => Boolean(item))
    .filter(({ item }) => normalizedCategory === 'all' || normalize(item.category) === normalizedCategory)
    .filter(({ item, template }) => {
      if (!normalizedQuery) return true;
      const searchable = normalize([
        item.displayName,
        item.organizationLabel,
        item.category,
        item.reportFamily,
        item.description,
        ...item.searchAliases,
        template.domain,
      ].join(' '));
      return searchable.includes(normalizedQuery);
    })
    .map(({ item }) => item);
}

export function recentTechnicianTemplates(templates, recentTemplateIds, limit = 3) {
  const byId = new Map(selectTechnicianTemplates(templates).map((item) => [item.templateId, item]));
  const seen = new Set();
  const recent = [];
  for (const templateId of recentTemplateIds || []) {
    if (seen.has(templateId) || !byId.has(templateId)) continue;
    seen.add(templateId);
    recent.push(byId.get(templateId));
    if (recent.length === limit) break;
  }
  return recent;
}
