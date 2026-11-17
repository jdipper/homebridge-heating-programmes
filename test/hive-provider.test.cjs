'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {HiveProvider} = require('../dist/hive/HiveProvider.js');
const {HiveTransportError, parseHiveProgramme, serializeHiveProgramme} = require('../dist/hive/HiveProgrammeAdapter.js');
const {programmeFingerprint, WEEKDAYS} = require('../dist/programmes.js');
const week = target => Object.fromEntries(WEEKDAYS.map(day => [day, [
  {startMinute: 300, targetC: target}, {startMinute: 420, targetC: 7},
  {startMinute: 990, targetC: target}, {startMinute: 1290, targetC: 7},
]]));
const id = 'heating-005cca';
class GuardedTransport {
  constructor(fresh = true) {
    this.fresh = fresh; this.reads = 0; this.posts = 0; this.commands = [];
    this.data = [{id, type: 'heating', state: {name: 'Living room', mode: 'SCHEDULE', target: 7,
      schedule: serializeHiveProgramme(week(18.5)), autoBoost: true, autoBoostTarget: 25},
    props: {online: true, temperature: 18.25, holidayMode: {active: false, enabled: false}}}];
  }
  async getCapabilities() {return {read: true, write: true, enrolledZoneIds: [id], freshWritePreconditions: this.fresh};}
  async supportsFreshWritePreconditions() {return this.fresh;}
  async readProducts() {this.reads++; return structuredClone(this.data);}
  async writeSchedule(zone, command) {
    this.commands.push(structuredClone(command));
    if (command.requireFreshPreconditions && !this.fresh) throw new HiveTransportError('GUARD_UNAVAILABLE', 'not-sent');
    // Model the existing runtime's cloud guard, including its separate GET.
    const current = (await this.readProducts())[0], before = command.preconditions;
    if (current.state.mode !== before.mode || current.state.target !== before.target
      || programmeFingerprint(parseHiveProgramme(current.state.schedule)) !== programmeFingerprint(parseHiveProgramme(before.schedule))) {
      throw new HiveTransportError('LIVE_PRECONDITION_CHANGED', 'not-sent');
    }
    this.posts++; this.data[0].state.schedule = structuredClone(command.schedule);
    return {status: 200, body: {schedule: command.schedule}};
  }
}
const provider = transport => new HiveProvider(transport, {minC: 5, maxC: 32, stepC: 0.5});

test('guarded automatic Hive change uses three cloud reads and one schedule POST', async () => {
  const transport = new GuardedTransport(), p = provider(transport);
  const prepared = await p.prepare(id, week(12), undefined, {requireScheduled: true});
  assert.equal(transport.reads, 1, 'preparation owns the single fresh baseline');
  const result = await p.apply(prepared.token);
  assert.equal(result.status, 'confirmed');
  assert.equal(result.readback.scheduled, true);
  assert.equal(transport.reads, 3, 'prepare + runtime pre-write guard + full post-write readback');
  assert.equal(transport.posts, 1);
  assert.equal(transport.commands[0].requireFreshPreconditions, true);
});

test('an older Hive runtime retains the extra client baseline read safely', async () => {
  const transport = new GuardedTransport(false), p = provider(transport);
  const prepared = await p.prepare(id, week(12));
  assert.equal((await p.apply(prepared.token)).status, 'confirmed');
  assert.equal(transport.reads, 4);
  assert.equal(transport.posts, 1);
  assert.equal(transport.commands[0].requireFreshPreconditions, undefined);
});

test('a programme already on Hive uses two fresh reads and no schedule POST', async () => {
  const transport = new GuardedTransport(), p = provider(transport);
  const prepared = await p.prepare(id, week(18.5));
  assert.equal(prepared.changesRequired, false);
  assert.equal((await p.apply(prepared.token)).status, 'confirmed');
  assert.equal(transport.reads, 2);
  assert.equal(transport.posts, 0);
});

test('the runtime guard blocks a manual mode change between preparation and dispatch', async () => {
  const transport = new GuardedTransport(), p = provider(transport);
  const prepared = await p.prepare(id, week(12));
  transport.data[0].state.mode = 'MANUAL';
  const result = await p.apply(prepared.token);
  assert.equal(result.status, 'not-applied');
  assert.equal(result.writeAttempted, false);
  assert.equal(transport.posts, 0);
  assert.equal(transport.commands.length, 1, 'one guarded attempt, never a retry');
});

test('a guarded write whose reply is lost stays unknown even when its full readback matches', async () => {
  const transport = new GuardedTransport(), p = provider(transport);
  const write = transport.writeSchedule.bind(transport);
  transport.writeSchedule = async (...args) => {await write(...args); throw new HiveTransportError('REPLY_LOST', 'unknown');};
  const prepared = await p.prepare(id, week(12));
  const result = await p.apply(prepared.token);
  assert.equal(result.status, 'unknown');
  assert.equal(result.writeAttempted, true);
  assert.equal(result.readback.fingerprint, programmeFingerprint(week(12)));
  assert.equal(transport.posts, 1);
  assert.equal(transport.commands.length, 1);
  assert.equal(transport.reads, 3);
});

test('no-op confirmation still refuses a later manual mode instead of trusting the preview', async () => {
  const transport = new GuardedTransport(), p = provider(transport);
  const prepared = await p.prepare(id, week(18.5));
  transport.data[0].state.mode = 'MANUAL';
  const result = await p.apply(prepared.token);
  assert.equal(result.status, 'not-applied');
  assert.equal(transport.posts, 0);
  assert.equal(transport.commands.length, 0);
});

test('Hive preparation checks the expected native fingerprint with only its fresh baseline', async () => {
  const transport = new GuardedTransport(), p = provider(transport);
  await assert.rejects(p.prepare(id, week(12), 'f'.repeat(64)), /programme changed/);
  assert.equal(transport.reads, 1);
  assert.equal(transport.posts, 0);
});

test('automatic Hive preparation refuses Hold/boost mode before any write preview', async () => {
  const transport = new GuardedTransport(), p = provider(transport);
  transport.data[0].state.mode = 'BOOST';
  await assert.rejects(p.prepare(id, week(12), undefined, {requireScheduled: true}), /NOT_IN_SCHEDULE_MODE/);
  assert.equal(transport.reads, 1);
  assert.equal(transport.posts, 0);
});

test('superseding a prepared Hive selection consumes its token without another cloud read or write', async () => {
  const transport = new GuardedTransport(), p = provider(transport), abort = new AbortController();
  const prepared = await p.prepare(id, week(12), undefined, {requireScheduled: true});
  abort.abort();
  const result = await p.apply(prepared.token, {signal: abort.signal});
  assert.equal(result.status, 'not-applied');
  assert.equal(result.reason, 'PROGRAMME_SUPERSEDED');
  assert.equal(result.writeAttempted, false);
  assert.equal(transport.reads, 1);
  assert.equal(transport.posts, 0);
  await assert.rejects(p.apply(prepared.token), /UNKNOWN_OR_CONSUMED_PREVIEW/);
});

test('discarding an obsolete Hive preparation is local and prevents a later upload', async () => {
  const transport = new GuardedTransport(), p = provider(transport);
  const prepared = await p.prepare(id, week(12));
  await p.discard(prepared.token);
  await assert.rejects(p.apply(prepared.token), /UNKNOWN_OR_CONSUMED_PREVIEW/);
  assert.equal(transport.reads, 1);
  assert.equal(transport.posts, 0);
});

test('a Hive selection superseded during a private capability check never submits its week', async () => {
  const transport = new GuardedTransport(), p = provider(transport), abort = new AbortController();
  const prepared = await p.prepare(id, week(12));
  transport.supportsFreshWritePreconditions = async () => {abort.abort(); return true;};
  const result = await p.apply(prepared.token, {signal: abort.signal});
  assert.equal(result.status, 'not-applied');
  assert.equal(result.reason, 'PROGRAMME_SUPERSEDED');
  assert.equal(transport.reads, 1);
  assert.equal(transport.commands.length, 0);
});

test('a Hive selection superseded during the legacy fresh baseline read never submits its week', async () => {
  const transport = new GuardedTransport(false), p = provider(transport), abort = new AbortController();
  const prepared = await p.prepare(id, week(12));
  const read = transport.readProducts.bind(transport);
  transport.readProducts = async () => {const value = await read(); abort.abort(); return value;};
  const result = await p.apply(prepared.token, {signal: abort.signal});
  assert.equal(result.status, 'not-applied');
  assert.equal(result.reason, 'PROGRAMME_SUPERSEDED');
  assert.equal(transport.reads, 2);
  assert.equal(transport.commands.length, 0);
});

test('superseding an already submitted Hive week lets that single command finish without replay', async () => {
  const transport = new GuardedTransport(), p = provider(transport), abort = new AbortController();
  const write = transport.writeSchedule.bind(transport);
  transport.writeSchedule = async (...args) => {abort.abort(); return write(...args);};
  const prepared = await p.prepare(id, week(12));
  const result = await p.apply(prepared.token, {signal: abort.signal});
  assert.equal(result.status, 'confirmed');
  assert.equal(transport.posts, 1);
  assert.equal(transport.commands.length, 1);
  assert.equal(transport.reads, 3);
});
