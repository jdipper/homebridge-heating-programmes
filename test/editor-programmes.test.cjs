const test = require('node:test');
const assert = require('node:assert/strict');
const {
  copyCompleteNativeProgramme, normaliseProgrammeDraft, sharedProgrammeCompatibility,
  validateProgrammeForRoom, programmeDifferences, savedProgrammeVerification,
  buildProgrammeFeedback, heatingSystemErrors,
} = require('../homebridge-ui/public/schedule.js');

const hive = { id: 'hive:zone', name: 'Radiators', provider: 'hive', programmeLimits: { minPeriods: 1, maxPeriods: 6, minC: 5, maxC: 32, stepC: 0.5 } };
const tuya = { id: 'tuya:zone', name: 'Floor', provider: 'tuya', programmeLimits: { minPeriods: 4, maxPeriods: 4, minC: 5, maxC: 40, stepC: 0.5 } };
function nativeWeek(count = 4) {
  return { complete: true, days: [1, 2, 4, 8, 16, 32, 64].map((day, dayIndex) => ({
    day, complete: true, events: Array.from({ length: typeof count === 'function' ? count(dayIndex) : count }, (_, event) => ({
      event, hour: 5 + event * 3, minute: 15, temperature: event % 2 ? 7 : 18.5,
    })),
  })) };
}

test('Hive import preserves variable daily period counts and the actual first period', () => {
  const source = nativeWeek(index => index % 2 ? 1 : 6);
  const imported = copyCompleteNativeProgramme(source, hive);
  assert.deepEqual(imported.days.map(day => day.events.length), [6, 1, 6, 1, 6, 1, 6]);
  assert.equal(imported.days[0].events[0].hour, 5);
  assert.equal(imported.days[0].events[0].minute, 15);
  imported.days[0].events[0].temperature = 20;
  assert.equal(source.days[0].events[0].temperature, 18.5);
});

test('draft normalization does not pad Hive weeks or invent missing times', () => {
  const source = nativeWeek(1);
  const normalized = normaliseProgrammeDraft(source, hive);
  assert.equal(normalized.days[0].events.length, 1);
  assert.equal(normalized.days[0].events[0].hour, 5);
  const empty = normaliseProgrammeDraft(null, hive);
  assert.ok(empty.days.every(day => day.events.every(event => event.hour === null && event.minute === null && event.temperature === null)));
});

test('FastWarm still requires exactly four periods while Hive accepts one through six', () => {
  assert.throws(() => copyCompleteNativeProgramme(nativeWeek(6), tuya), /4 periods/);
  assert.throws(() => copyCompleteNativeProgramme(nativeWeek(1), tuya), /4 periods/);
  assert.equal(copyCompleteNativeProgramme(nativeWeek(4), tuya).days.length, 7);
  assert.equal(copyCompleteNativeProgramme(nativeWeek(1), hive).days.length, 7);
});

test('partial reads and malformed days cannot be imported as complete drafts', () => {
  for (const mutate of [
    week => { week.complete = false; },
    week => { week.days[3].complete = false; },
    week => { week.days[3].day = 1; },
    week => { week.days[3].events[1].event = 0; },
    week => { week.days[3].events[1].hour = 4; },
    week => { week.days[3].events[1].temperature = null; },
  ]) {
    const source = nativeWeek(); mutate(source);
    assert.throws(() => copyCompleteNativeProgramme(source, hive));
  }
});

test('bulk compatibility is checked for every selected room before draft copies change', () => {
  const sixPeriods = copyCompleteNativeProgramme(nativeWeek(6), hive);
  const before = JSON.stringify(sixPeriods);
  assert.deepEqual(sharedProgrammeCompatibility(sixPeriods, [hive, tuya]).map(item => item.id), [tuya.id]);
  assert.equal(JSON.stringify(sixPeriods), before);
  const fourPeriods = copyCompleteNativeProgramme(nativeWeek(), tuya);
  assert.deepEqual(sharedProgrammeCompatibility(fourPeriods, [hive, tuya]), []);
  fourPeriods.days[0].events[0].temperature = 35;
  assert.deepEqual(sharedProgrammeCompatibility(fourPeriods, [hive, tuya]).map(item => item.id), [hive.id]);
});

test('configured temperature bounds and increments are enforced for saved drafts', () => {
  const source = nativeWeek();
  source.days[0].events[0].temperature = 18.25;
  assert.throws(() => validateProgrammeForRoom(source, hive), /0.5/);
  source.days[0].events[0].temperature = 32.5;
  assert.throws(() => validateProgrammeForRoom(source, hive), /5–32/);
  assert.doesNotThrow(() => validateProgrammeForRoom(source, tuya));
});

test('preview differences include deleted periods instead of silently hiding removals', () => {
  const before = copyCompleteNativeProgramme(nativeWeek(6), hive);
  const after = copyCompleteNativeProgramme(nativeWeek(4), hive);
  const differences = programmeDifferences(before, after);
  assert.equal(differences.length, 14);
  assert.ok(differences.every(change => change.before && change.after === undefined));
});

test('read-only Hive can verify a saved one-period draft without requesting a write', () => {
  const room = { ...hive, online: true, writeEnabled: false, profiles: { holiday: copyCompleteNativeProgramme(nativeWeek(1), hive) }, sync: { status: 'idle' } };
  assert.deepEqual(savedProgrammeVerification(room, 'holiday').request, { deviceIds: [hive.id], verifyProfile: 'holiday' });
});

function confirmedRoom(room) {
  return { ...room, online: true, enabled: true, schedule: nativeWeek(), mode: room.provider === 'hive' ? 'SCHEDULE' : 'smart',
    sync: { status: 'verified', profileStatus: 'confirmed', confirmedProfile: 'home', requestedProfile: 'home', confirmedAt: 1000, confirmationMatchesRequested: true } };
}

test('each system keeps its own confirmation when another room fails', () => {
  const floor = confirmedRoom(tuya);
  const radiators = { ...confirmedRoom(hive), sync: { status: 'partial', requestedProfile: 'home', lastAttemptedProfile: 'home', error: 'Complete week not verified.' } };
  const result = buildProgrammeFeedback({ thermostats: [floor, radiators], presence: { home: true }, holiday: { active: false } });
  assert.equal(result.kind, 'attention');
  assert.equal(result.counts.confirmed, 1);
  assert.equal(result.counts.attention, 1);
  assert.match(result.detail, /Radiators/);
});

test('an unknown upload is shown as needing attention even without an error message', () => {
  const room = { ...confirmedRoom(hive), sync: { status: 'unknown', requestedProfile: 'home', lastAttemptedProfile: 'home' } };
  assert.equal(buildProgrammeFeedback({ thermostats: [room], presence: { home: true } }).kind, 'attention');
});

test('scheduled Hive and FastWarm can both be shown confirmed without mode-name assumptions', () => {
  const result = buildProgrammeFeedback({ thermostats: [confirmedRoom(tuya), confirmedRoom(hive)], presence: { home: true } });
  assert.equal(result.kind, 'confirmed');
  assert.equal(result.counts.confirmed, 2);
});

test('a missing provider remains visible even when its zones cannot be listed', () => {
  const view = { thermostats: [confirmedRoom(tuya)], presence: { home: true }, systemErrors: { hive: 'Hive connection unavailable' } };
  const result = buildProgrammeFeedback(view);
  assert.equal(result.kind, 'attention');
  assert.equal(result.counts.confirmed, 1);
  assert.match(result.detail, /Hive: Hive connection unavailable/);
  assert.deepEqual(heatingSystemErrors({ systemErrors: [{ provider: 'hive', error: 'Unavailable' }] }), [{ provider: 'hive', message: 'Unavailable' }]);
});

test('Holiday tab editing does not change the actual household intent displayed', () => {
  const view = { thermostats: [confirmedRoom(tuya)], presence: { home: true }, holiday: { active: false } };
  assert.equal(buildProgrammeFeedback(view).profile, 'home');
  view.holiday.active = true;
  assert.equal(buildProgrammeFeedback(view).profile, 'holiday');
});
