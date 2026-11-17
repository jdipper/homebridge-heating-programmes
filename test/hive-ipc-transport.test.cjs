const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { HiveIpcTransport } = require('../dist/hive/HiveIpcTransport.js');

const zone = { id: 'test-zone', type: 'heating' };
const command = { schedule: {}, preconditions: {}, expiresAt: Date.now() + 60_000 };

async function fixture(t, options = {}) {
  // macOS's default per-user temporary path exceeds its Unix socket length limit.
  const root = await fs.mkdtemp(path.join(process.platform === 'darwin' ? '/private/tmp' : os.tmpdir(), 'hive-ipc-test-'));
  const persistDirectory = path.join(root, 'persist');
  await fs.mkdir(persistDirectory, { mode: 0o700 });
  const persist = await fs.realpath(persistDirectory);
  const runtime = path.join(root, 'heating-runtime');
  await fs.mkdir(runtime, {mode: 0o700});
  const socketPath = path.join(runtime, `hive-programmes-${process.pid}.sock`);
  const descriptorPath = path.join(persist, 'hive-programmes-runtime.json');
  const instanceId = 'a'.repeat(32);
  const token = 'b'.repeat(64);
  const seen = [];
  const server = http.createServer((req, res) => {
    let content = '';
    req.on('data', chunk => { content += chunk; });
    req.on('end', () => {
      seen.push({ route: req.url, method: req.method, body: JSON.parse(content) });
      assert.equal(req.headers.authorization, `Bearer ${token}`);
      assert.equal(req.headers['x-hive-programmes-instance'], instanceId);
      if (req.url === '/schedules/write') assert.equal(req.headers['x-hive-programmes-expires-at'], String(command.expiresAt));
      if (options.hang) return;
      const reply = options.reply ?? (req.url === '/products/read'
        ? { products: [{ ...zone, state: {}, props: {} }] }
        : { outcome: 'acknowledged', writeAttempted: true, httpStatus: 200, response: { schedule: {} } });
      res.writeHead(options.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ protocolVersion: 1, instanceId, ...reply }));
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  await fs.chmod(socketPath, 0o600);
  const descriptor = { version: 1, protocolVersion: 1, plugin: 'homebridge-hivehome-control', instanceId,
    pid: process.pid, socketPath, token,
    capabilities: { read: true, write: options.write ?? false, enrolledZoneIds: options.enrolled ?? [zone.id],
      ...(options.freshWritePreconditions === undefined ? {} : {freshWritePreconditions: options.freshWritePreconditions}) } };
  await fs.writeFile(descriptorPath, JSON.stringify({ ...descriptor, ...options.descriptor }), { mode: options.mode ?? 0o600 });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, runtime, persist, descriptorPath, descriptor,
    client: new HiveIpcTransport({ storagePath: root, timeoutMs: options.timeoutMs ?? 2_000 }), seen };
}

test('fresh write guard is private capability proof and is required again at dispatch', async t => {
  const {client, seen, descriptor, descriptorPath} = await fixture(t, {write: true, freshWritePreconditions: true});
  assert.equal(await client.supportsFreshWritePreconditions(), true);
  assert.equal(seen.length, 0);
  descriptor.capabilities.freshWritePreconditions = false;
  await fs.writeFile(descriptorPath, JSON.stringify(descriptor), {mode: 0o600});
  await assert.rejects(client.writeSchedule(zone, {...command, requireFreshPreconditions: true}),
    error => error.code === 'HIVE_FRESH_WRITE_GUARD_UNAVAILABLE' && error.outcome === 'not-sent');
  assert.equal(seen.length, 0);
});

test('guarded writes ask the runtime to preserve its fresh precondition check', async t => {
  const {client, seen} = await fixture(t, {write: true, freshWritePreconditions: true});
  await client.writeSchedule(zone, {...command, requireFreshPreconditions: true});
  assert.equal(seen.length, 1);
  assert.equal(seen[0].body.requireFreshPreconditions, true);
});

test('unadvertised providers retain the legacy path and cannot accept guarded writes', async t => {
  const {client, seen} = await fixture(t, {write: true});
  assert.equal(await client.supportsFreshWritePreconditions(), false);
  await assert.rejects(client.writeSchedule(zone, {...command, requireFreshPreconditions: true}), error => error.outcome === 'not-sent');
  assert.equal(seen.length, 0);
  await client.writeSchedule(zone, command);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].body.requireFreshPreconditions, undefined);
});

test('a malformed fresh-guard capability cannot authorize dispatch', async t => {
  const {client, seen} = await fixture(t, {write: true, freshWritePreconditions: 'true'});
  await assert.rejects(client.supportsFreshWritePreconditions(), error => error.outcome === 'not-sent');
  assert.equal(seen.length, 0);
});

for (const plugin of ['homebridge-hivehome-control', '@jdipper/homebridge-hivehome-control']) {
  test(`${plugin} read uses authenticated private IPC and does not reveal descriptor secrets`, async t => {
    const { client, seen } = await fixture(t, { descriptor: { plugin } });
    assert.equal((await client.readProducts())[0].id, zone.id);
    assert.deepEqual(await client.getCapabilities(), { read: true, write: false, enrolledZoneIds: [zone.id] });
    assert.deepEqual(seen, [{ route: '/products/read', method: 'POST', body: {} }]);
  });
}

test('rejects a public or symlinked runtime directory outside Homebridge persist before dispatch', async t => {
  const {client, seen, runtime} = await fixture(t);
  await fs.chmod(runtime, 0o755);
  await assert.rejects(client.readProducts(), error => error.outcome === 'not-sent');
  await fs.chmod(runtime, 0o700);
  await fs.rename(runtime, runtime + '-actual');
  await fs.symlink(runtime + '-actual', runtime);
  await assert.rejects(client.readProducts(), error => error.outcome === 'not-sent');
  assert.equal(seen.length, 0);
});

for (const [name, options] of [
  ['foreign plugin descriptor', { descriptor: { plugin: '@someone/other-plugin' } }],
  ['same package under a foreign scope', { descriptor: { plugin: '@someone/homebridge-hivehome-control' } }],
  ['scoped package name with an added suffix', { descriptor: { plugin: '@jdipper/homebridge-hivehome-control-other' } }],
  ['public scoped-provider descriptor', { descriptor: { plugin: '@jdipper/homebridge-hivehome-control' }, mode: 0o644 }],
  ['public descriptor', { mode: 0o644 }],
  ['outside socket path', { descriptor: { socketPath: '/tmp/unrelated-hive.sock' } }],
]) {
  test(`rejects ${name} before sending any request`, async t => {
    const { client, seen } = await fixture(t, options);
    await assert.rejects(client.readProducts(), error => error.outcome === 'not-sent');
    assert.equal(seen.length, 0);
  });
}

test('disabled uploads stop before IPC dispatch', async t => {
  const { client, seen } = await fixture(t);
  await assert.rejects(client.writeSchedule(zone, command), error => error.outcome === 'not-sent');
  assert.equal(seen.length, 0);
});

test('unenrolled zone stops before IPC dispatch', async t => {
  const { client, seen } = await fixture(t, { write: true, enrolled: [] });
  await assert.rejects(client.writeSchedule(zone, command), error => error.outcome === 'not-sent');
  assert.equal(seen.length, 0);
});

test('expired preview stops before IPC dispatch', async t => {
  const { client, seen } = await fixture(t, { write: true });
  await assert.rejects(client.writeSchedule(zone, { ...command, expiresAt: Date.now() - 1 }), error => error.outcome === 'not-sent');
  assert.equal(seen.length, 0);
});

for (const plugin of ['homebridge-hivehome-control', '@jdipper/homebridge-hivehome-control']) {
  test(`${plugin} acknowledged upload is sent exactly once and preserves raw cloud acknowledgement`, async t => {
    const { client, seen } = await fixture(t, { write: true, descriptor: { plugin } });
    assert.deepEqual(await client.writeSchedule(zone, command), { status: 200, body: { schedule: {} } });
    assert.deepEqual(seen, [{ route: '/schedules/write', method: 'POST', body: {
      deviceId: zone.id, type: zone.type, schedule: {}, preconditions: {},
    } }]);
  });
}

test('a provider rejection before its cloud write is classified as not sent', async t => {
  const { client, seen } = await fixture(t, { write: true, status: 403, reply: { outcome: 'rejected', writeAttempted: false } });
  await assert.rejects(client.writeSchedule(zone, command), error => error.outcome === 'not-sent');
  assert.equal(seen.length, 1);
});

test('uncertain provider outcome is not retried', async t => {
  const { client, seen } = await fixture(t, { write: true, reply: { outcome: 'unknown', writeAttempted: true } });
  await assert.rejects(client.writeSchedule(zone, command), error => error.outcome === 'unknown');
  assert.equal(seen.length, 1);
});

test('wrong response instance cannot confirm a possibly sent upload', async t => {
  const { client, seen } = await fixture(t, { write: true,
    reply: { instanceId: 'c'.repeat(32), outcome: 'acknowledged', writeAttempted: true, httpStatus: 200 } });
  await assert.rejects(client.writeSchedule(zone, command), error => error.outcome === 'unknown');
  assert.equal(seen.length, 1);
});

test('request deadline leaves a potentially sent upload unknown with no retry', async t => {
  const { client, seen } = await fixture(t, { write: true, hang: true, timeoutMs: 150 });
  await assert.rejects(client.writeSchedule(zone, command), error => error.outcome === 'unknown');
  assert.equal(seen.length, 1);
});
