const test = require('node:test');
const assert = require('node:assert/strict');
const {createThermostatControlPolicy, evaluateThermostatControlPolicy, restoreThermostatControlPolicy,
  policyDeadlines, policyIntent} = require('../dist/controller/ControlPolicy.js');
const now = Date.UTC(2026, 10, 17, 12);

test('departure policy selects Away immediately and has no internal departure timer', () => {
  const policy = createThermostatControlPolicy(false);
  assert.deepEqual(policyIntent(evaluateThermostatControlPolicy(policy, now)), {anyoneHome: false, holiday: false});
  assert.deepEqual(policyDeadlines(policy), []);
  assert.equal(Object.hasOwn(policy, 'awayDelayMinutes'), false);
  assert.equal(Object.hasOwn(policy, 'pendingAwayAt'), false);
});

test('legacy future and overdue departure fields are discarded while preserving stored effective state', () => {
  for (const pendingAwayAt of [now - 1, now + 3600000]) {
    const old = {...createThermostatControlPolicy(false), effectiveHome: true, awayDelayMinutes: 30, pendingAwayAt};
    const restored = restoreThermostatControlPolicy(old, null, false, now);
    assert.equal(restored.actualHome, false); assert.equal(restored.effectiveHome, true);
    assert.equal(restored.recoveryRequired, null);
    assert.equal(Object.hasOwn(restored, 'awayDelayMinutes'), false);
    assert.equal(Object.hasOwn(restored, 'pendingAwayAt'), false);
    assert.deepEqual(policyDeadlines(restored), []);
    assert.equal(old.pendingAwayAt, pendingAwayAt, 'migration input is not mutated');
  }
});

test('explicit guest holds and Holiday deadlines remain bridge-owned and overdue ones require review', () => {
  for (const old of [
    {...createThermostatControlPolicy(false), holdUntil: now - 1},
    {...createThermostatControlPolicy(false, true), returnAt: now - 1},
  ]) {
    const restored = restoreThermostatControlPolicy(old, null, false, now);
    assert.match(restored.recoveryRequired, /deadline passed/);
    assert.deepEqual(evaluateThermostatControlPolicy(restored, now + 1), restored);
  }
});

test('Holiday preheat and return retain the latest remembered occupancy', () => {
  const policy = {...createThermostatControlPolicy(false, true), returnAt: now + 3600000, preheatMinutes: 10};
  const before = evaluateThermostatControlPolicy(policy, now);
  assert.deepEqual(policyIntent(before), {anyoneHome: false, holiday: true});
  const warming = evaluateThermostatControlPolicy(before, now + 55 * 60000);
  assert.equal(warming.holidayActive, true); assert.equal(warming.actualHome, false);
  assert.deepEqual(policyIntent(warming), {anyoneHome: true, holiday: false});
  const returned = evaluateThermostatControlPolicy(warming, now + 3600000);
  assert.equal(returned.returnAt, null); assert.equal(returned.holidayActive, false);
  assert.deepEqual(policyIntent(returned), {anyoneHome: false, holiday: false});
});

test('unknown occupancy at Holiday return is not interpreted as Away', () => {
  const policy = {...createThermostatControlPolicy(null, true), returnAt: now};
  const evaluated = evaluateThermostatControlPolicy(policy, now);
  assert.equal(evaluated.holidayActive, true); assert.equal(evaluated.actualHome, null);
  assert.match(evaluated.recoveryRequired, /presence is unknown/);
});
