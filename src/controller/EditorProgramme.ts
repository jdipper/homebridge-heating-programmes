import {copyProgramme, isRecord, ProgrammeProfile, WEEKDAYS, WeeklyProgramme} from '../programmes';

export type ThermostatProfileId = ProgrammeProfile;
export interface ThermostatWeeklyProgramme {
  days: {day: number; events: {event: number; hour: number; minute: number; temperature: number}[]}[];
}

export function toEditor(programme: WeeklyProgramme): ThermostatWeeklyProgramme {
  const valid = copyProgramme(programme);
  return {days: WEEKDAYS.map((day, index) => ({day: 1 << index, events: valid[day].map((period, event) => ({
    event, hour: Math.floor(period.startMinute / 60), minute: period.startMinute % 60, temperature: period.targetC,
  }))}))};
}

export function fromEditor(value: unknown): WeeklyProgramme {
  if (!isRecord(value) || !Array.isArray(value.days) || value.days.length !== 7) throw new Error('A complete seven-day programme is required.');
  const week: Record<string, unknown> = {};
  for (const source of value.days) {
    if (!isRecord(source) || !Array.isArray(source.events)) throw new Error('Invalid programme day.');
    const index = [1, 2, 4, 8, 16, 32, 64].indexOf(source.day as number);
    const name = WEEKDAYS[index];
    if (!name || Object.hasOwn(week, name)) throw new Error('Each weekday must appear exactly once.');
    week[name] = source.events.map((event: unknown, slot: number) => {
      if (!isRecord(event) || event.event !== slot || !Number.isInteger(event.hour) || (event.hour as number) < 0
        || (event.hour as number) > 23 || !Number.isInteger(event.minute) || (event.minute as number) < 0
        || (event.minute as number) > 59) throw new Error('Programme periods must have valid times and consecutive event numbers.');
      return {startMinute: (event.hour as number) * 60 + (event.minute as number), targetC: event.temperature};
    });
  }
  return copyProgramme(week);
}

export function validateThermostatWeeklyProgramme(value: unknown): ThermostatWeeklyProgramme {
  return toEditor(fromEditor(value));
}
