function validateProgramme(view, freshSince = 0) {
  const matches = view?.thermostats?.filter(item => item.id === TARGET);
  if (!matches || matches.length !== 1) throw new Error('Pilot runtime view is missing or duplicated.');
  const room = matches[0]; const schedule = room.schedule;
  if (room.online !== true || room.timeZone !== 'Europe/London' || room.sync?.status !== 'verified'
      || !Number.isFinite(room.lastUpdated) || room.lastUpdated < freshSince || room.lastUpdated > Date.now() + 2000
      || schedule?.complete !== true || !Array.isArray(schedule.days) || schedule.days.length !== 7) throw new Error('Complete fresh native programme is not verified.');
  const days = [1, 2, 4, 8, 16, 32, 64];
  for (let index = 0; index < days.length; index++) {
    const day = schedule.days[index];
    if (day.day !== days[index] || day.complete !== true || !Array.isArray(day.events) || day.events.length !== 4) throw new Error('Native programme must contain all ordered 28 events.');
    let previous = -1;
    day.events.forEach((event, eventIndex) => {
      const minute = event.hour * 60 + event.minute;
      if (event.event !== eventIndex || !Number.isInteger(event.hour) || event.hour < 0 || event.hour > 23
          || !Number.isInteger(event.minute) || event.minute < 0 || event.minute > 59 || minute <= previous
          || !Number.isInteger(event.temperature * 2) || event.temperature < 5 || event.temperature > 40) throw new Error('Invalid native programme event.');
      previous = minute;
    });
  }
  const actual = createHash('sha256').update(JSON.stringify(schedule.days.map(day => [day.day, day.events]))).digest('hex');
  if (actual !== room.scheduleFingerprint) throw new Error('Runtime programme fingerprint does not match its complete native state.');
  if (actual !== EXPECTED_FINGERPRINT) {
    journal.programmeConflict = { fingerprint: actual, observedAt: Date.now(), lastUpdated: room.lastUpdated };
    throw new Error('Native programme changed; stop the test, remove its fixed-temperature backup and recover our Hold with Smart only.');
  }
  const sunday = schedule.days[6].events;
  const before = sunday.filter(event => event.hour * 60 + event.minute <= 21 * 60 + 59).at(-1);
  const after = sunday.filter(event => event.hour * 60 + event.minute <= 22 * 60 + 1).at(-1);
  if (before?.temperature !== 20 || after?.temperature !== 12 || after.hour !== 22 || after.minute !== 0) throw new Error('Expected Sunday22:00 20→12°C native event is not verified.');
  journal.programme = { fingerprint: actual, lastUpdated: room.lastUpdated, timeZone: room.timeZone,
    clockVerifiedInSettings: room.clockVerified === true, before, after, events: schedule.days };
  programmeVerifiedAt = Date.now(); save(); return room;
}
