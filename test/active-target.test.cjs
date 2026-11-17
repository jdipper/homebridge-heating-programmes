const test = require('node:test');
const assert = require('node:assert/strict');
const {matchesFreshProgrammeTarget} = require('../dist/controller/Provider.js');
const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const week = () => Object.fromEntries(days.map((day, i) => [day, [
  {startMinute: 330, targetC: 20}, {startMinute: 510, targetC: 12},
  {startMinute: 1020, targetC: 21}, {startMinute: 1320, targetC: i === 6 ? 9 : 10},
]]));
const at = value => Date.parse(value);

test('fresh target verification handles yesterday Sleep across the Sunday/Monday boundary', () => {
  const now = at('2026-11-16T03:00:00Z');
  assert.equal(matchesFreshProgrammeTarget({targetC: 9, targetReadAt: now}, week(), 'Europe/London', now - 1, now), true);
  assert.equal(matchesFreshProgrammeTarget({targetC: 10, targetReadAt: now}, week(), 'Europe/London', now - 1, now), false);
});

test('a cached, missing, future or incorrect target cannot confirm the active period', () => {
  const now = at('2026-11-17T12:00:00Z');
  for (const zone of [{targetC: 12}, {targetC: 12, targetReadAt: now - 2}, {targetC: 12, targetReadAt: now + 1},
    {targetC: null, targetReadAt: now}, {targetC: 20, targetReadAt: now}]) {
    assert.equal(matchesFreshProgrammeTarget(zone, week(), 'Europe/London', now - 1, now), false);
  }
  assert.equal(matchesFreshProgrammeTarget({targetC: 12, targetReadAt: now}, week(), 'Europe/London', now - 1, now), true);
});

test('a target proof from the preceding period cannot confirm after the next period begins', () => {
  const read = at('2026-11-17T16:59:59Z'), now = at('2026-11-17T17:00:01Z');
  assert.equal(matchesFreshProgrammeTarget({targetC: 12, targetReadAt: read}, week(), 'Europe/London', read - 1, now), false);
});

test('time-zone calculation uses the configured IANA zone rather than a UTC offset', () => {
  const now = at('2026-07-14T16:30:00Z'), zone = {targetC: 21, targetReadAt: now};
  assert.equal(matchesFreshProgrammeTarget(zone, week(), 'Europe/London', now - 1, now), true);
  assert.equal(matchesFreshProgrammeTarget(zone, week(), 'UTC', now - 1, now), false);
  assert.equal(matchesFreshProgrammeTarget(zone, week(), 'not/a-zone', now - 1, now), false);
});

test('a duplicated daylight-saving transition period cannot provide an unambiguous target proof', () => {
  const programme = week(); programme.sunday[0] = {startMinute: 90, targetC: 20};
  const now = at('2026-10-25T01:40:00Z');
  assert.equal(matchesFreshProgrammeTarget({targetC: 20, targetReadAt: now}, programme, 'Europe/London', now - 1, now), false);
});
