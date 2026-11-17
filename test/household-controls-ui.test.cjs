const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { householdProgrammeIntent, householdProgrammeContext } = require('../homebridge-ui/public/schedule.js');

test('the editor announces immediate Home/Away selection and ignores obsolete departure countdown data', () => {
  const home = { presence: { home: true, effectiveHome: true }, holiday: { active: false } };
  const away = { presence: { home: false, effectiveHome: false, pendingAwayAt: Date.now() + 300000 }, holiday: { active: false } };
  assert.equal(householdProgrammeIntent(home), 'home');
  assert.equal(householdProgrammeContext(home), 'Someone is home. Home programme requested.');
  assert.equal(householdProgrammeIntent(away), 'away');
  assert.equal(householdProgrammeContext(away), 'Everyone is away. Away programme requested.');
  assert.equal(householdProgrammeIntent({ presence: { home: null, effectiveHome: null } }), null);
  assert.equal(householdProgrammeContext({ presence: { home: null, effectiveHome: null } }), 'Presence has not been set.');
});

test('Holiday, preheat and guest-hold feedback preserve their priority over remembered occupancy', () => {
  const view = { presence: { home: false, effectiveHome: false }, holiday: { active: true, preheating: false } };
  assert.equal(householdProgrammeIntent(view), 'holiday');
  assert.match(householdProgrammeContext(view), /presence is remembered/);
  view.holiday.preheating = true;
  assert.equal(householdProgrammeIntent(view), 'home');
  assert.match(householdProgrammeContext(view), /Holiday preheat/);
  view.holiday = { active: false, preheating: false };
  view.presence = { home: false, effectiveHome: true, holdUntil: 1234 };
  assert.equal(householdProgrammeIntent(view), 'home');
  assert.equal(householdProgrammeContext(view, () => 'tomorrow'), 'Guest hold: Home programme requested until tomorrow.');
});

test('the editor script URL follows its content hash so the changed controls cannot use a stale cached script', () => {
  const publicDirectory = path.join(__dirname, '../homebridge-ui/public');
  const source = fs.readFileSync(path.join(publicDirectory, 'schedule.js'));
  const html = fs.readFileSync(path.join(publicDirectory, 'index.html'), 'utf8');
  const scripts = [...html.matchAll(/<script src="schedule\.js\?v=([a-f0-9]{12})"><\/script>/g)];
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0][1], crypto.createHash('sha256').update(source).digest('hex').slice(0, 12));
});
