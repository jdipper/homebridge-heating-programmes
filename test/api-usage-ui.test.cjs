'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {readApiUsage} = require('../homebridge-ui/api-usage');

const id = '0123456789abcdef';
const snapshot = () => ({version: 1, scope: 'this-plugin-instance', measure: 'http-attempts-not-billing', instanceId: id,
  month: '2026-11', observedSince: '2026-11-10T17:00:00.000Z', updatedAt: '2026-11-10T17:01:00.000Z', attempts: 3,
  byCategory: {authentication: 1, messaging: 1, temperature: 0, programme: 1, read: 0, control: 0, other: 0}});
const now = Date.parse('2026-11-10T17:02:00.000Z');
async function fixture(t, value = snapshot(), mode = 0o600) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'heating-usage-'));
  t.after(() => fs.rm(root, {recursive: true, force: true}));
  await fs.mkdir(path.join(root, 'persist'), {mode: 0o700});
  const file = path.join(root, 'persist', `TuyaApiUsage.${id}.json`);
  await fs.writeFile(file, JSON.stringify(value), {mode});
  return {root, file};
}

test('usage view forwards only observed counters, without identities or arbitrary private fields', async t => {
  const value = {...snapshot(), accessToken: 'must-not-leak', arbitrary: {private: true}};
  const {root} = await fixture(t, value);
  const {records} = await readApiUsage(root, now);
  assert.equal(records.length, 1);
  assert.equal(records[0].attempts, 3);
  assert.equal(records[0].observedSince, value.observedSince);
  assert.equal(JSON.stringify(records).includes(id), false);
  assert.equal(JSON.stringify(records).includes('must-not-leak'), false);
  assert.deepEqual(Object.keys(records[0]).sort(), ['attempts', 'byCategory', 'month', 'observedSince', 'updatedAt']);
});

for (const [name, change] of [
  ['inconsistent total', value => {value.attempts = 4;}],
  ['negative category', value => {value.byCategory.read = -1; value.attempts = 2;}],
  ['future timestamp', value => {value.updatedAt = '2026-11-11T17:00:00.000Z';}],
  ['wrong instance', value => {value.instanceId = 'fedcba9876543210';}],
  ['wrong scope', value => {value.scope = 'billing';}],
  ['wrong month', value => {value.month = '2026-10';}],
]) test(`usage view rejects ${name}`, async t => {
  const value = snapshot(); change(value);
  const {root} = await fixture(t, value);
  assert.deepEqual(await readApiUsage(root, now), {records: []});
});

test('usage view rejects public files, symlinks and oversized files', async t => {
  const {root, file} = await fixture(t, snapshot(), 0o644);
  assert.deepEqual(await readApiUsage(root, now), {records: []});
  await fs.unlink(file);
  const outside = path.join(root, 'outside.json');
  await fs.writeFile(outside, JSON.stringify(snapshot()), {mode: 0o600});
  await fs.symlink(outside, file);
  assert.deepEqual(await readApiUsage(root, now), {records: []});
  await fs.unlink(file);
  await fs.writeFile(file, ' '.repeat(8193), {mode: 0o600});
  assert.deepEqual(await readApiUsage(root, now), {records: []});
});

test('missing counters leave heating UI usable', async t => {
  const {root, file} = await fixture(t);
  await fs.unlink(file);
  assert.deepEqual(await readApiUsage(root, now), {records: []});
});
