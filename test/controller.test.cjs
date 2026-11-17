const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const {HeatingController} = require('../dist/controller/Controller.js');
const RuntimeServer = require('../dist/controller/RuntimeServer.js').default;
const {programmeFingerprint, WEEKDAYS} = require('../dist/programmes.js');
const {toEditor} = require('../dist/controller/EditorProgramme.js');
const {createThermostatControlPolicy} = require('../dist/controller/ControlPolicy.js');

const clone = value => structuredClone(value);
const programme = (temperature = 18.5) => Object.fromEntries(WEEKDAYS.map(day => [day, [
  {startMinute: 330, targetC: temperature}, {startMinute: 450, targetC: 7},
  {startMinute: 990, targetC: temperature}, {startMinute: 1290, targetC: 7},
]]));
const drafts = () => ({home: programme(18.5), away: programme(12), holiday: programme(10)});
async function temporaryPersist(prefix) {const parent=await fs.mkdtemp(path.join(process.platform==='darwin'?'/private/tmp':os.tmpdir(),prefix));const directory=path.join(parent,'persist');await fs.mkdir(directory,{mode:0o700});return directory;}
async function cleanupPersist(directory) {const parent=path.dirname(directory);if(path.basename(directory)!=='persist'||!path.basename(parent).startsWith('heating-'))throw Error('Unsafe test cleanup path');await fs.rm(parent,{recursive:true,force:true});}
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};

class FakeProvider {
  constructor(id, suffix = 'zone1') {
    this.id = id; this.title = id === 'tuya' ? 'FastWarm' : 'Hive';
    this.calls = []; this.previews = new Map(); this.outcomes = []; this.suffix = suffix;
    this.zone = {id: suffix, name: `${this.title} sitting room`, roomName: 'Sitting room', online: true,
      measuredC: 18.15, targetC: 18.5, mode: 'SCHEDULE', scheduled: true, readAt: Date.now(),
      programme: programme(), fingerprint: programmeFingerprint(programme()), writeEnabled: true,
      limits: {minC: 5, maxC: id === 'tuya' ? 40 : 32, stepC: 0.5}, periods: {min: id === 'tuya' ? 4 : 1, max: id === 'tuya' ? 4 : 6}};
  }
  async list() {this.calls.push({operation: 'list'}); if (this.listError) throw new Error(this.listError); return [clone(this.zone)];}
  async read(deviceId) {this.calls.push({operation: 'read', deviceId}); if (this.readError) throw new Error(this.readError); return clone(this.zone);}
  async prepare(deviceId, desired, expectedFingerprint, options = {}) {
    this.calls.push({operation: 'prepare', deviceId, desired: clone(desired), expectedFingerprint, options: clone(options)});
    if (this.beforePrepare) await this.beforePrepare();
    if (options.requireScheduled && (!this.zone.online || !this.zone.scheduled || !this.zone.writeEnabled)) {
      throw new Error('Automatic changes require an online thermostat in Scheduled mode with uploads enabled.');
    }
    if (expectedFingerprint && expectedFingerprint !== this.zone.fingerprint) throw new Error('BASELINE_CHANGED');
    const preview = {token: crypto.randomUUID(), deviceId, programme: clone(desired),
      expiresAt: Date.now() + (this.previewTtl ?? 300000), changesRequired: programmeFingerprint(desired) !== this.zone.fingerprint};
    this.previews.set(preview.token, preview);
    return clone(preview);
  }
  async apply(token) {
    const preview = this.previews.get(token);
    if (!preview) throw new Error('PREVIEW_CONSUMED');
    this.previews.delete(token);
    this.calls.push({operation: 'apply', desired: clone(preview.programme)});
    if (this.beforeApply) await this.beforeApply(preview);
    if (this.applyGate) await this.applyGate.promise;
    const outcome = this.outcomes.shift() ?? 'confirmed';
    if (outcome === 'throw') throw new Error('transport connection lost');
    if (outcome === 'confirmed' || outcome === 'unknown-matching') {
      this.zone.programme = clone(preview.programme);
      this.zone.fingerprint = programmeFingerprint(preview.programme);
      this.zone.readAt = Date.now();
    }
    return {status: outcome === 'unknown-matching' ? 'unknown' : outcome,
      reason: outcome === 'confirmed' ? 'Complete week confirmed' : 'Write outcome could not be verified',
      writeAttempted: outcome !== 'not-applied', readback: clone(this.zone)};
  }
  get writes() {return this.calls.filter(call => call.operation === 'apply');}
}

test('automatic selection prepares one guarded fresh baseline without a separate controller read', async () => {
  const tuya = new FakeProvider('tuya');
  tuya.zone.programmeWriteMode = 'grouped-events';
  await fixture([tuya], async ({controller}) => {
    tuya.calls = [];
    await controller.handle('/presence', {home: false});
    await settled(controller);
    assert.deepEqual(tuya.calls.map(call => call.operation), ['prepare', 'apply']);
    assert.deepEqual(tuya.calls[0].options, {requireScheduled: true});
    assert.equal(controller.view().thermostats[0].sync.confirmedProfile, 'away');
    assert.equal(controller.view().thermostats[0].programmeWriteMode, 'grouped-events');
  });
});

test('automatic selection refuses a manual mode appearing before guarded preparation', async () => {
  const tuya = new FakeProvider('tuya');
  await fixture([tuya], async ({controller}) => {
    tuya.beforePrepare = () => {tuya.zone.scheduled = false; tuya.zone.mode = 'hold';};
    await controller.handle('/presence', {home: false});
    await settled(controller);
    assert.equal(tuya.writes.length, 0);
    assert.match(controller.view().thermostats[0].sync.error, /Scheduled/);
  });
});

test('editing a draft during automatic preparation discards the owned baseline and sends no apply', async () => {
  const tuya = new FakeProvider('tuya');
  await fixture([tuya], async ({controller}) => {
    const entered = deferred(), gate = deferred(), discarded = [];
    tuya.beforePrepare = async () => {entered.resolve(); await gate.promise;};
    tuya.discard = async token => {discarded.push(token); tuya.previews.delete(token);};
    await controller.handle('/presence', {home: false}); await entered.promise;
    await controller.handle('/profiles/save', {deviceId: 'tuya:zone1', profile: 'away', schedule: toEditor(programme(11))});
    gate.resolve(); await settled(controller);
    assert.equal(tuya.writes.length, 0);
    assert.equal(discarded.length, 1);
    assert.equal(tuya.previews.size, 0, 'the provider must be able to release its per-device preparation lease');
    assert.match(controller.view().thermostats[0].sync.error, /changed during preparation/);
    await assert.rejects(tuya.apply(discarded[0]), /PREVIEW_CONSUMED/);
    assert.equal(tuya.writes.length, 0, 'discarded baseline tokens cannot be replayed');
  });
});

test('new household intent during preparation discards stale intent before applying the queued latest profile', async () => {
  const tuya = new FakeProvider('tuya');
  await fixture([tuya], async ({controller}) => {
    const entered = deferred(), gate = deferred(), discarded = []; let blocked = false;
    tuya.beforePrepare = async () => {if (!blocked) {blocked = true; entered.resolve(); await gate.promise;}};
    tuya.discard = async token => {discarded.push(token); tuya.previews.delete(token);};
    await controller.handle('/presence', {home: false}); await entered.promise;
    await controller.handle('/presence', {home: true});
    gate.resolve(); await settled(controller);
    assert.equal(discarded.length, 1);
    assert.equal(tuya.writes.length, 1);
    assert.deepEqual(tuya.writes[0].desired, drafts().home, 'the superseded Away programme must never be dispatched');
    assert.equal(tuya.previews.size, 0);
    assert.equal(controller.view().thermostats[0].sync.confirmedProfile, 'home');
    await assert.rejects(tuya.apply(discarded[0]), /PREVIEW_CONSUMED/);
    assert.equal(tuya.writes.length, 1);
  });
});

test('disabling a room during automatic preparation cancels and discards its baseline without a write', async () => {
  const tuya = new FakeProvider('tuya');
  await fixture([tuya], async ({controller}) => {
    const entered = deferred(), gate = deferred(), discarded = [];
    tuya.beforePrepare = async () => {entered.resolve(); await gate.promise;};
    tuya.discard = async token => {discarded.push(token); tuya.previews.delete(token);};
    await controller.handle('/presence', {home: false}); await entered.promise;
    await controller.handle('/profiles/save', {deviceId: 'tuya:zone1', profile: 'home',
      schedule: toEditor(drafts().home), enabled: false});
    gate.resolve(); await settled(controller);
    assert.equal(tuya.writes.length, 0);
    assert.equal(discarded.length, 1);
    assert.equal(tuya.previews.size, 0);
    assert.equal(controller.view().thermostats[0].enabled, false);
    await assert.rejects(tuya.apply(discarded[0]), /PREVIEW_CONSUMED/);
  });
});

test('an expired automatic preview is discarded and never dispatched or automatically replayed', async () => {
  const tuya = new FakeProvider('tuya');
  await fixture([tuya], async ({controller}) => {
    const discarded = []; tuya.previewTtl = -1;
    tuya.discard = async token => {discarded.push(token); tuya.previews.delete(token);};
    await controller.handle('/presence', {home: false}); await settled(controller);
    assert.equal(tuya.writes.length, 0);
    assert.equal(discarded.length, 1);
    assert.equal(tuya.previews.size, 0);
    assert.match(controller.view().thermostats[0].sync.error, /stopped before upload/);
    await controller.handle('/presence', {home: false}); await settled(controller);
    assert.equal(tuya.calls.filter(call => call.operation === 'prepare').length, 1);
    await assert.rejects(tuya.apply(discarded[0]), /PREVIEW_CONSUMED/);
    assert.equal(tuya.writes.length, 0);
  });
});

test('a durable in-flight save failure discards the owned preparation before any provider dispatch', async () => {
  const tuya = new FakeProvider('tuya');
  await fixture([tuya], async ({controller, directory}) => {
    const file = path.join(directory, 'HeatingProgrammes.json'), backup = `${file}.before-inflight`;
    const discarded = []; let blocked = false;
    tuya.discard = async token => {discarded.push(token); tuya.previews.delete(token);};
    tuya.beforePrepare = async () => {
      await fs.rename(file, backup); await fs.mkdir(file); blocked = true;
    };
    try {
      await controller.handle('/presence', {home: false}); await settled(controller);
      assert.equal(tuya.writes.length, 0);
      assert.equal(discarded.length, 1);
      assert.equal(tuya.previews.size, 0);
      await assert.rejects(tuya.apply(discarded[0]), /PREVIEW_CONSUMED/);
    } finally {
      if (blocked) {await fs.rm(file, {recursive: true}); await fs.rename(backup, file);}
    }
  });
});

function savedRoom(provider, enabled = true) {
  return {provider: provider.id, deviceId: provider.suffix, name: `${provider.title} custom room`,
    timeZone: 'Europe/London', clockVerified: true, profiles: drafts(), enabled,
    requestedProfile: 'home', confirmation: {profile: 'home', programme: programme(), at: Date.now() - 1000}};
}
async function settled(controller) {
  // A completed operation may start the queued latest household intent in finally().
  for (let index = 0; index < 4; index++) {await controller.idle(); await new Promise(resolve => setImmediate(resolve));}
}
async function fixture(providers, callback, options = {}) {
  const directory = await temporaryPersist('heating-controller-');
  await fs.chmod(directory, 0o700);
  let controller;
  try {
    if (options.seed !== false) {
      const controls = {...createThermostatControlPolicy(true, false), awayDelayMinutes: 0, ...options.controls};
      const rooms = Object.fromEntries(providers.map(provider => [`${provider.id}:${provider.suffix}`, savedRoom(provider, options.enabled !== false)]));
      await fs.writeFile(path.join(directory, 'HeatingProgrammes.json'), JSON.stringify({version: 1, controls, rooms}), {mode: 0o600});
    }
    controller = new HeatingController(directory, providers, {warn() {}});
    await controller.start({publishServer: false, poll: false, migrate: false});
    await callback({controller, directory, readState: async () => JSON.parse(await fs.readFile(path.join(directory, 'HeatingProgrammes.json'), 'utf8'))});
  } finally {if (controller) await controller.close(); await cleanupPersist(directory);}
}

test('offline restart keeps last-read programmes and permits draft editing without fresh confirmation', async () => {
  const directory = await temporaryPersist('heating-offline-cache-');
  const tuya = new FakeProvider('tuya');
  let first, second;
  try {
    await fs.chmod(directory, 0o700);
    first = new HeatingController(directory, [tuya], {warn() {}});
    await first.start({publishServer: false, poll: false, migrate: false});
    await first.handle('/profiles/save', {deviceId: 'tuya:zone1', profile: 'home', schedule: toEditor(programme())});
    await first.close(); first = undefined;
    tuya.listError = 'System unavailable';
    second = new HeatingController(directory, [tuya], {warn() {}});
    await second.start({publishServer: false, poll: false, migrate: false});
    const room = second.view().thermostats[0];
    assert.equal(room.online, false);
    assert.equal(room.writeEnabled, false);
    assert.equal(room.sync.confirmationMatchesRequested, false);
    assert.deepEqual(room.schedule.days, toEditor(programme()).days.map(day => ({...day, complete: true})));
    await second.handle('/profiles/save', {deviceId: 'tuya:zone1', profile: 'away', schedule: toEditor(programme(11))});
    assert.deepEqual(second.view().thermostats[0].profiles.away, toEditor(programme(11)));
    assert.equal(tuya.writes.length, 0);
  } finally {
    if (first) await first.close(); if (second) await second.close();
    await cleanupPersist(directory);
  }
});

test('a household deadline passing during slow startup requires review and is not replayed', async () => {
  const tuya = new FakeProvider('tuya');
  tuya.list = async () => {await new Promise(resolve => setTimeout(resolve, 80)); return [clone(tuya.zone)];};
  await fixture([tuya], async ({controller}) => {
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.match(controller.view().controls.recoveryRequired, /deadline passed/);
    assert.equal(tuya.writes.length, 0);
  }, {controls: {actualHome: false, effectiveHome: true, pendingAwayAt: Date.now() + 50}});
});

test('startup restores saved profiles and household intent but neither confirms nor writes hardware', async () => {
  const tuya = new FakeProvider('tuya'), hive = new FakeProvider('hive');
  await fixture([tuya, hive], async ({controller, readState}) => {
    assert.equal(tuya.writes.length + hive.writes.length, 0);
    const view = controller.view();
    assert.equal(view.presence.home, true);
    assert.equal(view.selectedProfile, 'home');
    assert.equal(view.thermostats.length, 2);
    for (const room of view.thermostats) {
      assert.equal(room.enabled, true);
      assert.equal(room.sync.confirmedProfile, null);
      assert.equal(room.sync.confirmationMatchesRequested, false);
      assert.deepEqual(room.profiles.away, toEditor(programme(12)));
      assert.equal(room.currentTemperature, 18.15);
    }
    assert.equal((await readState()).controls.actualHome, true);
  });
});

test('provider disconnect and reconnect refresh are read-only and preserve profiles', async () => {
  const tuya = new FakeProvider('tuya'), hive = new FakeProvider('hive');
  await fixture([tuya, hive], async ({controller}) => {
    hive.listError = 'Hive unavailable'; await controller.refresh();
    assert.equal(controller.view().thermostats.find(room => room.provider === 'hive').online, false);
    assert.match(controller.view().systemErrors.hive, /unavailable/);
    assert.equal(controller.view().thermostats.find(room => room.provider === 'tuya').online, true);
    hive.listError = null; await controller.refresh();
    assert.equal(controller.view().systemErrors.hive, undefined);
    assert.deepEqual(controller.view().thermostats.find(room => room.provider === 'hive').profiles.holiday, toEditor(programme(10)));
    assert.equal(tuya.writes.length + hive.writes.length, 0);
  });
});

test('clearing a custom name follows the provider room again and a refresh requests fresh room names', async () => {
  const tuya = new FakeProvider('tuya');
  let refreshes = 0;
  tuya.refresh = async () => {refreshes++; tuya.zone.roomName = 'Updated SmartLife room'; return [clone(tuya.zone)];};
  await fixture([tuya], async ({controller}) => {
    await controller.handle('/rooms/save', {deviceId: 'tuya:zone1', name: ''});
    assert.equal(controller.view().thermostats[0].name, 'Sitting room');
    await controller.handle('/rooms/refresh', {});
    assert.equal(refreshes, 1);
    assert.equal(controller.view().thermostats[0].name, 'Updated SmartLife room');
    assert.equal(tuya.writes.length, 0);
  });
});

test('buffered accepted measured and target reports keep their real times across repeated polls', async () => {
  const tuya = new FakeProvider('tuya');
  const at = Date.now() - 2000;
  tuya.zone.observations = [
    {at, currentTemperature: 17, sourceAt: at - 50, online: true, unit: 'c'},
    {at: at + 100, targetTemperature: 20, online: true, unit: 'c'},
    {at: at + 200, currentTemperature: 17.5, sourceAt: at + 150, online: true, unit: 'c'},
  ];
  await fixture([tuya], async ({controller}) => {
    const before = await controller.handle('/temperatures/history', {deviceId: 'tuya:zone1'});
    assert.equal(before.temperatureHistory.length, 3);
    assert.deepEqual(before.temperatureHistory.map(point => point.at), [at, at + 100, at + 200]);
    await controller.refresh(); await controller.refresh();
    const after = await controller.handle('/temperatures/history', {deviceId: 'tuya:zone1'});
    assert.deepEqual(after.temperatureHistory, before.temperatureHistory);
    assert.equal(tuya.writes.length, 0);
  });
});

test('distinct same-millisecond target reports are preserved once rather than replayed on every poll', async () => {
  const tuya = new FakeProvider('tuya');
  const at = Date.now() - 1000;
  tuya.zone.observations = [20, 21, 20].map(targetTemperature => ({id: crypto.randomUUID(), at, targetTemperature, online: true, unit: 'c'}));
  await fixture([tuya], async ({controller}) => {
    const before = await controller.handle('/temperatures/history', {deviceId: 'tuya:zone1'});
    assert.deepEqual(before.temperatureHistory.map(point => point.targetTemperature), [20, 21, 20]);
    await controller.refresh(); await controller.refresh();
    const after = await controller.handle('/temperatures/history', {deviceId: 'tuya:zone1'});
    assert.deepEqual(after.temperatureHistory, before.temperatureHistory);
  });
});

test('controller migrates the legacy FastWarm state once without treating cached confirmation as current', async () => {
  const directory = await temporaryPersist('heating-migrate-owner-'); await fs.chmod(directory, 0o700);
  const tuya = new FakeProvider('tuya');
  let controller;
  try {
    const sourceName = 'TuyaThermostatProfiles.0123456789abcdef.json';
    const source = {version: 2, controls: {...createThermostatControlPolicy(true, false), awayDelayMinutes: 13},
      profiles: {version: 1, anyoneHome: true, holiday: false, enabledDeviceIds: ['zone1'], devices: {
        zone1: {programmes: Object.fromEntries(Object.entries(drafts()).map(([key, week]) => [key, toEditor(week)])),
          confirmedProfile: 'home', confirmedProgramme: toEditor(programme()), confirmedAt: Date.now() - 1000, inFlight: null},
      }}, rooms: {zone1: {name: 'Saved FastWarm name', timeZone: 'Europe/London', clockVerified: true}}, overrides: {},
      history: {version: 1, devices: {zone1: {temperatures: [{at: Date.now() - 3000, online: true, currentTemperature: 17}],
        programmes: [{id: crypto.randomUUID(), at: Date.now() - 4000, source: 'draft', profile: 'home', programme: toEditor(programme())}]}}}};
    const bytes = JSON.stringify(source);
    await fs.writeFile(path.join(directory, sourceName), bytes, {mode: 0o600});
    controller = new HeatingController(directory, [tuya], {warn() {}});
    await controller.start({publishServer: false, poll: false});
    let view = controller.view();
    assert.equal(view.thermostats[0].name, 'Saved FastWarm name');
    assert.equal(view.thermostats[0].enabled, true);
    assert.equal(view.thermostats[0].sync.confirmedProfile, null);
    assert.equal(view.presence.awayDelayMinutes, 13);
    assert.deepEqual(view.thermostats[0].profiles.holiday, toEditor(programme(10)));
    assert.equal(view.migration.sourceFiles[0].sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
    assert.equal((await controller.handle('/temperatures/history', {deviceId: 'tuya:zone1'})).temperatureHistory[0].currentTemperature, 17);
    assert.equal(tuya.writes.length, 0);
    await controller.close(); controller = undefined;
    // Later changes to the legacy source must not overwrite a completed shared migration.
    source.rooms.zone1.name = 'Should not replace shared name';
    await fs.writeFile(path.join(directory, sourceName), JSON.stringify(source));
    controller = new HeatingController(directory, [tuya], {warn() {}});
    await controller.start({publishServer: false, poll: false});
    view = controller.view();
    assert.equal(view.thermostats[0].name, 'Saved FastWarm name');
    assert.equal(tuya.writes.length, 0);
  } finally {if (controller) await controller.close(); await cleanupPersist(directory);}
});

test('new Hive thermostat starts unenrolled and draft save does not change heating', async () => {
  const hive = new FakeProvider('hive'); hive.zone.writeEnabled = false;
  await fixture([hive], async ({controller}) => {
    const room = controller.view().thermostats[0];
    assert.equal(room.enabled, false);
    assert.deepEqual(room.profiles, {});
    await controller.handle('/profiles/save', {deviceId: 'hive:zone1', profile: 'holiday', schedule: toEditor(programme(10))});
    assert.equal(hive.writes.length, 0);
    await assert.rejects(controller.handle('/profiles/save', {deviceId: 'hive:zone1', profile: 'home', enabled: true,
      schedule: toEditor(programme())}), /all.*programmes|complete.*programmes/i);
    assert.equal(hive.writes.length, 0);
  }, {seed: false});
});

test('household Away and Holiday drive both providers with presence remembered under Holiday', async () => {
  const tuya = new FakeProvider('tuya'), hive = new FakeProvider('hive');
  await fixture([tuya, hive], async ({controller}) => {
    await controller.handle('/presence', {home: false}); await settled(controller);
    assert.equal(controller.view().selectedProfile, 'away');
    assert.equal(tuya.writes.at(-1).desired.monday[0].targetC, 12);
    assert.equal(hive.writes.at(-1).desired.monday[0].targetC, 12);
    await controller.handle('/holiday', {active: true}); await settled(controller);
    assert.equal(tuya.writes.at(-1).desired.monday[0].targetC, 10);
    assert.equal(hive.writes.at(-1).desired.monday[0].targetC, 10);
    const writes = tuya.writes.length + hive.writes.length;
    await controller.handle('/presence', {home: true}); await settled(controller);
    assert.equal(controller.view().selectedProfile, 'holiday');
    assert.equal(tuya.writes.length + hive.writes.length, writes);
    await controller.handle('/holiday', {active: false}); await settled(controller);
    assert.equal(controller.view().selectedProfile, 'home');
    assert.equal(tuya.writes.at(-1).desired.monday[0].targetC, 18.5);
    assert.equal(hive.writes.at(-1).desired.monday[0].targetC, 18.5);
    assert.ok(controller.view().thermostats.every(room => room.sync.confirmationMatchesRequested));
  });
});

test('Away grace, guest hold, preheat and Holiday return retain one household policy', async () => {
  const originalNow = Date.now; let clock = originalNow(); Date.now = () => clock;
  try {
    const hive = new FakeProvider('hive');
    await fixture([hive], async ({controller}) => {
      await controller.handle('/controls/settings', {awayDelayMinutes: 10});
      await controller.handle('/presence', {home: false}); await settled(controller);
      assert.equal(controller.view().selectedProfile, 'home');
      assert.equal(hive.writes.length, 0);
      assert.equal(controller.view().presence.pendingAwayAt, clock + 600000);
      clock += 11 * 60000;
      await controller.handle('/controls/settings', {awayDelayMinutes: 10}); await settled(controller);
      assert.equal(controller.view().selectedProfile, 'away');
      await controller.handle('/presence/hold', {until: clock + 20 * 60000}); await settled(controller);
      assert.equal(controller.view().selectedProfile, 'home');
      const returningAt = clock + 30 * 60000;
      await controller.handle('/holiday', {active: true, returnAt: returningAt, preheatMinutes: 5}); await settled(controller);
      assert.equal(controller.view().selectedProfile, 'holiday');
      clock = returningAt - 4 * 60000;
      await controller.handle('/controls/settings', {awayDelayMinutes: 10}); await settled(controller);
      assert.equal(controller.view().holiday.active, true);
      assert.equal(controller.view().holiday.preheating, true);
      assert.equal(controller.view().selectedProfile, 'home');
      clock = returningAt + 1000;
      await controller.handle('/controls/settings', {awayDelayMinutes: 10}); await settled(controller);
      assert.equal(controller.view().holiday.active, false);
      assert.equal(controller.view().selectedProfile, 'away');
      assert.equal(hive.writes.at(-1).desired.monday[0].targetC, 12);
    });
  } finally {Date.now = originalNow;}
});

test('split provider outcome confirms successful rooms and reports failed rooms without retry', async () => {
  const tuya = new FakeProvider('tuya'), hive = new FakeProvider('hive'); hive.outcomes.push('unknown');
  await fixture([tuya, hive], async ({controller}) => {
    await controller.handle('/presence', {home: false}); await settled(controller);
    const view = controller.view();
    const good = view.thermostats.find(room => room.provider === 'tuya'), failed = view.thermostats.find(room => room.provider === 'hive');
    assert.equal(good.sync.confirmationMatchesRequested, true);
    assert.equal(failed.sync.confirmationMatchesRequested, false);
    assert.equal(failed.sync.status, 'failed');
    assert.match(failed.sync.error, /Do not automatically retry/);
    await controller.refresh(); await settled(controller);
    assert.equal(tuya.writes.length, 1); assert.equal(hive.writes.length, 1);
  });
});

test('unknown outcome is not confirmed by matching readback or retried after another policy choice', async () => {
  const hive = new FakeProvider('hive'); hive.outcomes.push('unknown-matching');
  await fixture([hive], async ({controller}) => {
    await controller.handle('/presence', {home: false}); await settled(controller);
    assert.equal(hive.zone.programme.monday[0].targetC, 12);
    assert.equal(controller.view().thermostats[0].sync.confirmationMatchesRequested, false);
    await controller.refresh();
    await controller.handle('/holiday', {active: true}); await settled(controller);
    assert.equal(hive.writes.length, 1);
    assert.match(controller.view().thermostats[0].sync.error, /previous programme operation needs review/);
  });
});

test('manual previews are single-use, expire and are invalidated when saved drafts change', async () => {
  const hive = new FakeProvider('hive');
  await fixture([hive], async ({controller}) => {
    let result = await controller.handle('/schedules/apply', {preview: true, profile: 'away', deviceIds: ['hive:zone1']});
    const first = result.preview.id;
    await controller.handle('/schedules/apply', {previewId: first}); await settled(controller);
    await assert.rejects(controller.handle('/schedules/apply', {previewId: first}), /expired/i);
    assert.equal(hive.writes.length, 1);
    hive.previewTtl = -1;
    result = await controller.handle('/schedules/apply', {preview: true, profile: 'holiday', deviceIds: ['hive:zone1']});
    await assert.rejects(controller.handle('/schedules/apply', {previewId: result.preview.id}), /expired/i);
    hive.previewTtl = 300000;
    result = await controller.handle('/schedules/apply', {preview: true, profile: 'holiday', deviceIds: ['hive:zone1']});
    await controller.handle('/profiles/save', {deviceId: 'hive:zone1', profile: 'holiday', schedule: toEditor(programme(11))});
    await assert.rejects(controller.handle('/schedules/apply', {previewId: result.preview.id}), /expired|review/i);
    assert.equal(hive.writes.length, 1);
  });
});

test('a programme changed externally after read blocks preview instead of writing over it', async () => {
  const hive = new FakeProvider('hive');
  await fixture([hive], async ({controller}) => {
    hive.zone.programme = programme(21); hive.zone.fingerprint = programmeFingerprint(hive.zone.programme);
    await assert.rejects(controller.handle('/schedules/apply', {preview: true, profile: 'away', deviceIds: ['hive:zone1']}), /BASELINE_CHANGED/);
    assert.equal(hive.writes.length, 0);
  });
});

test('household intent and in-flight operation are durably saved before any provider write', async () => {
  const hive = new FakeProvider('hive');
  await fixture([hive], async ({controller, readState}) => {
    hive.beforePrepare = async () => {assert.equal((await readState()).controls.actualHome, false);};
    hive.beforeApply = async () => {
      const saved = await readState();
      assert.equal(saved.controls.actualHome, false);
      assert.equal(saved.rooms['hive:zone1'].inFlight.profile, 'away');
      assert.equal(saved.rooms['hive:zone1'].requestedProfile, 'away');
    };
    await controller.handle('/presence', {home: false}); await settled(controller);
    assert.equal(hive.writes.length, 1);
    assert.equal((await readState()).rooms['hive:zone1'].inFlight, undefined);
  });
});

test('a failed policy save sends no commands and does not detach room state from a concurrent operation', async () => {
  const hive = new FakeProvider('hive');
  await fixture([hive], async ({controller, directory}) => {
    const file = path.join(directory, 'HeatingProgrammes.json');
    const backup = `${file}.before`;
    await fs.rename(file, backup); await fs.mkdir(file);
    await assert.rejects(controller.handle('/presence', {home: false}));
    assert.equal(hive.writes.length, 0);
    assert.equal(controller.view().presence.home, true);
    await fs.rm(file, {recursive: true}); await fs.rename(backup, file);
    await controller.handle('/presence', {home: false}); await settled(controller);
    assert.equal(controller.view().thermostats[0].sync.confirmationMatchesRequested, true);
  });
});

test('busy room applies only the latest queued household profile after its current operation', async () => {
  const hive = new FakeProvider('hive');
  await fixture([hive], async ({controller}) => {
    const entered = deferred(); hive.applyGate = deferred();
    hive.beforeApply = async () => {entered.resolve();};
    await controller.handle('/presence', {home: false}); await entered.promise;
    await controller.handle('/holiday', {active: true});
    await controller.handle('/presence', {home: true});
    await controller.handle('/holiday', {active: false});
    assert.equal(controller.view().thermostats[0].sync.queuedProfile, 'home');
    hive.applyGate.resolve(); await settled(controller);
    assert.equal(hive.writes.length, 2);
    assert.equal(hive.writes[0].desired.monday[0].targetC, 12);
    assert.equal(hive.writes[1].desired.monday[0].targetC, 18.5);
    assert.equal(controller.view().thermostats[0].sync.confirmationMatchesRequested, true);
  });
});

test('rollback of a rejected draft edit cannot detach an in-flight operation from persisted room state', async () => {
  const hive = new FakeProvider('hive');
  await fixture([hive], async ({controller, readState}) => {
    const entered = deferred(); hive.applyGate = deferred();
    hive.beforeApply = async () => {entered.resolve();};
    await controller.handle('/presence', {home: false}); await entered.promise;
    await assert.rejects(controller.handle('/profiles/save', {deviceId: 'hive:zone1', profile: 'home',
      schedule: toEditor(programme()), enabled: 'invalid'}), /explicitly enabled or disabled/);
    hive.applyGate.resolve(); await settled(controller);
    assert.equal(hive.writes.length, 1);
    assert.equal(controller.view().thermostats[0].sync.confirmationMatchesRequested, true,
      'operation result must update the restored current room object after rollback');
    assert.equal((await readState()).rooms['hive:zone1'].inFlight, undefined);
  });
});

test('profile verification racing a rejected edit updates the current room after transaction rollback', async () => {
  const hive = new FakeProvider('hive');
  await fixture([hive], async ({controller}) => {
    const entered = deferred(), gate = deferred();
    const originalRead = hive.read.bind(hive);
    hive.read = async id => {entered.resolve(); await gate.promise; return originalRead(id);};
    await controller.handle('/schedules/read', {deviceIds: ['hive:zone1'], verifyProfile: 'home'});
    await entered.promise;
    await assert.rejects(controller.handle('/profiles/save', {deviceId: 'hive:zone1', profile: 'away',
      schedule: toEditor(programme(12)), enabled: 'invalid'}));
    gate.resolve(); await settled(controller);
    assert.equal(controller.view().thermostats[0].sync.confirmationMatchesRequested, true);
    assert.equal(hive.writes.length, 0);
  });
});

test('a saved draft changed during profile verification cannot be reported as confirmed', async () => {
  const hive = new FakeProvider('hive');
  await fixture([hive], async ({controller}) => {
    const entered = deferred(), gate = deferred();
    const originalRead = hive.read.bind(hive);
    hive.read = async id => {entered.resolve(); await gate.promise; return originalRead(id);};
    await controller.handle('/schedules/read', {deviceIds: ['hive:zone1'], verifyProfile: 'home'});
    await entered.promise;
    await controller.handle('/profiles/save', {deviceId: 'hive:zone1', profile: 'home', schedule: toEditor(programme(20))});
    gate.resolve(); await settled(controller);
    assert.equal(controller.view().thermostats[0].sync.confirmationMatchesRequested, false);
    assert.equal(controller.view().thermostats[0].sync.status, 'failed');
    assert.equal(hive.writes.length, 0);
  });
});

test('household change during a reserved preview is applied when preparation releases the room', async () => {
  const hive = new FakeProvider('hive');
  await fixture([hive], async ({controller}) => {
    const entered = deferred(), gate = deferred(); let blocked = false;
    hive.beforePrepare = async () => {if (!blocked) {blocked = true; entered.resolve(); await gate.promise;}};
    const preview = controller.handle('/schedules/apply', {preview: true, profile: 'holiday', deviceIds: ['hive:zone1']});
    await entered.promise;
    await controller.handle('/presence', {home: false});
    assert.equal(controller.view().thermostats[0].sync.queuedProfile, 'away');
    gate.resolve(); await preview; await settled(controller);
    assert.equal(hive.writes.length, 1, 'latest automatic household change must not remain queued forever after a preview');
    assert.equal(hive.writes[0].desired.monday[0].targetC, 12);
  });
});

test('existing live Tuya household owner blocks startup before any device call', async () => {
  const directory = await temporaryPersist('heating-owner-'); await fs.chmod(directory, 0o700);
  const hive = new FakeProvider('hive');
  const controller = new HeatingController(directory, [hive], {warn() {}});
  try {
    await fs.writeFile(path.join(directory, 'TuyaRuntime.0123456789abcdef.json'), JSON.stringify({pid: process.pid}), {mode: 0o600});
    await assert.rejects(controller.start({publishServer: false, poll: false}), /still running/);
    assert.equal(hive.calls.length, 0);
  } finally {await cleanupPersist(directory);}
});

async function httpCall(socketPath, token, body = {}, requestPath = '/thermostats') {
  const encoded = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({socketPath, path: requestPath, method: 'POST', headers: {
      authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded),
    }}, res => {const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => resolve({status: res.statusCode, body: JSON.parse(Buffer.concat(chunks))}));});
    req.on('error', reject); req.end(encoded);
  });
}

test('runtime uses private authenticated socket and never returns its bearer token', async () => {
  const directory = await temporaryPersist('heating-runtime-'); await fs.chmod(directory, 0o700);
  const server = new RuntimeServer(directory, '0000000000000001', async () => ({ok: true}));
  try {
    await server.start();
    const file = path.join(directory, 'HeatingProgrammesRuntime.json');
    const descriptor = JSON.parse(await fs.readFile(file, 'utf8'));
    assert.equal((await fs.stat(file)).mode & 0o077, 0);
    assert.equal((await fs.stat(descriptor.socketPath)).mode & 0o077, 0);
    const rejected = await httpCall(descriptor.socketPath, 'wrong'); assert.equal(rejected.status, 403);
    const accepted = await httpCall(descriptor.socketPath, descriptor.token); assert.deepEqual(accepted, {status: 200, body: {ok: true}});
    assert.equal(JSON.stringify(accepted).includes(descriptor.token), false);
    const malformed = await httpCall(descriptor.socketPath, descriptor.token, []); assert.equal(malformed.status, 400);
  } finally {await server.close(); await cleanupPersist(directory);}
});

test('a Homebridge storage scan succeeds while the shared connection is listening', async () => {
  const directory = await temporaryPersist('heating-storage-scan-');
  const server = new RuntimeServer(directory, '0000000000000001', async () => ({ok: true}));
  try {
    await server.start();
    const descriptor = JSON.parse(await fs.readFile(path.join(directory, 'HeatingProgrammesRuntime.json'), 'utf8'));
    assert.equal(path.dirname(descriptor.socketPath), path.join(path.dirname(directory), 'heating-runtime'));
    assert.equal((await fs.stat(path.dirname(descriptor.socketPath))).mode & 0o777, 0o700);
    for (const file of await fs.readdir(directory)) assert.equal((await fs.lstat(path.join(directory, file))).isSocket(), false);
    const storageModule = require(require.resolve('node-persist', {paths: [path.dirname(require.resolve('homebridge'))]}));
    const first = storageModule.create();
    assert.doesNotThrow(() => first.initSync({dir: directory, forgiveParseErrors: true}));
    first.setItemSync('child-startup-check', {ok: true});
    const second = storageModule.create();
    assert.doesNotThrow(() => second.initSync({dir: directory, forgiveParseErrors: true}));
    assert.deepEqual(second.getItemSync('child-startup-check'), {ok: true});
  } finally {await server.close(); await cleanupPersist(directory);}
});

test('concurrent runtime starts admit exactly one household owner', async () => {
  const directory = await temporaryPersist('heating-runtime-owner-'); await fs.chmod(directory, 0o700);
  const first = new RuntimeServer(directory, '0000000000000001', async () => ({owner: 'first'}));
  const second = new RuntimeServer(directory, '0000000000000001', async () => ({owner: 'second'}));
  try {
    const results = await Promise.allSettled([first.start(), second.start()]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1,
      'descriptor probing alone must not allow both owners to start');
  } finally {await Promise.allSettled([first.close(), second.close()]); await cleanupPersist(directory);}
});
