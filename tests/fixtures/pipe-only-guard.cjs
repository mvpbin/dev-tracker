const net = require('node:net');
const { appendFileSync } = require('node:fs');
const original = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const input = Array.isArray(args[0]) ? args[0][0] : args[0];
  const pipePath = typeof input === 'object' ? input.path : typeof input === 'string' ? input : null;
  const namedPipe = typeof pipePath === 'string' && pipePath === process.env.PIPE_GUARD_PATH;
  appendFileSync(process.env.PIPE_GUARD_LOG, JSON.stringify({ pid: process.pid, timeUtc: new Date().toISOString(), namedPipe, tcp: !namedPipe }) + '\n');
  if (!namedPipe) throw Error('Test forbids TCP connections');
  return original.apply(this, args);
};
