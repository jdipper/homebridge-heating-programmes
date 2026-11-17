'use strict';

const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const PLUGIN = '@jdipper/homebridge-heating-programmes';
const ROUTES = [
  '/thermostats', '/rooms/refresh', '/rooms/save', '/temperatures/history', '/profiles/history',
  '/profiles/restore', '/schedules/read', '/profiles/save', '/schedules/apply', '/profiles/select',
  '/controls/settings', '/presence/hold', '/controls/recover', '/presence', '/holiday',
];

function owned(info, privateFile = true) {
  return (process.platform === 'win32' || (info.mode & (privateFile ? 0o077 : 0o022)) === 0)
    && (!process.getuid || info.uid === process.getuid());
}

/** Only the local owner's running controller can receive the private bearer token. */
async function discover(storagePath) {
  try {
    const persist = await fs.realpath(path.join(storagePath, 'persist'));
    const directory = await fs.stat(persist);
    if (!directory.isDirectory() || !owned(directory, false)) { return []; }
    const descriptorFile = await fs.open(path.join(persist, 'HeatingProgrammesRuntime.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
    let descriptor;
    try {
      const info = await descriptorFile.stat();
      if (!info.isFile() || !owned(info) || info.size > 16384) { return []; }
      descriptor = JSON.parse(await descriptorFile.readFile('utf8'));
    } finally {
      await descriptorFile.close();
    }
    const runtimePath = path.join(path.dirname(persist), 'heating-runtime');
    if (process.platform !== 'win32') {
      const directory = await fs.lstat(runtimePath);
      if (!directory.isDirectory() || directory.isSymbolicLink() || !owned(directory)) { return []; }
    }
    const expectedSocket = process.platform === 'win32'
      ? '\\\\.\\pipe\\homebridge-heating-programmes'
      : path.join(runtimePath, 'heating-programmes.sock');
    if (!descriptor || descriptor.version !== 1 || descriptor.plugin !== PLUGIN
      || typeof descriptor.instanceId !== 'string' || !/^[a-f0-9]{16}$/.test(descriptor.instanceId)
      || typeof descriptor.token !== 'string' || !/^[a-f0-9]{64}$/.test(descriptor.token)
      || !Number.isSafeInteger(descriptor.pid) || descriptor.pid <= 0
      || descriptor.socketPath !== expectedSocket) { return []; }
    if (process.platform !== 'win32') {
      const socket = await fs.lstat(expectedSocket);
      if (!socket.isSocket() || !owned(socket)) { return []; }
    }
    process.kill(descriptor.pid, 0);
    return [descriptor];
  } catch {
    // Restarts, missing files and invalid identities are unavailable, never an
    // excuse to send credentials to another socket or print the descriptor.
    return [];
  }
}

function requestRuntime(descriptor, requestPath, payload, timeoutMs = 120_000) {
  if (!ROUTES.includes(requestPath)) { return Promise.reject(new Error('Choose a supported heating operation.')); }
  const body = JSON.stringify(payload);
  if (Buffer.byteLength(body) > 256 * 1024) { return Promise.reject(new Error('The programme request is too large.')); }
  return new Promise((resolve, reject) => {
    let finished = false;
    let deadline;
    const settle = (error, result) => {
      if (finished) { return; }
      finished = true;
      clearTimeout(deadline);
      if (error) { reject(error); } else { resolve(result); }
    };
    const request = http.request({
      socketPath: descriptor.socketPath, path: requestPath, method: 'POST',
      headers: { Authorization: `Bearer ${descriptor.token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, response => {
      const chunks = [];
      let length = 0;
      response.on('data', chunk => {
        length += chunk.length;
        if (length > 4 * 1024 * 1024) {
          settle(new Error('The heating controller returned too much data.'));
          request.destroy(); response.destroy();
        } else { chunks.push(Buffer.from(chunk)); }
      });
      response.on('error', () => settle(new Error('The heating controller connection was interrupted.')));
      response.on('aborted', () => settle(new Error('The heating controller connection was interrupted.')));
      response.on('end', () => {
        if (finished) { return; }
        try {
          if (!response.headers['content-type']?.toLowerCase().includes('application/json')) { throw new Error(); }
          const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (!result || typeof result !== 'object' || Array.isArray(result)) { throw new Error(); }
          if (response.statusCode < 200 || response.statusCode >= 300) {
            settle(new Error(typeof result.error === 'string' ? result.error : 'The heating controller rejected the request.'));
          } else if (result.instanceId !== descriptor.instanceId) {
            settle(new Error('The heating controller identity changed. Refresh before continuing.'));
          } else { settle(null, result); }
        } catch { settle(new Error('The heating controller returned an invalid response.')); }
      });
    });
    deadline = setTimeout(() => { settle(new Error('The heating controller did not respond. Check each room’s status before trying another change.')); request.destroy(); }, timeoutMs);
    deadline.unref();
    request.setTimeout(timeoutMs, () => { settle(new Error('The heating controller did not respond.')); request.destroy(); });
    request.on('error', () => settle(new Error('The shared heating controller is unavailable. Start or restart Heating Programmes, then refresh.')));
    request.end(body);
  });
}

async function start() {
  const { HomebridgePluginUiServer, RequestError } = await import('@homebridge/plugin-ui-utils');
  class HeatingProgrammeUiServer extends HomebridgePluginUiServer {
    constructor() {
      super();
      this.onRequest('/api-usage', async () => require('./api-usage').readApiUsage(this.homebridgeStoragePath));
      this.onRequest('/instances', async () => ({ instances: (await discover(this.homebridgeStoragePath)).map(item => ({ id: item.instanceId })) }));
      for (const requestPath of ROUTES) {
        this.onRequest(requestPath, async payload => {
          try {
            if (!payload || typeof payload !== 'object' || Array.isArray(payload)) { throw new Error('The programme request must be an object.'); }
            const [descriptor] = await discover(this.homebridgeStoragePath);
            if (!descriptor || payload.instanceId && payload.instanceId !== descriptor.instanceId) {
              throw new Error('No matching shared heating controller is running. Start Heating Programmes, then refresh.');
            }
            const { instanceId, ...body } = payload;
            return await requestRuntime(descriptor, requestPath, body);
          } catch (error) {
            throw new RequestError(error.message || 'The shared heating controller is unavailable.', { status: 503 });
          }
        });
      }
      this.ready();
    }
  }
  new HeatingProgrammeUiServer();
}

module.exports = { ROUTES, discover, requestRuntime };
if (require.main === module) {
  start().catch(() => {
    console.error('The Heating Programmes editor could not start. Check that its UI dependency is installed.');
    process.exitCode = 1;
  });
}
