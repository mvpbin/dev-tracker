import { writeFileSync, renameSync } from 'node:fs';

const events = new Set(['startup', 'listen', 'error', 'close', 'mcp_http']);
const stages = new Set(['desktop', 'server', 'mcp', 'backup', 'restore', 'export']);
const codes = new Set(['EACCES', 'EPERM', 'ENOENT', 'EEXIST', 'EADDRINUSE', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ABORT_ERR', 'ERR_SERVER_NOT_RUNNING']);
const names = new Set(['Error', 'TypeError', 'SyntaxError', 'RangeError', 'AbortError']);

export function createDiagnostics() {
  const entries = [];
  return {
    record(event, details = {}) {
      if (!events.has(event)) throw new Error('Unknown diagnostic event');
      const entry = { time: new Date().toISOString(), event, stage: stages.has(details.stage) ? details.stage : 'server' };
      if (event === 'error') {
        entry.name = names.has(details.error?.name) ? details.error.name : 'OTHER';
        entry.code = codes.has(details.error?.code) ? details.error.code : 'OTHER';
      }
      if (event === 'mcp_http') {
        entry.method = ['GET', 'POST', 'DELETE'].includes(details.method) ? details.method : 'OTHER';
        entry.status = Number.isInteger(details.status) && details.status >= 100 && details.status <= 599 ? details.status : 0;
        entry.durationMs = Number.isFinite(details.durationMs) ? Math.max(0, Math.min(86400000, Math.round(details.durationMs))) : 0;
      }
      entries.push(entry);
      if (entries.length > 200) entries.shift();
    },
    exportJSONL() { return entries.map(entry => JSON.stringify(entry)).join('\n') + (entries.length ? '\n' : ''); },
    save(file) {
      writeFileSync(file + '.tmp', this.exportJSONL(), { mode: 0o600 });
      renameSync(file + '.tmp', file);
    }
  };
}
