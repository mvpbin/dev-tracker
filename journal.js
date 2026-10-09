const fields = ['summary', 'approach', 'reason', 'verification', 'pitfalls', 'next'];
const canonicalKey = value => process.platform === 'win32' ? value.toLowerCase() : value;

export function validateJournal(args, state, evidence) {
  if (typeof args.projectRoot !== 'string' || !evidence.root || canonicalKey(args.projectRoot) !== canonicalKey(evidence.root)) throw new Error('Journal projectRoot does not match the selected project');
  if (!state.nodes.some(node => node.id === args.nodeId)) throw new Error('Journal node does not exist in the selected project');
  if ((state.journal || []).length >= 10000) throw new Error('Journal limit reached; existing entries are preserved');
  const entry = { nodeId: args.nodeId };
  for (const field of fields) {
    const value = args[field] ?? '';
    const max = field === 'summary' ? 300 : 2000;
    if (typeof value !== 'string' || value.length > max || (field === 'summary' && !value.trim())) throw new Error(`Journal ${field} must be text with at most ${max} characters${field === 'summary' ? ' and cannot be empty' : ''}`);
    entry[field] = value.trim();
  }
  return entry;
}

export function selectJournal(state, evidence, { nodeId, query = '', offset = 0, limit = 5 } = {}) {
  if (nodeId !== undefined && typeof nodeId !== 'string') throw new Error('Journal nodeId must be text');
  if (typeof query !== 'string' || query.length > 200) throw new Error('Journal query must be text with at most 200 characters');
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 10) throw new Error('Journal offset must be nonnegative and limit must be between 1 and 10');
  const keyword = query.trim().toLowerCase();
  const matches = (state.journal || []).filter(entry => (nodeId === undefined || entry.nodeId === nodeId) && (!keyword || Object.values(entry).some(value => String(value || '').toLowerCase().includes(keyword)))).reverse();
  const entries = structuredClone(matches.slice(offset, offset + limit));
  return { entries, total: matches.length, offset, nextOffset: offset + entries.length < matches.length ? offset + entries.length : null, projectRoot: evidence.root };
}
