'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const {
  WEEKDAYS, copyProgramme, programmeFingerprint, parseHiveProgramme, serializeHiveProgramme,
  HiveProgrammeAdapter, HiveTransportError,
} = require('../dist/index.js');

function week(target = 18.5) {
  return Object.fromEntries(WEEKDAYS.map(day => [day, [
    {startMinute: 300, targetC: target}, {startMinute: 420, targetC: 7},
    {startMinute: 990, targetC: target}, {startMinute: 1290, targetC: 7},
  ]]));
}
function product(id = 'heating-005cca', type = 'heating') {
  return {id, type, state: {name: 'Living Room', mode: 'SCHEDULE', target: 7,
    schedule: serializeHiveProgramme(week()), autoBoost: true, autoBoostTarget: 25},
  props: {temperature: 18.25, online: true, holidayMode: {active: false, enabled: false}}};
}
function padded(native) {
  return Object.fromEntries(WEEKDAYS.map(day => {
    const events = structuredClone(native[day]);
    while (events.length < 6) events.push(structuredClone(events.at(-1)));
    return [day, events];
  }));
}
class FakeTransport {
  constructor() {
    this.data = [product(), {id: 'hotwater-9600fe', type: 'hotwater', state: {mode: 'SCHEDULE', schedule: {example: true}}}];
    this.writes = [];
    this.reads = 0;
  }
  async readProducts() {
    this.reads++;
    if (this.readHook) return this.readHook();
    return structuredClone(this.data);
  }
  async writeSchedule(zone, command) {
    this.writes.push(structuredClone({zone, command}));
    if (this.writeHook) return this.writeHook(zone, command);
    this.data.find(p => p.id === zone.id).state.schedule = structuredClone(command.schedule);
    return {status: 200, body: {schedule: padded(command.schedule)}};
  }
}
function adapter(transport = new FakeTransport(), extra = {}) {
  return {transport, adapter: new HiveProgrammeAdapter(transport, {
    targetLimits: {minC: 5, maxC: 32, stepC: 0.5}, sleep: async () => {}, ...extra,
  })};
}

test('a private guard check outlasting preview expiry sends no cloud write', async () => {
  let now = 1000;
  const transport = new FakeTransport();
  transport.supportsFreshWritePreconditions = async () => {now = 2000; return true;};
  const {adapter: a} = adapter(transport, {now: () => now, previewTtlMs: 100});
  const preview = await a.prepare('heating-005cca', week(20));
  const result = await a.apply(preview.token);
  assert.equal(result.status, 'not-applied');
  assert.equal(result.reason, 'PREVIEW_EXPIRED');
  assert.equal(transport.reads, 1);
  assert.equal(transport.writes.length, 0);
});

test('native one-to-six event days round-trip without introducing midnight', () => {
  const programme = Object.fromEntries(WEEKDAYS.map((day, i) => [day,
    Array.from({length: i % 6 + 1}, (_, n) => ({startMinute: 300 + n * 120, targetC: 7 + n * 0.5}))]));
  const native = serializeHiveProgramme(programme);
  assert.deepEqual(parseHiveProgramme(native), copyProgramme(programme));
  assert.equal(native.monday[0].start, 300);
  assert.equal(parseHiveProgramme(native).saturday.length, 6);
});

test('only exact repeated terminal padding is removed from native schedules', () => {
  const original = serializeHiveProgramme(week());
  assert.deepEqual(parseHiveProgramme(padded(original)), copyProgramme(week()));
  const conflict = structuredClone(padded(original));
  conflict.monday.at(-1).value.target = 8;
  assert.throws(() => parseHiveProgramme(conflict), /STRICTLY_INCREASING/);
  const internalDuplicate = structuredClone(original);
  internalDuplicate.monday.splice(1, 0, structuredClone(internalDuplicate.monday[0]));
  assert.throws(() => parseHiveProgramme(internalDuplicate), /STRICTLY_INCREASING/);
});

test('incomplete weeks and unknown native event fields cannot silently disappear', () => {
  const native = structuredClone(serializeHiveProgramme(week()));
  delete native.sunday;
  assert.throws(() => parseHiveProgramme(native), /COMPLETE_NATIVE_HIVE_WEEK/);
  const extra = structuredClone(serializeHiveProgramme(week()));
  extra.monday[0].value.status = 'ON';
  assert.throws(() => parseHiveProgramme(extra), /UNSUPPORTED_NATIVE_HIVE_EVENT/);
});

test('room readings distinguish measured temperature from target and exclude hot water', async () => {
  const {adapter: a} = adapter();
  const zones = await a.readZones();
  assert.equal(zones.length, 1);
  assert.equal(zones[0].measuredC, 18.25);
  assert.equal(zones[0].targetC, 7);
  assert.equal(zones[0].name, 'Living Room');
  await assert.rejects(a.prepare('hotwater-9600fe', week(20)), /UNSUPPORTED_HIVE_ZONE_TYPE/);
});

test('changed programme sends one schedule-only command, verifies all days and preserves controls', async () => {
  const {adapter: a, transport: t} = adapter();
  const hotWaterBefore = structuredClone(t.data[1]);
  const preview = await a.prepare('heating-005cca', week(20));
  const result = await a.apply(preview.token);
  assert.equal(result.status, 'confirmed');
  assert.equal(result.acknowledged, true);
  assert.equal(result.readback.fingerprint, programmeFingerprint(week(20)));
  assert.equal(t.writes.length, 1);
  assert.deepEqual(Object.keys(t.writes[0].command).sort(), ['expiresAt', 'preconditions', 'schedule']);
  assert.deepEqual(t.writes[0].command.preconditions, {
    schedule: serializeHiveProgramme(week()), mode: 'SCHEDULE', target: 7,
    holiday: {active: false, enabled: false}, autoBoost: true, autoBoostTarget: 25,
    heatingHolidays: [{id: 'heating-005cca', holiday: {active: false, enabled: false}}],
  });
  assert.equal(t.writes[0].command.expiresAt, preview.expiresAt);
  assert.deepEqual(Object.keys(t.writes[0].zone).sort(), ['id', 'type']);
  assert.deepEqual(t.data[1], hotWaterBefore);
  assert.equal(t.data[0].state.mode, 'SCHEDULE');
  assert.equal(t.data[0].state.autoBoost, true);
  assert.equal(t.data[0].state.autoBoostTarget, 25);
});

test('private write preconditions use normalized baseline, null missing fields and binary-sorted heating IDs', async () => {
  const {adapter: a, transport: t} = adapter();
  const original = t.data[0];
  original.state.schedule = padded(original.state.schedule);
  delete original.state.autoBoost;
  delete original.state.autoBoostTarget;
  delete original.props.holidayMode;
  t.data.unshift(product('heating-a12345'), product('heating-Z12345'));
  const preview = await a.prepare('heating-005cca', week(20));
  const result = await a.apply(preview.token);
  assert.equal(result.status, 'confirmed');
  const command = t.writes[0].command;
  assert.equal(command.expiresAt, preview.expiresAt);
  assert.equal(command.preconditions.schedule.monday.length, 4);
  assert.deepEqual(command.preconditions.schedule, serializeHiveProgramme(week()));
  assert.equal(command.preconditions.holiday, null);
  assert.equal(command.preconditions.autoBoost, null);
  assert.equal(command.preconditions.autoBoostTarget, null);
  assert.deepEqual(command.preconditions.heatingHolidays.map(p => p.id), ['heating-005cca', 'heating-Z12345', 'heating-a12345']);
  assert.equal(command.preconditions.heatingHolidays[0].holiday, null);
});

test('write preconditions copy and freeze nested native metadata before transport dispatch', async () => {
  const {adapter: a, transport: t} = adapter();
  t.data[0].props.holidayMode.window = {start: 100, days: [1, 2]};
  let observed;
  t.writeHook = async (zone, command) => {
    observed = command;
    t.data[0].state.schedule = structuredClone(command.schedule);
    t.data[0].props.holidayMode.window.start = 200;
    return {status: 200, body: {schedule: padded(command.schedule)}};
  };
  const result = await a.apply((await a.prepare('heating-005cca', week(20))).token);
  assert.equal(result.status, 'unconfirmed');
  assert.equal(observed.preconditions.holiday.window.start, 100);
  assert.equal(observed.preconditions.heatingHolidays[0].holiday.window.start, 100);
  assert.equal(Object.isFrozen(observed), true);
  assert.equal(Object.isFrozen(observed.preconditions), true);
  assert.equal(Object.isFrozen(observed.preconditions.holiday.window.days), true);
  assert.equal(Object.isFrozen(observed.preconditions.heatingHolidays), true);
});

test('an already matching programme is freshly confirmed without a redundant write', async () => {
  const {adapter: a, transport: t} = adapter();
  const preview = await a.prepare('heating-005cca', week());
  assert.equal(preview.changesRequired, false);
  const result = await a.apply(preview.token);
  assert.equal(result.status, 'confirmed');
  assert.equal(result.writeAttempted, false);
  assert.equal(result.acknowledged, false);
  assert.equal(t.writes.length, 0);
});

test('a changed native week conflicts with the preview and causes no upload', async () => {
  const {adapter: a, transport: t} = adapter();
  const preview = await a.prepare('heating-005cca', week(20));
  t.data[0].state.schedule = serializeHiveProgramme(week(21));
  const result = await a.apply(preview.token);
  assert.equal(result.status, 'conflict');
  assert.equal(t.writes.length, 0);
});

test('target, demand settings and native Holiday changes all block a stale preview', async t => {
  for (const mutation of [p => {p.state.target = 8;}, p => {p.state.autoBoost = false;}, p => {p.props.holidayMode.active = true;}]) {
    await t.test('baseline control mutation', async () => {
      const {adapter: a, transport} = adapter();
      const preview = await a.prepare('heating-005cca', week(20));
      mutation(transport.data[0]);
      const result = await a.apply(preview.token);
      assert.notEqual(result.status, 'confirmed');
      assert.equal(result.writeAttempted, false);
      assert.equal(transport.writes.length, 0);
    });
  }
});

test('offline, non-scheduled or unknown Holiday zones cannot prepare writes', async t => {
  for (const mutation of [p => {p.props.online = false;}, p => {p.state.mode = 'MANUAL';}, p => {p.props.holidayMode = 'unknown';}]) {
    await t.test('not writable', async () => {
      const {adapter: a, transport} = adapter();
      mutation(transport.data[0]);
      await assert.rejects(a.prepare('heating-005cca', week(20)));
      assert.equal(transport.writes.length, 0);
    });
  }
});

test('native thermostat Holiday also blocks linked-system TRV uploads without clearing it', async () => {
  const {adapter: a, transport: t} = adapter();
  t.data.push(product('radiator-123456', 'trvcontrol'));
  t.data[0].props.holidayMode.enabled = true;
  await assert.rejects(a.prepare('radiator-123456', week(20)), /NATIVE_HIVE_HOLIDAY/);
  assert.equal(t.writes.length, 0);
});

test('a timeout stays unknown even when its diagnostic read matches the desired week', async () => {
  const {adapter: a, transport: t} = adapter();
  t.writeHook = async (zone, command) => {
    t.data[0].state.schedule = structuredClone(command.schedule);
    throw new Error('socket timed out');
  };
  const preview = await a.prepare('heating-005cca', week(20));
  const result = await a.apply(preview.token);
  assert.equal(result.status, 'unknown');
  assert.equal(result.readback.fingerprint, programmeFingerprint(week(20)));
  assert.equal(result.acknowledged, false);
  assert.equal(t.writes.length, 1);
  await assert.rejects(a.apply(preview.token), /UNKNOWN_OR_CONSUMED_PREVIEW/);
});

test('a transport-proven unsent request is reported separately from an ambiguous write', async () => {
  const {adapter: a, transport: t} = adapter();
  t.writeHook = async () => {throw new HiveTransportError('LOCAL_GUARD_REJECTED', 'not-sent');};
  const result = await a.apply((await a.prepare('heating-005cca', week(20))).token);
  assert.equal(result.status, 'not-applied');
  assert.equal(result.writeAttempted, false);
});

test('HTTP200 HTML, application errors and a different echoed week cannot confirm a write', async t => {
  for (const body of ['<html>Sign in</html>', {error: 'rejected'}, {schedule: serializeHiveProgramme(week(22))}]) {
    await t.test('bad acknowledgement', async () => {
      const {adapter: a, transport} = adapter();
      transport.writeHook = async (zone, command) => {
        transport.data[0].state.schedule = structuredClone(command.schedule);
        return {status: 200, body};
      };
      const result = await a.apply((await a.prepare('heating-005cca', week(20))).token);
      assert.equal(result.status, 'unknown');
      assert.equal(transport.writes.length, 1);
    });
  }
});

test('offline or externally changed controls after acknowledgement prevent confirmation', async t => {
  for (const mutation of [p => {p.props.online = false;}, p => {p.state.mode = 'MANUAL';}, p => {p.state.autoBoostTarget = 26;}]) {
    await t.test('readback not confirmed', async () => {
      const {adapter: a, transport} = adapter();
      transport.writeHook = async (zone, command) => {
        transport.data[0].state.schedule = structuredClone(command.schedule);
        mutation(transport.data[0]);
        return {status: 200, body: {schedule: padded(command.schedule)}};
      };
      const result = await a.apply((await a.prepare('heating-005cca', week(20))).token);
      assert.equal(result.status, 'unconfirmed');
      assert.equal(transport.writes.length, 1);
      assert.equal(transport.reads, 5);
    });
  }
});

test('lagging native state triggers read-only verification retries, never another upload', async () => {
  const {adapter: a, transport: t} = adapter();
  const old = structuredClone(t.data);
  const preview = await a.prepare('heating-005cca', week(20));
  t.writeHook = async (zone, command) => {
    t.data[0].state.schedule = structuredClone(command.schedule);
    let pending = true;
    t.readHook = async () => {
      if (pending) {pending = false; return structuredClone(old);}
      return structuredClone(t.data);
    };
    return {status: 200, body: {schedule: padded(command.schedule)}};
  };
  const result = await a.apply(preview.token);
  assert.equal(result.status, 'confirmed');
  assert.equal(t.writes.length, 1);
  assert.equal(t.reads, 4);
});

test('two queued previews for one zone cannot overwrite each other from the same old baseline', async () => {
  const {adapter: a, transport: t} = adapter();
  const first = await a.prepare('heating-005cca', week(20));
  const second = await a.prepare('heating-005cca', week(21));
  const results = await Promise.all([a.apply(first.token), a.apply(second.token)]);
  assert.deepEqual(results.map(r => r.status), ['confirmed', 'conflict']);
  assert.equal(t.writes.length, 1);
});

test('a preview is immutable and expires without sending commands', async () => {
  let now = 1000;
  const {adapter: a, transport: t} = adapter(undefined, {now: () => now, previewTtlMs: 100});
  const input = week(20);
  const preview = await a.prepare('heating-005cca', input);
  input.monday[0].targetC = 22;
  assert.equal(preview.programme.monday[0].targetC, 20);
  assert.throws(() => {preview.programme.monday[0].targetC = 25;}, TypeError);
  now = 1100;
  const result = await a.apply(preview.token);
  assert.equal(result.status, 'not-applied');
  assert.equal(result.reason, 'PREVIEW_EXPIRED');
  assert.equal(t.writes.length, 0);
});

test('a preview expiring during the fresh read cannot upload or confirm an unchanged programme', async t => {
  for (const desired of [week(20), week()]) {
    await t.test(desired.monday[0].targetC === 20 ? 'changed programme' : 'already matching programme', async () => {
      let now = 1000;
      const {adapter: a, transport} = adapter(undefined, {now: () => now, previewTtlMs: 100});
      const preview = await a.prepare('heating-005cca', desired);
      transport.readHook = async () => {
        now = 1100;
        return structuredClone(transport.data);
      };
      const result = await a.apply(preview.token);
      assert.equal(result.status, 'not-applied');
      assert.equal(result.reason, 'PREVIEW_EXPIRED');
      assert.equal(result.writeAttempted, false);
      assert.equal(transport.writes.length, 0);
      assert.equal(transport.reads, 2);
    });
  }
});

test('configured target bounds and steps are enforced before any network read', async () => {
  const {adapter: a, transport: t} = adapter();
  await assert.rejects(a.prepare('heating-005cca', week(33)), /LIMITS/);
  await assert.rejects(a.prepare('heating-005cca', week(18.25)), /STEP/);
  assert.equal(t.reads, 0);
  assert.equal(t.writes.length, 0);
});

test('a failed fresh baseline read cannot turn an old preview into an upload', async () => {
  const {adapter: a, transport: t} = adapter();
  const preview = await a.prepare('heating-005cca', week(20));
  t.readHook = async () => {throw new Error('offline');};
  const result = await a.apply(preview.token);
  assert.equal(result.status, 'not-applied');
  assert.equal(result.reason, 'FRESH_BASELINE_READ_FAILED');
  assert.equal(t.writes.length, 0);
});
