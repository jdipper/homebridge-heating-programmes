const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { discover, requestRuntime } = require('../homebridge-ui/server.js');

async function fixture(t) {
  // macOS's default temporary path can exceed the Unix socket length limit.
  const temporary = await fs.mkdtemp('/private/tmp/hpe-');
  const storage = await fs.realpath(temporary);
  const persist = path.join(storage, 'persist');
  await fs.mkdir(persist, { mode: 0o700 });
  const runtimePath=path.join(storage,'heating-runtime');await fs.mkdir(runtimePath,{mode:0o700});
  const descriptorPath = path.join(persist, 'HeatingProgrammesRuntime.json');
  const descriptor = { version: 1, plugin: '@jdipper/homebridge-heating-programmes', instanceId: '0123456789abcdef', pid: process.pid,
    token: 'a'.repeat(64), socketPath: path.join(runtimePath, 'heating-programmes.sock') };
  const calls = [];
  let reply = (request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ instanceId: descriptor.instanceId, thermostats: [] })); };
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) { chunks.push(chunk); }
    calls.push({ route: request.url, authorization: request.headers.authorization, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
    reply(request, response);
  });
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await fs.rm(storage, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(descriptor.socketPath, resolve); });
  await fs.chmod(descriptor.socketPath, 0o600);
  const save = async () => fs.writeFile(descriptorPath, JSON.stringify(descriptor), { mode: 0o600 });
  await save();
  return { storage, persist, descriptorPath, descriptor, calls, save, setReply: value => { reply = value; } };
}

test('UI discovers only the running private shared controller and sends its token locally', async t => {
  const f = await fixture(t);
  const descriptors = await discover(f.storage);
  assert.equal(descriptors.length, 1);
  const response = await requestRuntime(descriptors[0], '/thermostats', {});
  assert.equal(response.instanceId, f.descriptor.instanceId);
  assert.equal(f.calls[0].authorization, `Bearer ${f.descriptor.token}`);
  assert.deepEqual(f.calls[0].body, {});
  assert.equal(JSON.stringify(response).includes(f.descriptor.token), false);
});

test('UI discovery rejects descriptors and sockets readable by other users', async t => {
  const f = await fixture(t);
  await fs.chmod(f.descriptorPath, 0o644);
  assert.deepEqual(await discover(f.storage), []);
  await fs.chmod(f.descriptorPath, 0o600);
  await fs.chmod(f.descriptor.socketPath, 0o666);
  assert.deepEqual(await discover(f.storage), []);
});

test('UI discovery rejects a writable discovery directory', async t => {
  const f = await fixture(t);
  await fs.chmod(f.persist, 0o777);
  assert.deepEqual(await discover(f.storage), []);
});

test('UI refuses a substituted descriptor symlink', async t => {
  const f = await fixture(t);
  const target = path.join(f.persist, 'other.json');
  await fs.rename(f.descriptorPath, target);
  await fs.symlink(target, f.descriptorPath);
  assert.deepEqual(await discover(f.storage), []);
});

test('UI rejects foreign plugin, unexpected socket path, invalid token and dead PID', async t => {
  const f = await fixture(t);
  const original = { ...f.descriptor };
  for (const change of [{ plugin: '@jdipper/homebridge-tuya' }, { socketPath: path.join(f.persist, 'other.sock') }, { token: 'short' }, { pid: 2147483647 }]) {
    Object.assign(f.descriptor, original, change); await f.save();
    assert.deepEqual(await discover(f.storage), []);
  }
  assert.equal(f.calls.length, 0);
});

test('private provider operations and overrides are not exposed through the editor proxy', async t => {
  const f = await fixture(t);
  await assert.rejects(requestRuntime(f.descriptor, '/provider/apply', {}), /supported heating operation/);
  await assert.rejects(requestRuntime(f.descriptor, '/overrides/cancel', {}), /supported heating operation/);
  await assert.rejects(requestRuntime(f.descriptor, '/schedules/apply', { draft: 'x'.repeat(256 * 1024) }), /too large/);
  assert.equal(f.calls.length, 0);
});

test('editor proxy rejects a different runtime identity instead of showing its data', async t => {
  const f = await fixture(t);
  f.setReply((request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ instanceId: 'fedcba9876543210', thermostats: [] })); });
  await assert.rejects(requestRuntime(f.descriptor, '/thermostats', {}), /identity changed/);
});

test('editor proxy contains invalid and oversized runtime replies', async t => {
  const f = await fixture(t);
  f.setReply((request, response) => { response.writeHead(200, { 'Content-Type': 'text/plain' }); response.end('not JSON'); });
  await assert.rejects(requestRuntime(f.descriptor, '/thermostats', {}), /invalid response/);
  f.setReply((request, response) => { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('x'.repeat(4 * 1024 * 1024 + 1)); });
  await assert.rejects(requestRuntime(f.descriptor, '/thermostats', {}), /too much data/);
});

test('editor timeout does not automatically send a second write', async t => {
  const f = await fixture(t);
  f.setReply((request, response) => { setTimeout(() => { if (!response.destroyed) { response.end('{}'); } }, 30); });
  await assert.rejects(requestRuntime(f.descriptor, '/schedules/apply', { previewId: 'one-shot' }, 10), /did not respond/);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].body.previewId, 'one-shot');
});
