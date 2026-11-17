const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const vm = require('node:vm');
const { createHash } = require('node:crypto');
const { HeatingController } = require('../dist/controller/Controller.js');
const { toEditor } = require('../dist/controller/EditorProgramme.js');
const { WEEKDAYS, programmeFingerprint } = require('../dist/programmes.js');
const { createThermostatControlPolicy } = require('../dist/controller/ControlPolicy.js');

async function temporaryPersist(prefix) {const parent=await fs.mkdtemp(prefix);const directory=path.join(parent,'persist');await fs.mkdir(directory,{mode:0o700});return directory;}
async function cleanupPersist(directory) {const parent=path.dirname(directory);if(path.basename(directory)!=='persist'||!/^hp[lo]-/.test(path.basename(parent)))throw Error('Unsafe test cleanup path');await fs.rm(parent,{recursive:true,force:true});}
const instance = '0123456789abcdef';
const target = 'wifi1234567890cdrjgm';
const week = () => Object.fromEntries(WEEKDAYS.map(day => [day, [
  { startMinute: 300, targetC: 20 }, { startMinute: 420, targetC: 12 },
  { startMinute: 960, targetC: 20 }, { startMinute: 1320, targetC: 12 },
]]));
const fingerprint = programme => createHash('sha256').update(JSON.stringify(toEditor(programme).days.map(day => [day.day, day.events]))).digest('hex');

class ReadOnlyProvider {
  constructor(id, deviceId) {
    this.id = id; this.title = id === 'tuya' ? 'FastWarm' : 'Hive'; this.calls = [];
    this.zone = { id: deviceId, name: `${this.title} room`, roomName: 'Sitting room', online: true,
      measuredC: 18, targetC: 20, mode: id === 'tuya' ? 'smart' : 'SCHEDULE', scheduled: true,
      readAt: Date.now(), programme: week(), fingerprint: id === 'tuya' ? fingerprint(week()) : programmeFingerprint(week()),
      writeEnabled: true, limits: { minC: 5, maxC: id === 'tuya' ? 40 : 32, stepC: 0.5 },
      periods: { min: id === 'tuya' ? 4 : 1, max: id === 'tuya' ? 4 : 6 } };
  }
  async list() { this.calls.push({ operation: 'list' }); return [structuredClone(this.zone)]; }
  async read(deviceId) { this.calls.push({ operation: 'read', deviceId }); this.zone.readAt = Date.now(); return structuredClone(this.zone); }
  async prepare() { this.calls.push({ operation: 'prepare' }); throw new Error('Compatibility attempted a write preview.'); }
  async apply() { this.calls.push({ operation: 'apply' }); throw new Error('Compatibility attempted a write.'); }
}

function legacyDocument(deviceId = target) {
  const programme = toEditor(week());
  return { version: 2, controls: createThermostatControlPolicy(true, false),
    profiles: { version: 1, anyoneHome: true, holiday: false, enabledDeviceIds: [deviceId], devices: {
      [deviceId]: { programmes: { home: programme, away: programme, holiday: programme },
        requestedProfile: 'home', confirmedProfile: null, confirmedProgramme: null, confirmedAt: null, inFlight: null, status: 'idle' },
    } }, rooms: { [deviceId]: { name: 'Sitting room', timeZone: 'Europe/London', clockVerified: true } }, overrides: {} };
}

async function fixture(t, options = {}) {
  const directory = await temporaryPersist('/private/tmp/hpl-');
  await fs.chmod(directory, 0o700);
  const sources = [];
  for (let index = 0; index < (options.sources ?? 1); index++) {
    const name = `TuyaThermostatProfiles.${index ? 'fedcba9876543210' : instance}.json`;
    const source = Buffer.from(JSON.stringify(legacyDocument(index ? 'secondroom' : target)));
    await fs.writeFile(path.join(directory, name), source, { mode: 0o600 });
    sources.push({ name, source });
  }
  const tuya = new ReadOnlyProvider('tuya', target), hive = new ReadOnlyProvider('hive', 'hive-zone');
  const controller = new HeatingController(directory, [tuya, hive], { warn() {} });
  t.after(async () => { await controller.close(); await cleanupPersist(directory); });
  await controller.start({ poll: false });
  const descriptorPath = path.join(directory, `TuyaRuntime.${instance}.json`);
  return { directory, descriptorPath, controller, tuya, hive, sources,
    descriptor: options.sources === 0 || options.sources > 1 ? undefined : JSON.parse(await fs.readFile(descriptorPath, 'utf8')) };
}

function request(descriptor, route, body = {}, token = descriptor.token) {
  return new Promise((resolve, reject) => {
    const wire = JSON.stringify(body);
    const req = http.request({ socketPath: descriptor.socketPath, path: route, method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(wire) } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(Buffer.from(chunk)));
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
    });
    req.setTimeout(1000, () => req.destroy(new Error('Local compatibility endpoint timed out.')));
    req.on('error', reject); req.end(wire);
  });
}

test('the alias keeps frozen descriptor identity while declaring shared read-only ownership', async t => {
  const f = await fixture(t);
  assert.equal(f.descriptor.version, 1);
  assert.equal(f.descriptor.plugin, '@jdipper/homebridge-tuya');
  assert.equal(f.descriptor.instanceId, instance);
  assert.equal(f.descriptor.pid, process.pid);
  assert.equal(f.descriptor.socketPath, path.join(path.dirname(f.directory),'heating-runtime', `tuya-${instance}.sock`));
  assert.match(f.descriptor.token, /^[a-f0-9]{64}$/);
  assert.equal(f.descriptor.compatibility, 'shared-read-only');
  assert.equal(f.descriptor.ownerPlugin, '@jdipper/homebridge-heating-programmes');
  assert.equal(f.descriptor.readOnly, true);
  for (const filename of [f.descriptorPath, f.descriptor.socketPath, path.join(f.directory, `SharedHeatingReadOnlyOwner.${instance}.json`)]) {
    const info = await fs.lstat(filename);
    assert.equal(info.mode & 0o077, 0);
    assert.equal(info.uid, process.getuid());
  }
  assert.equal((await fs.lstat(f.descriptor.socketPath)).isSocket(), true);
});

test('alias shows original FastWarm IDs and complete native days with the opaque native fingerprint', async t => {
  const f = await fixture(t);
  const response = await request(f.descriptor, '/thermostats');
  assert.equal(response.status, 200);
  assert.equal(response.body.instanceId, instance);
  assert.deepEqual(response.body.thermostats.map(room => room.id), [target]);
  const room = response.body.thermostats[0];
  assert.equal(room.schedule.complete, true);
  assert.ok(room.schedule.days.every(day => day.complete === true && day.events.length === 4));
  assert.equal(room.scheduleFingerprint, fingerprint(week()));
  assert.notEqual(room.scheduleFingerprint, programmeFingerprint(week()), 'wire fingerprint was not replaced with the canonical shared codec hash');
  assert.equal(JSON.stringify(response.body).includes(f.descriptor.token), false);
  assert.equal(f.controller.view().thermostats[0].id, `tuya:${target}`, 'main editor continues to use namespaced IDs');
});

test('the unchanged frozen probe validator accepts a fresh read from the alias', async t => {
  const f = await fixture(t);
  const started = Date.now();
  const read = await request(f.descriptor, '/schedules/read', { deviceIds: [target] });
  assert.equal(read.status, 200);
  await f.controller.idle();
  const response = await request(f.descriptor, '/thermostats');
  const frozenSource = await fs.readFile(path.join(__dirname, '../../npm-publication-20261108/boundary-preview/probe.cjs'), 'utf8');
  const start = frozenSource.indexOf('function validateProgramme('), end = frozenSource.indexOf('\nasync function programme(', start);
  assert.ok(start >= 0 && end > start);
  // Compile only the read-only validation function. The frozen file's executable
  // entry point and all cloud/API code are never evaluated by this test.
  const context = vm.createContext({ TARGET: target, EXPECTED_FINGERPRINT: fingerprint(week()), createHash,
    journal: {}, save() {}, Date, programmeVerifiedAt: 0 });
  vm.runInContext(`${frozenSource.slice(start, end)}\nthis.validate = validateProgramme;`, context);
  const validated = context.validate(response.body, started);
  assert.equal(validated.id, target);
  assert.equal(validated.sync.status, 'verified');
  assert.deepEqual(f.tuya.calls.filter(call => call.operation === 'read'), [{ operation: 'read', deviceId: target }]);
  assert.equal(f.hive.calls.some(call => call.operation === 'read'), false);
  assert.equal(f.tuya.calls.some(call => ['prepare', 'apply'].includes(call.operation)), false);
});

test('policy, profile, apply and other editor routes are rejected without dispatching writes', async t => {
  const f = await fixture(t);
  const before = f.controller.view();
  for (const route of ['/presence', '/holiday', '/profiles/save', '/schedules/apply', '/profiles/select', '/controls/settings', '/controls/recover', '/rooms/save']) {
    const result = await request(f.descriptor, route, { home: false, active: true, preview: true, deviceIds: [target], profile: 'away' });
    assert.equal(result.status, 400, route);
  }
  const after = f.controller.view();
  assert.deepEqual(after.presence, before.presence);
  assert.deepEqual(after.holiday, before.holiday);
  assert.deepEqual(after.thermostats[0].profiles, before.thermostats[0].profiles);
  assert.equal(f.tuya.calls.some(call => ['prepare', 'apply', 'read'].includes(call.operation)), false);
});

test('read route rejects profile verification, injected fields, unknown or namespaced device IDs', async t => {
  const f = await fixture(t);
  for (const body of [
    { deviceIds: [target], verifyProfile: 'home' }, { deviceIds: [target], preview: true },
    { deviceIds: [target], active: true }, { deviceIds: ['not-this-thermostat'] },
    { deviceIds: [`tuya:${target}`] }, { deviceIds: ['hive:hive-zone'] },
    { deviceIds: [] }, { deviceIds: target },
  ]) {
    const response = await request(f.descriptor, '/schedules/read', body);
    assert.equal(response.status, 400, JSON.stringify(body));
  }
  assert.equal(f.tuya.calls.some(call => ['prepare', 'apply', 'read'].includes(call.operation)), false);
});

test('wrong authentication cannot cause a native read or expose the view', async t => {
  const f = await fixture(t);
  const response = await request(f.descriptor, '/schedules/read', { deviceIds: [target] }, 'b'.repeat(64));
  assert.equal(response.status, 403);
  assert.equal(response.body.thermostats, undefined);
  assert.equal(f.tuya.calls.some(call => call.operation === 'read'), false);
});

test('close removes shared-owned alias files and leaves all migration source bytes unchanged', async t => {
  const f = await fixture(t);
  await f.controller.close();
  for (const filename of [f.descriptorPath, f.descriptor.socketPath, path.join(f.directory, `SharedHeatingReadOnlyOwner.${instance}.json`)]) {
    await assert.rejects(fs.stat(filename), error => error.code === 'ENOENT');
  }
  for (const source of f.sources) { assert.deepEqual(await fs.readFile(path.join(f.directory, source.name)), source.source); }
});

test('no alias is invented without a migration source or with multiple source instances', async t => {
  for (const sources of [0, 2]) {
    const f = await fixture(t, { sources });
    assert.equal((await fs.readdir(f.directory)).some(name => /^TuyaRuntime\./.test(name)), false);
    await f.controller.close();
  }
});

test('a live legacy household owner blocks migration without replacing its descriptor', async t => {
  const directory = await temporaryPersist('/private/tmp/hpo-');
  const descriptorPath = path.join(directory, `TuyaRuntime.${instance}.json`);
  const bytes = Buffer.from(JSON.stringify({ version: 1, pid: process.pid, token: 'c'.repeat(64), plugin: '@jdipper/homebridge-tuya' }));
  await fs.writeFile(descriptorPath, bytes, { mode: 0o600 });
  const controller = new HeatingController(directory, [new ReadOnlyProvider('tuya', target)], { warn() {} });
  t.after(async () => { await cleanupPersist(directory); });
  await assert.rejects(controller.start({ poll: false }), /Tuya household controller is still running/);
  assert.deepEqual(await fs.readFile(descriptorPath), bytes);
  assert.equal((await fs.readdir(directory)).includes('HeatingProgrammesRuntime.json'), false);
});
