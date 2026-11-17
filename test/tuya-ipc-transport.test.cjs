const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const {TuyaIpcTransport} = require('../dist/tuya/TuyaIpcTransport.js');

const weekdays = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const week = targetC => Object.fromEntries(weekdays.map(day => [day,
  [360, 480, 1020, 1320].map(startMinute => ({startMinute, targetC}))]));
const desired = week(19);
const deviceId = 'fake-fastwarm-zone';
const previewToken = '67c8798f-e81f-47c9-a088-dd4eed03b736';

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(process.platform === 'darwin' ? '/private/tmp' : os.tmpdir(), 'tpi-'));
  await fs.mkdir(path.join(root, 'persist'), {mode: 0o700});
  const persist = await fs.realpath(path.join(root, 'persist'));
  const instanceId = 'a'.repeat(16);
  const token = 'b'.repeat(64);
  const runtime = path.join(root, 'heating-runtime');
  await fs.mkdir(runtime, {mode: 0o700});
  const socketPath = path.join(runtime, `tuya-programmes-${instanceId}.sock`);
  const descriptorPath = path.join(persist, `TuyaProgrammeProvider.${instanceId}.json`);
  const seen = [];
  const zone = {
    id: deviceId, name: 'Kitchen', roomName: 'Kitchen', online: true, measuredC: 18.1, targetC: 20,
    mode: 'smart', scheduled: true, readAt: Date.now(), programme: week(18), fingerprint: 'c'.repeat(64),
    writeEnabled: true, limits: {minC: 5, maxC: 40, stepC: 0.5}, periods: {min: 4, max: 4},
    temperatureReceivedAt: 1760000000000, temperatureReportedAt: 1759999999000, temperatureSource: 'mqtt',
  };
  const descriptor = {version: 1, protocolVersion: 1, plugin: '@jdipper/homebridge-tuya',
    instanceId, pid: process.pid, socketPath, token, ...options.descriptor};
  const server = http.createServer((req, res) => {
    let encoded = '';
    req.on('data', chunk => { encoded += chunk; });
    req.on('end', async () => {
      const body = JSON.parse(encoded);
      seen.push({route: req.url, method: req.method, body});
      assert.equal(req.headers.authorization, `Bearer ${token}`);
      assert.equal(req.headers['content-type'], 'application/json');
      if (options.disconnectApply && ['/provider/apply', '/provider/apply-automatic'].includes(req.url)) { req.socket.destroy(); return; }
      let payload;
      if (req.url === '/provider/list' || req.url === '/provider/refresh') payload = {zones: [zone]};
      else if (req.url === '/provider/read') payload = {zone};
      else if (req.url === '/provider/prepare' || req.url === '/provider/prepare-automatic') payload = {preview: {
        token: previewToken, deviceId, programme: body.programme, expiresAt: Date.now() + 300_000, changesRequired: true,
        ...(body.requireScheduled === true && !options.oldProvider ? {requireScheduled: true} : {}),
        ...(req.url === '/provider/prepare-automatic' ? {automaticFreshBaseline: true} : {}),
        ...(body.activeTarget ? {activeTarget: body.activeTarget} : {}),
      }};
      else if (req.url === '/provider/discard') payload = {discarded: true};
      else if (req.url === '/provider/cancel-automatic') payload = {cancelled: true};
      else if (req.url === '/provider/apply' || req.url === '/provider/apply-automatic') payload = {
        ...(req.url === '/provider/apply-automatic' ? {automaticFreshBaseline: true} : {}), result: {
        status: 'confirmed', reason: 'Full week and Scheduled mode confirmed.', writeAttempted: true,
        readback: {...zone, programme: desired, fingerprint: 'd'.repeat(64), readAt: Date.now(),
          ...(descriptor.capabilities?.activeTargetAlignment ? {targetC: 19, targetReadAt: Date.now()} : {})},
      }};
      const replacement = options.reply?.({route: req.url, body, payload, zone});
      await options.beforeReply?.({route: req.url, body});
      res.writeHead(typeof options.status === 'function' ? options.status(req.url) : options.status ?? 200,
        {'content-type': options.contentType ?? 'application/json'});
      const response = {protocolVersion: 1, instanceId, ...payload, ...replacement};
      res.end(options.rawReply ?? JSON.stringify(response));
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
  await fs.chmod(socketPath, options.socketMode ?? 0o600);
  await fs.writeFile(descriptorPath, JSON.stringify(descriptor), {mode: options.mode ?? 0o600});
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.rm(root, {recursive: true, force: true});
  });
  return {root, persist, descriptorPath, descriptor, socketPath, seen, zone,
    client: new TuyaIpcTransport({storagePath: root, ...(options.instanceId ? {instanceId: options.instanceId} : {})})};
}

test('device connection lists and reads the real shape over authenticated private IPC', async t => {
  const {client, seen, zone} = await fixture(t);
  assert.equal(client.id, 'tuya');
  assert.equal(client.title, 'FastWarm');
  assert.deepEqual(await client.list(), [zone]);
  assert.deepEqual(await client.read(deviceId), zone);
  assert.deepEqual(seen, [
    {route: '/provider/list', method: 'POST', body: {}},
    {route: '/provider/read', method: 'POST', body: {deviceId}},
  ]);
});

test('a pre-aborted automatic apply consumes its preview and releases the owned lease without an apply request', async t => {
  const {client, seen} = await fixture(t, {descriptor: {capabilities: {automaticFreshBaseline: true, automaticCancellation: true}}});
  const preview = await client.prepare(deviceId, desired, undefined, {requireScheduled: true});
  const abort = new AbortController(); abort.abort();
  assert.deepEqual(await client.apply(preview.token, {signal: abort.signal}), {
    status: 'not-applied', reason: 'The automatic selection was superseded before dispatch.', writeAttempted: false,
  });
  assert.deepEqual(seen.map(call => call.route), ['/provider/prepare-automatic', '/provider/discard']);
  assert.equal((await client.apply(preview.token)).writeAttempted, false);
});

test('superseding an in-flight capable apply sends one local cancellation while its result remains serialized', async t => {
  let enterApply, finishApply, enterCancel;
  const entered = new Promise(resolve => {enterApply = resolve;});
  const gate = new Promise(resolve => {finishApply = resolve;});
  const cancelled = new Promise(resolve => {enterCancel = resolve;});
  const {client, seen} = await fixture(t, {descriptor: {capabilities: {automaticFreshBaseline: true, automaticCancellation: true}},
    beforeReply: async ({route}) => {
      if (route === '/provider/apply-automatic') {enterApply(); await gate;}
      if (route === '/provider/cancel-automatic') enterCancel();
    }, reply: ({route, payload}) => route === '/provider/apply-automatic'
      ? {result: {...payload.result, status: 'unconfirmed', reason: 'Remaining commands cancelled.', superseded: true}} : {}});
  const preview = await client.prepare(deviceId, desired, undefined, {requireScheduled: true});
  const abort = new AbortController(); let completed = false;
  const apply = client.apply(preview.token, {signal: abort.signal}).then(result => {completed = true; return result;});
  await entered; abort.abort(); await cancelled;
  assert.equal(completed, false, 'cancellation does not release the original operation before its submitted request finishes');
  finishApply(); const result = await apply;
  assert.equal(result.status, 'unconfirmed'); assert.equal(result.writeAttempted, true);
  assert.equal(result.superseded, true);
  assert.deepEqual(seen.map(call => call.route), ['/provider/prepare-automatic', '/provider/apply-automatic', '/provider/cancel-automatic']);
  assert.deepEqual(seen.at(-1).body, {token: preview.token});
  abort.abort(); await new Promise(resolve => setImmediate(resolve)); assert.equal(seen.length, 3);
});

for (const [name, options] of [
  ['an un-aborted selection', {capability: true, status: 'unconfirmed'}],
  ['an unknown write', {capability: true, status: 'unknown', abort: true}],
  ['an older provider', {capability: false, status: 'unconfirmed', abort: true}],
]) test(`supersession proof cannot be forged for ${name}`, async t => {
  let enterApply, finishApply;
  const entered = new Promise(resolve => {enterApply = resolve;});
  const gate = new Promise(resolve => {finishApply = resolve;});
  const {client} = await fixture(t, {descriptor: {capabilities: {automaticFreshBaseline: true, automaticCancellation: options.capability}},
    beforeReply: async ({route}) => {if (route === '/provider/apply-automatic') {enterApply(); await gate;}},
    reply: ({route, payload}) => route === '/provider/apply-automatic'
      ? {result: {...payload.result, status: options.status, superseded: true}} : {}});
  const preview = await client.prepare(deviceId, desired, undefined, {requireScheduled: true});
  const abort = new AbortController(), applying = client.apply(preview.token, {signal: abort.signal});
  await entered; if (options.abort) abort.abort(); finishApply();
  const result = await applying;
  assert.equal(result.status, 'unknown'); assert.equal(result.superseded, undefined);
});

test('an older automatic provider finishes its submitted apply without guessing an unsupported cancellation route', async t => {
  let enterApply, finishApply;
  const entered = new Promise(resolve => {enterApply = resolve;});
  const gate = new Promise(resolve => {finishApply = resolve;});
  const {client, seen} = await fixture(t, {descriptor: {capabilities: {automaticFreshBaseline: true}},
    beforeReply: async ({route}) => {if (route === '/provider/apply-automatic') {enterApply(); await gate;}}});
  const preview = await client.prepare(deviceId, desired, undefined, {requireScheduled: true});
  const abort = new AbortController(), apply = client.apply(preview.token, {signal: abort.signal});
  await entered; abort.abort(); finishApply();
  assert.equal((await apply).status, 'confirmed');
  assert.deepEqual(seen.map(call => call.route), ['/provider/prepare-automatic', '/provider/apply-automatic']);
});

for (const [name, acknowledgement, knownNotApplied] of [
  ['an irreversible pre-claim cancellation', {cancelled: true, notApplied: true}, true],
  ['an already claimed cancellation', {cancelled: true, notApplied: false}, false],
  ['an older cancellation acknowledgement', {cancelled: true}, false],
  ['a contradictory acknowledgement', {cancelled: false, notApplied: true}, false],
  ['a failed cancellation request', {cancelled: true, notApplied: true, failed: true}, false],
]) test(`a cancellation overtaking apply uses proof only for ${name}`, async t => {
  let enterApply, releaseApply, prevented = false, nativeWrites = 0;
  const entered = new Promise(resolve => {enterApply = resolve;});
  const gate = new Promise(resolve => {releaseApply = resolve;});
  const {client, seen} = await fixture(t, {descriptor: {capabilities: {automaticFreshBaseline: true, automaticCancellation: true}},
    status: route => route === '/provider/apply-automatic' ? 400
      : route === '/provider/cancel-automatic' && acknowledgement.failed ? 503 : 200,
    reply: ({route}) => {
      if (route === '/provider/cancel-automatic') {prevented = true; return acknowledgement;}
      if (route === '/provider/apply-automatic' && !prevented) nativeWrites++;
      return {};
    }});
  // Separate IPC connections need not reach the provider in their creation
  // order. Hold transmission of apply until the cancellation reply arrives.
  const call = client.call.bind(client);
  client.call = async (descriptor, route, payload, writing) => {
    if (route === '/provider/apply-automatic') {enterApply(); await gate;}
    try {return await call(descriptor, route, payload, writing);}
    finally {if (route === '/provider/cancel-automatic') releaseApply();}
  };
  const preview = await client.prepare(deviceId, desired, undefined, {requireScheduled: true});
  const abort = new AbortController(), applying = client.apply(preview.token, {signal: abort.signal});
  await entered; abort.abort(); const result = await applying;
  assert.equal(result.status, knownNotApplied ? 'not-applied' : 'unknown');
  assert.equal(result.writeAttempted, !knownNotApplied);
  assert.equal(result.superseded, knownNotApplied ? true : undefined);
  assert.equal(nativeWrites, 0);
  assert.deepEqual(seen.map(call => call.route), ['/provider/prepare-automatic', '/provider/cancel-automatic', '/provider/apply-automatic']);
  assert.equal((await client.apply(preview.token)).writeAttempted, false, 'the original token remains consumed');
});

test('automatic preparation requires explicit Scheduled-baseline proof from the provider', async t => {
  const {client, seen} = await fixture(t);
  await client.prepare(deviceId, desired, undefined, {requireScheduled: true});
  assert.equal(seen.length, 1);
  assert.equal(seen[0].body.requireScheduled, true);
});

test('an old provider ignoring the automatic guard cannot supply an apply token', async t => {
  const {client, seen} = await fixture(t, {oldProvider: true});
  await assert.rejects(client.prepare(deviceId, desired, undefined, {requireScheduled: true}), /SCHEDULED_BASELINE_GUARD_REQUIRED/);
  const result = await client.apply(previewToken);
  assert.equal(result.writeAttempted, false);
  assert.deepEqual(seen.map(call => call.route), ['/provider/prepare']);
});

test('rejects a public or symlinked runtime directory outside Homebridge persist before dispatch', async t => {
  const {client, seen, socketPath} = await fixture(t);
  const runtime = path.dirname(socketPath);
  await fs.chmod(runtime, 0o755);
  await assert.rejects(client.list());
  await fs.chmod(runtime, 0o700);
  await fs.rename(runtime, runtime + '-actual');
  await fs.symlink(runtime + '-actual', runtime);
  await assert.rejects(client.list());
  assert.equal(seen.length, 0);
});

test('accepted temperature observation timestamps are preserved and never fabricated by polling', async t => {
  const {client, seen} = await fixture(t, {reply: ({payload, zone}) => {
    const {temperatureReceivedAt, temperatureReportedAt, temperatureSource, ...withoutObservation} = zone;
    return {zones: [withoutObservation]};
  }});
  const zone = (await client.list())[0];
  assert.equal(zone.temperatureReceivedAt, undefined);
  assert.equal(zone.temperatureReportedAt, undefined);
  assert.equal(zone.temperatureSource, undefined);
  assert.equal(seen.length, 1);
});

test('only validated packet-shape names are forwarded as device connection metadata', async t => {
  const {client} = await fixture(t, {reply: ({zone}) => ({zones: [{...zone, programmeWriteMode: 'grouped-events'}]})});
  assert.equal((await client.list())[0].programmeWriteMode, 'grouped-events');
});

test('an unknown packet-shape name cannot appear as a supported device mode', async t => {
  const {client} = await fixture(t, {reply: ({zone}) => ({zones: [{...zone, programmeWriteMode: 'whole-house'}]})});
  await assert.rejects(client.list(), /INVALID_WRITE_MODE/);
});

test('explicit room refresh uses its own route once and returns validated room names', async t => {
  const {client, seen} = await fixture(t, {reply: ({route, zone}) => route === '/provider/refresh'
    ? {zones: [{...zone, name: 'Dining Room', roomName: 'Dining Room'}]} : {}});
  assert.equal((await client.list())[0].roomName, 'Kitchen');
  assert.equal((await client.refresh())[0].roomName, 'Dining Room');
  assert.deepEqual(seen.map(request => request.route), ['/provider/list', '/provider/refresh']);
});

test('buffered current, target and online events preserve actual payloads and distinct same-ms identities', async t => {
  const at = Date.now();
  const observations = [
    {id: '76768e2f-e3b5-46f6-873f-59751ac866af', at: at - 1, sourceAt: at - 1000,
      currentTemperature: 18.1, online: true, unit: 'c'},
    {id: 'e325408f-b431-4eab-b2df-e6ed88b1d90c', at, targetTemperature: 19, online: true, unit: 'c'},
    {id: '02f5f7e4-8d80-45f2-80a2-f20313260957', at, targetTemperature: 20, online: true, unit: 'c'},
    {id: 'f42dcbbb-1d20-4892-a5c7-047644006c9f', at, online: false},
  ];
  const {client} = await fixture(t, {reply: ({zone}) => ({zones: [{...zone, observations}]})});
  const received = (await client.list())[0].observations;
  assert.deepEqual(received, observations);
  assert.deepEqual((await client.list())[0].observations, observations);
  received[0].currentTemperature = 99;
  assert.deepEqual((await client.list())[0].observations, observations);
});

for (const [name, observations] of [
  ['oversized ring', Array.from({length: 201}, () => ({at: Date.now(), online: true}))],
  ['invalid observation identity', [{id: 'not-a-uuid', at: Date.now(), online: true}]],
  ['invalid unit', [{at: Date.now(), currentTemperature: 18, online: true, unit: 'kelvin'}]],
  ['future source time', [{at: Date.now(), sourceAt: Date.now() + 400_000, online: true}]],
  ['invalid target', [{at: Date.now(), targetTemperature: 45, online: true, unit: 'c'}]],
  ['unknown observation fields', [{at: Date.now(), online: true, synthetic: true}]],
]) {
  test(`rejects ${name} instead of passing untrusted history to the controller`, async t => {
    const {client} = await fixture(t, {reply: ({zone}) => ({zones: [{...zone, observations}]})});
    await assert.rejects(client.list(), /INVALID_OBSERVATION/);
  });
}

for (const [name, options] of [
  ['foreign plugin identity', {descriptor: {plugin: '@someone/other-plugin'}}],
  ['public descriptor', {mode: 0o644}],
  ['public socket', {socketMode: 0o666}],
  ['outside socket path', {descriptor: {socketPath: '/tmp/unrelated-tuya.sock'}}],
  ['descriptor instance/filename mismatch', {descriptor: {instanceId: 'e'.repeat(16)}}],
  ['non-live owner process', {descriptor: {pid: 99_999_999}}],
  ['invalid protocol', {descriptor: {protocolVersion: 2}}],
]) {
  test(`rejects ${name} before any IPC dispatch`, async t => {
    const {client, seen} = await fixture(t, options);
    await assert.rejects(client.list(), /connection is unavailable/);
    assert.equal(seen.length, 0);
  });
}

test('rejects descriptor symlinks and group-writable persistence before dispatch', async t => {
  const {client, seen, descriptorPath, persist} = await fixture(t);
  await fs.rename(descriptorPath, `${descriptorPath}.private`);
  await fs.symlink(`${descriptorPath}.private`, descriptorPath);
  await assert.rejects(client.list(), /connection is unavailable/);
  assert.equal(seen.length, 0);
  await fs.rm(descriptorPath);
  await fs.rename(`${descriptorPath}.private`, descriptorPath);
  await fs.chmod(persist, 0o770);
  await assert.rejects(client.list(), /connection is unavailable/);
  assert.equal(seen.length, 0);
});

test('a socket symlink cannot redirect the client even within the persistence directory', async t => {
  const {client, seen, socketPath} = await fixture(t);
  await fs.rename(socketPath, `${socketPath}.private`);
  await fs.symlink(`${socketPath}.private`, socketPath);
  await assert.rejects(client.list(), /connection is unavailable/);
  assert.equal(seen.length, 0);
});

test('ambiguous discovery requires selecting one instance', async t => {
  const {client, seen, descriptorPath, descriptor, root} = await fixture(t);
  const second = descriptorPath.replace('a'.repeat(16), 'f'.repeat(16));
  await fs.writeFile(second, JSON.stringify(descriptor), {mode: 0o600});
  await assert.rejects(client.list(), /connection is unavailable/);
  assert.equal(seen.length, 0);
  const selected = new TuyaIpcTransport({storagePath: root, instanceId: 'a'.repeat(16)});
  assert.equal((await selected.list())[0].id, deviceId);
  assert.equal(seen.length, 1);
});

test('a prepared apply is dispatched exactly once and confirms the complete desired readback', async t => {
  const {client, seen} = await fixture(t);
  const preview = await client.prepare(deviceId, desired, 'c'.repeat(64));
  assert.equal(preview.token, previewToken);
  assert.deepEqual(preview.programme, desired);
  const result = await client.apply(preview.token);
  assert.equal(result.status, 'confirmed');
  assert.equal(result.writeAttempted, true);
  assert.deepEqual(result.readback.programme, desired);
  assert.deepEqual(seen, [
    {route: '/provider/prepare', method: 'POST', body: {deviceId, programme: desired, expectedFingerprint: 'c'.repeat(64)}},
    {route: '/provider/apply', method: 'POST', body: {token: previewToken}},
  ]);
  const replay = await client.apply(preview.token);
  assert.equal(replay.status, 'not-applied');
  assert.equal(replay.writeAttempted, false);
  assert.equal(seen.length, 2);
});

test('invalid complete-week drafts and unsupported targets stop before any IPC request', async t => {
  const {client, seen} = await fixture(t);
  for (const programme of [{monday: []}, week(40.5), {...desired, monday: []},
    {...desired, monday: [360, 480, 480, 1320].map(startMinute => ({startMinute, targetC: 19}))}]) {
    await assert.rejects(client.prepare(deviceId, programme));
  }
  await assert.rejects(client.prepare('../outside', desired));
  await assert.rejects(client.prepare(deviceId, desired, 'not-a-fingerprint'));
  assert.equal(seen.length, 0);
});

test('expired or altered previews cannot authorize application', async t => {
  const {client, seen} = await fixture(t, {reply: ({route, payload}) => route === '/provider/prepare'
    ? {preview: {...payload.preview, expiresAt: Date.now() - 1}} : {}});
  await assert.rejects(client.prepare(deviceId, desired), /INVALID_PREVIEW/);
  assert.equal((await client.apply(previewToken)).status, 'not-applied');
  assert.equal(seen.length, 1);
});

test('a preview returning an altered week is rejected without any write', async t => {
  const {client, seen} = await fixture(t, {reply: ({route, payload}) => route === '/provider/prepare'
    ? {preview: {...payload.preview, programme: week(20)}} : {}});
  await assert.rejects(client.prepare(deviceId, desired), /PREVIEW_PROGRAMME_MISMATCH/);
  assert.equal((await client.apply(previewToken)).writeAttempted, false);
  assert.equal(seen.length, 1);
});

test('runtime restart between preparation and application requires a new preview without dispatch', async t => {
  const {client, seen, descriptorPath, descriptor} = await fixture(t);
  const preview = await client.prepare(deviceId, desired);
  await fs.writeFile(descriptorPath, JSON.stringify({...descriptor, token: 'e'.repeat(64)}), {mode: 0o600});
  const result = await client.apply(preview.token);
  assert.equal(result.status, 'not-applied');
  assert.equal(result.writeAttempted, false);
  assert.equal(seen.length, 1);
});

test('a connection lost after apply dispatch is unknown and the write is never retried', async t => {
  const {client, seen} = await fixture(t, {disconnectApply: true});
  const preview = await client.prepare(deviceId, desired);
  const result = await client.apply(preview.token);
  assert.deepEqual(result, {status: 'unknown', reason: 'The FastWarm result could not be confirmed. Do not automatically retry.',
    writeAttempted: true});
  assert.equal((await client.apply(preview.token)).status, 'not-applied');
  assert.equal(seen.filter(request => request.route === '/provider/apply').length, 1);
});

for (const [name, patch] of [
  ['wrong runtime identity', {instanceId: 'f'.repeat(16)}],
  ['wrong device readback', {result: {status: 'confirmed', reason: 'ok', writeAttempted: true,
    readback: {id: 'other'}}}],
  ['mismatched programme', {readbackTarget: 20}],
  ['unscheduled mode', {scheduled: false}],
  ['offline readback', {online: false}],
]) {
  test(`${name} cannot confirm an already dispatched apply`, async t => {
    const {client, seen} = await fixture(t, {reply: ({route, payload}) => {
      if (route !== '/provider/apply') return {};
      if ('instanceId' in patch || 'result' in patch) return patch;
      return {result: {...payload.result, readback: {...payload.result.readback,
        ...(patch.readbackTarget ? {programme: week(patch.readbackTarget)} : patch)}}};
    }});
    const preview = await client.prepare(deviceId, desired);
    const result = await client.apply(preview.token);
    assert.equal(result.status, 'unknown');
    assert.equal(result.writeAttempted, true);
    assert.equal(seen.filter(request => request.route === '/provider/apply').length, 1);
  });
}

test('a stale malformed list or wrong response identity never becomes a zone snapshot', async t => {
  const {client, seen} = await fixture(t, {reply: ({route, zone}) => route === '/provider/list'
    ? {zones: [zone, zone]} : {instanceId: 'f'.repeat(16)}});
  await assert.rejects(client.list(), /DUPLICATE_ZONE/);
  await assert.rejects(client.read(deviceId), /READ_FAILED/);
  assert.equal(seen.length, 2);
});

for (const [name, options] of [
  ['non-JSON response', {rawReply: '<html>failed</html>'}],
  ['non-JSON content type', {contentType: 'text/html'}],
  ['non-success status', {status: 503}],
]) {
  test(`${name} is never treated as a successful device read`, async t => {
    const {client, seen} = await fixture(t, options);
    await assert.rejects(client.list(), /READ_FAILED/);
    assert.equal(seen.length, 1);
  });
}


test('capable automatic preparation and application use one queue-owned native baseline with explicit response proof', async t => {
  const {client, seen} = await fixture(t, {descriptor: {capabilities: {automaticFreshBaseline: true, automaticCancellation: true}}});
  const preview = await client.prepare(deviceId, desired, undefined, {requireScheduled: true});
  const abort = new AbortController();
  const result = await client.apply(preview.token, {signal: abort.signal});
  abort.abort(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(result.status, 'confirmed');
  assert.deepEqual(seen.map(call => call.route), ['/provider/prepare-automatic', '/provider/apply-automatic']);
  assert.deepEqual(seen[0].body, {deviceId, programme: desired, requireScheduled: true});
  assert.equal((await client.apply(preview.token)).writeAttempted, false);
  assert.equal(seen.length, 2);
});

test('manual fingerprint previews keep their original fresh conflict guard even with the automatic capability', async t => {
  const {client, seen} = await fixture(t, {descriptor: {capabilities: {automaticFreshBaseline: true}}});
  await client.prepare(deviceId, desired, 'c'.repeat(64), {requireScheduled: true});
  assert.deepEqual(seen.map(call => call.route), ['/provider/prepare']);
  assert.equal(seen[0].body.expectedFingerprint, 'c'.repeat(64));
});

test('automatic discard releases exactly its owned preview without sending an apply or replaying the discard', async t => {
  const {client, seen} = await fixture(t, {descriptor: {capabilities: {automaticFreshBaseline: true}}});
  const preview = await client.prepare(deviceId, desired, undefined, {requireScheduled: true});
  await client.discard(preview.token); await client.discard(preview.token);
  assert.deepEqual(seen.map(call => call.route), ['/provider/prepare-automatic', '/provider/discard']);
  assert.equal((await client.apply(preview.token)).writeAttempted, false);
});

test('an old provider retains guarded preparation/application and cannot accidentally enter the owned-baseline path', async t => {
  const {client, seen} = await fixture(t);
  const preview = await client.prepare(deviceId, desired, undefined, {requireScheduled: true});
  assert.equal((await client.apply(preview.token)).status, 'confirmed');
  assert.deepEqual(seen.map(call => call.route), ['/provider/prepare', '/provider/apply']);
});

test('malformed capability metadata fails before dispatch instead of enabling the cheaper write route', async t => {
  const {client, seen} = await fixture(t, {descriptor: {capabilities: {automaticFreshBaseline: 'true'}}});
  await assert.rejects(client.prepare(deviceId, desired, undefined, {requireScheduled: true}), /connection is unavailable/);
  assert.equal(seen.length, 0);
});

test('missing explicit owned-baseline preparation proof is rejected without an apply or fallback', async t => {
  const {client, seen} = await fixture(t, {descriptor: {capabilities: {automaticFreshBaseline: true}},
    reply: ({payload}) => ({preview: {...payload.preview, automaticFreshBaseline: false}})});
  await assert.rejects(client.prepare(deviceId, desired, undefined, {requireScheduled: true}), /OWNED_BASELINE_REQUIRED/);
  assert.deepEqual(seen.map(call => call.route), ['/provider/prepare-automatic']);
});

test('capability withdrawal after preparation stops before any automatic application', async t => {
  const {client, seen, descriptor, descriptorPath} = await fixture(t, {descriptor: {capabilities: {automaticFreshBaseline: true}}});
  const preview = await client.prepare(deviceId, desired, undefined, {requireScheduled: true});
  await fs.writeFile(descriptorPath, JSON.stringify({...descriptor, capabilities: {automaticFreshBaseline: false}}), {mode: 0o600});
  assert.equal((await client.apply(preview.token)).writeAttempted, false);
  assert.deepEqual(seen.map(call => call.route), ['/provider/prepare-automatic']);
});

test('a lost automatic apply connection is unknown and cannot be retried even when the same token is submitted again', async t => {
  const {client, seen} = await fixture(t, {descriptor: {capabilities: {automaticFreshBaseline: true}}, disconnectApply: true});
  const preview = await client.prepare(deviceId, desired, undefined, {requireScheduled: true});
  assert.equal((await client.apply(preview.token)).status, 'unknown');
  assert.equal((await client.apply(preview.token)).writeAttempted, false);
  assert.deepEqual(seen.map(call => call.route), ['/provider/prepare-automatic', '/provider/apply-automatic']);
});

test('a matching automatic readback without its runtime proof remains unknown and is never replayed', async t => {
  const {client, seen} = await fixture(t, {descriptor: {capabilities: {automaticFreshBaseline: true}},
    reply: ({route}) => route === '/provider/apply-automatic' ? {automaticFreshBaseline: false} : {}});
  const preview = await client.prepare(deviceId, desired, undefined, {requireScheduled: true});
  assert.equal((await client.apply(preview.token)).status, 'unknown');
  assert.equal(seen.filter(call => call.route === '/provider/apply-automatic').length, 1);
});

test('active-target context requires an advertised capability before any preparation request', async t => {
  const {client, seen} = await fixture(t);
  await assert.rejects(client.prepare(deviceId, desired, undefined, {requireScheduled: true,
    activeTarget: {timeZone: 'Europe/London'}}), /ACTIVE_TARGET_ALIGNMENT_REQUIRED/);
  assert.equal(seen.length, 0);
});

test('invalid or expanded active-target context cannot reach the provider', async t => {
  const {client, seen} = await fixture(t, {descriptor: {capabilities: {activeTargetAlignment: true}}});
  for (const activeTarget of [{timeZone: 'bad/zone'}, {timeZone: 'Europe/London', targetC: 19}, {}]) {
    await assert.rejects(client.prepare(deviceId, desired, undefined, {activeTarget}), /INVALID_ACTIVE_TARGET/);
  }
  assert.equal(seen.length, 0);
});

for (const [name, context] of [['missing', undefined], ['altered', {timeZone: 'America/New_York'}],
  ['expanded', {timeZone: 'Europe/London', targetC: 19}]]) {
  test(`a ${name} active-target preview echo cannot authorize an apply`, async t => {
    const {client, seen} = await fixture(t, {descriptor: {capabilities: {activeTargetAlignment: true}},
      reply: ({payload}) => ({preview: {...payload.preview, activeTarget: context}})});
    await assert.rejects(client.prepare(deviceId, desired, undefined, {activeTarget: {timeZone: 'Europe/London'}}),
      /ACTIVE_TARGET_GUARD_REQUIRED/);
    assert.equal((await client.apply(previewToken)).writeAttempted, false);
    assert.equal(seen.length, 1);
  });
}

test('a target-aware automatic apply carries the reviewed zone and confirms fresh native target proof without extra calls', async t => {
  const activeTarget = {timeZone: 'Europe/London'};
  const {client, seen} = await fixture(t, {descriptor: {capabilities: {automaticFreshBaseline: true,
    automaticCancellation: true, activeTargetAlignment: true}}});
  const preview = await client.prepare(deviceId, desired, undefined, {requireScheduled: true, activeTarget});
  assert.deepEqual(preview.activeTarget, activeTarget);
  assert.deepEqual(seen[0].body.activeTarget, activeTarget);
  const result = await client.apply(preview.token);
  assert.equal(result.status, 'confirmed');
  assert.equal(result.readback.targetC, 19);
  assert.ok(result.readback.targetReadAt <= Date.now());
  assert.deepEqual(seen.map(r => r.route), ['/provider/prepare-automatic', '/provider/apply-automatic']);
});

for (const [name, patch] of [['missing target time', {}], ['old target', {targetC: 20}],
  ['stale target time', {targetReadAt: 1}], ['future target time', {targetReadAt: Date.now() + 3600000}]]) {
  test(`${name} cannot confirm a target-aware apply or permit a replay`, async t => {
    const {client, seen} = await fixture(t, {descriptor: {capabilities: {activeTargetAlignment: true}},
      reply: ({route, payload}) => {
        if (route !== '/provider/apply') return {};
        const readback = {...payload.result.readback, ...patch};
        if (name === 'missing target time') delete readback.targetReadAt;
        return {result: {...payload.result, readback}};
      }});
    const preview = await client.prepare(deviceId, desired, undefined, {activeTarget: {timeZone: 'Europe/London'}});
    const result = await client.apply(preview.token);
    assert.equal(result.status, 'unknown'); assert.equal(result.writeAttempted, true);
    assert.equal((await client.apply(preview.token)).writeAttempted, false);
    assert.equal(seen.filter(r => r.route === '/provider/apply').length, 1);
  });
}

test('withdrawing active-target capability stops a reviewed apply before dispatch', async t => {
  const {client, seen, descriptor, descriptorPath} = await fixture(t, {descriptor: {capabilities: {activeTargetAlignment: true}}});
  const preview = await client.prepare(deviceId, desired, undefined, {activeTarget: {timeZone: 'Europe/London'}});
  await fs.writeFile(descriptorPath, JSON.stringify({...descriptor, capabilities: {activeTargetAlignment: false}}), {mode: 0o600});
  assert.equal((await client.apply(preview.token)).writeAttempted, false);
  assert.equal(seen.length, 1);
});
