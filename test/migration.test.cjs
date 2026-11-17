const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const {readLegacyMigration, convertLegacyTuyaProgramme} = require('../dist/controller/LegacyMigration.js');

const now = Date.UTC(2026, 10, 8, 16);
const instance = '0123456789abcdef';
const filename = id => `TuyaThermostatProfiles.${id}.json`;
const programme = () => ({days: [64, 32, 16, 8, 4, 2, 1].map(day => ({day,
  events: [3, 1, 0, 2].map(event => ({event, hour: [5, 7, 16, 21][event], minute: 30,
    temperature: [18.5, 7, 18.5, 7][event]}))}))});
const controls = () => ({version: 1, actualHome: true, effectiveHome: true, awayDelayMinutes: 17,
  pendingAwayAt: null, holdUntil: null, holidayActive: false, returnAt: null, preheatMinutes: 0,
  preheating: false, recoveryRequired: null});
const document = (id = 'roomA') => ({version: 2, controls: controls(),
  profiles: {version: 1, anyoneHome: true, holiday: false, enabledDeviceIds: [id], devices: {
    [id]: {programmes: {home: programme(), away: programme(), holiday: programme()},
      requestedProfile: 'home', confirmedProfile: 'home', confirmedProgramme: programme(),
      confirmedAt: now - 1000, status: 'confirmed', inFlight: null},
  }}, rooms: {[id]: {name: 'Sitting room', timeZone: 'Europe/London', clockVerified: true}},
  overrides: {}, snapshots: [{fingerprint: 'must-not-become-confirmation'}], history: {version: 1, devices: {
    [id]: {temperatures: [{at: now - 3000, sourceAt: now - 4000, online: true,
      currentTemperature: 18.15, targetTemperature: 18.5}],
      programmes: [{id: '5f6f5375-0027-4678-b89e-353b62708f65', at: now - 5000,
        source: 'draft', profile: 'home', programme: programme()}]},
  }}});

async function withDirectory(fn) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'heating-migration-'));
  await fs.chmod(directory, 0o700);
  try { return await fn(directory); } finally { await fs.rm(directory, {recursive: true, force: true}); }
}
async function write(directory, value, id = instance, mode = 0o600) {
  const file = path.join(directory, filename(id));
  await fs.writeFile(file, JSON.stringify(value), {mode});
  return file;
}

test('migrates every period, names, rules, enrolment and measured history without device confirmation', () => withDirectory(async directory => {
  const source = document();
  const file = await write(directory, source);
  const bytes = await fs.readFile(file);
  const result = await readLegacyMigration(directory, now);
  const room = result.rooms['tuya:roomA'];
  assert.equal(room.name, 'Sitting room');
  assert.equal(room.enabled, true);
  assert.equal(room.timeZone, 'Europe/London');
  assert.equal(room.clockVerified, true);
  assert.equal(room.profiles.home.monday.length, 4);
  assert.equal(room.profiles.home.monday[0].startMinute, 330);
  assert.deepEqual(room.profiles.home.monday, room.profiles.home.sunday);
  assert.equal(Object.hasOwn(result.controls, 'awayDelayMinutes'), false);
  assert.equal(result.controls.actualHome, true);
  assert.equal(room.history.temperatures[0].at, now - 3000);
  assert.equal(room.history.temperatures[0].sourceAt, now - 4000);
  assert.equal(room.history.programmes[0].programme.monday[0].startMinute, 330);
  assert.equal(room.confirmedProfile, undefined);
  assert.equal(result.snapshots, undefined);
  assert.equal(result.recoveryRequired, null);
  assert.equal(result.sourceFiles[0].sha256, crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(await fs.readFile(file), bytes, 'old file was not changed');
  assert.deepEqual(await readLegacyMigration(directory, now), result, 'read is idempotent');
}));

test('missing legacy settings returns no migration and unrelated filenames are ignored', () => withDirectory(async directory => {
  await fs.writeFile(path.join(directory, 'TuyaThermostatProfiles.not-an-instance.json'), '{}');
  assert.equal(await readLegacyMigration(directory, now), null);
}));

test('old version without controls preserves unknown presence without inventing timers', () => withDirectory(async directory => {
  const source = document();
  source.version = 1;
  delete source.controls;
  source.profiles.anyoneHome = null;
  source.profiles.enabledDeviceIds = [];
  await write(directory, source);
  const result = await readLegacyMigration(directory, now);
  assert.equal(result.controls.actualHome, null);
  assert.equal(Object.hasOwn(result.controls, 'pendingAwayAt'), false);
  assert.equal(result.controls.returnAt, null);
}));

test('overdue timers require review instead of replaying Home/Away or Holiday', () => withDirectory(async directory => {
  const source = document();
  source.controls.actualHome = false;
  source.controls.pendingAwayAt = now - 1;
  source.controls.holidayActive = true;
  source.controls.returnAt = now - 1;
  await write(directory, source);
  const result = await readLegacyMigration(directory, now);
  assert.match(result.recoveryRequired, /deadline passed/);
  assert.equal(result.controls.holidayActive, true);
  assert.equal(result.controls.effectiveHome, true);
  assert.equal(Object.hasOwn(result.controls, 'pendingAwayAt'), false);
}));

test('interrupted uploads and active overrides block shared automation without resuming them', () => withDirectory(async directory => {
  const source = document();
  source.profiles.devices.roomA.inFlight = {operationId: 'old', profileId: 'home', programme: programme()};
  source.overrides.roomA = {status: 'active', temperature: 20.5, endsAt: now + 1000};
  await write(directory, source);
  const result = await readLegacyMigration(directory, now);
  assert.deepEqual(result.interruptedDeviceIds, ['tuya:roomA']);
  assert.match(result.controls.recoveryRequired, /no interrupted operation was resumed/);
  assert.equal(result.rooms['tuya:roomA'].inFlight, undefined);
}));

test('independent instances merge only when household policy is identical', () => withDirectory(async directory => {
  await write(directory, document());
  const other = document('roomB');
  other.controls = Object.fromEntries(Object.entries(other.controls).reverse());
  await write(directory, other, 'fedcba9876543210');
  const result = await readLegacyMigration(directory, now);
  assert.deepEqual(Object.keys(result.rooms).sort(), ['tuya:roomA', 'tuya:roomB']);
  assert.equal(result.sourceFiles.length, 2);
  other.controls.actualHome = false;
  await write(directory, other, 'fedcba9876543210');
  await assert.rejects(readLegacyMigration(directory, now), /different household rules/);
}));

test('same thermostat in two legacy instances is rejected instead of silently overwritten', () => withDirectory(async directory => {
  await write(directory, document());
  await write(directory, document(), 'fedcba9876543210');
  await assert.rejects(readLegacyMigration(directory, now), /more than one legacy instance/);
}));

test('private source, directory and symlink guards prevent unsafe imports', () => withDirectory(async directory => {
  const file = await write(directory, document());
  await fs.chmod(file, 0o644);
  await assert.rejects(readLegacyMigration(directory, now), /owner-only/);
  await fs.chmod(file, 0o600);
  await fs.chmod(directory, 0o777);
  await assert.rejects(readLegacyMigration(directory, now), /not writable by other users/);
  await fs.chmod(directory, 0o700);
  await fs.rename(file, `${file}.original`);
  await fs.symlink(`${file}.original`, file);
  await assert.rejects(readLegacyMigration(directory, now));
}));

test('oversized settings and malformed JSON are rejected before a migration result', () => withDirectory(async directory => {
  const file = await write(directory, document());
  await fs.writeFile(file, Buffer.alloc(4 * 1024 * 1024 + 1));
  await assert.rejects(readLegacyMigration(directory, now), /bounded regular file/);
  await fs.writeFile(file, '{');
  await assert.rejects(readLegacyMigration(directory, now), SyntaxError);
}));

test('incomplete and duplicate programme slots are not invented during conversion', () => {
  const missing = programme(); missing.days.pop();
  assert.throws(() => convertLegacyTuyaProgramme(missing), /complete week/);
  const duplicate = programme(); duplicate.days[0].events[0].event = 0;
  assert.throws(() => convertLegacyTuyaProgramme(duplicate), /duplicate events/);
  const unordered = programme(); unordered.days[0].events.find(event => event.event === 1).hour = 4;
  assert.throws(() => convertLegacyTuyaProgramme(unordered), /STRICTLY_INCREASING/);
  const badTemp = programme(); badTemp.days[0].events[0].temperature = 20.1;
  assert.throws(() => convertLegacyTuyaProgramme(badTemp), /CONFIGURED_STEP/);
});

test('incomplete enrolled profiles and invalid identifiers require review', () => withDirectory(async directory => {
  const source = document(); delete source.profiles.devices.roomA.programmes.holiday;
  await write(directory, source);
  await assert.rejects(readLegacyMigration(directory, now), /lacks a complete/);
  const invalid = document('room:duplicate-namespace');
  await write(directory, invalid);
  await assert.rejects(readLegacyMigration(directory, now), /invalid device identity/);
}));

test('history retains actual timestamps, omits invalid restore candidates and keeps source audit data', () => withDirectory(async directory => {
  const source = document();
  source.history.devices.roomA.temperatures.push({at: now, online: false, currentTemperature: 99});
  source.history.devices.roomA.programmes.push({...source.history.devices.roomA.programmes[0], id: crypto.randomUUID(), programme: {days: []}});
  await write(directory, source);
  const result = await readLegacyMigration(directory, now);
  assert.equal(result.rooms['tuya:roomA'].history.temperatures.length, 1);
  assert.equal(result.rooms['tuya:roomA'].history.programmes.length, 1);
  assert.deepEqual(result.legacyHistory[instance], source.history);
}));
