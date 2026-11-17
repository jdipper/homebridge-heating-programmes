import {createHash} from 'node:crypto';

export const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
export type Weekday = typeof WEEKDAYS[number];
export type ProgrammeProfile = 'home' | 'away' | 'holiday';

export interface ProgrammePeriod {
  readonly startMinute: number;
  readonly targetC: number;
}

export type WeeklyProgramme = Readonly<Record<Weekday, readonly ProgrammePeriod[]>>;

export interface TargetLimits {
  readonly minC: number;
  readonly maxC: number;
  readonly stepC?: number;
}

export class ProgrammeValidationError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'ProgrammeValidationError';
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function requireProgramme(condition: unknown, code: string): asserts condition {
  if (!condition) throw new ProgrammeValidationError(code);
}

export function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every(key => keys.includes(key));
}

/** Copy and validate a complete week. This never invents a midnight period. */
export function copyProgramme(value: unknown, maximumPeriodsPerDay = 6, limits?: TargetLimits): WeeklyProgramme {
  requireProgramme(isRecord(value) && hasExactKeys(value, WEEKDAYS), 'COMPLETE_SEVEN_DAY_PROGRAMME_REQUIRED');
  requireProgramme(Number.isInteger(maximumPeriodsPerDay) && maximumPeriodsPerDay >= 1, 'INVALID_EVENT_LIMIT');
  if (limits) {
    requireProgramme(Number.isFinite(limits.minC) && Number.isFinite(limits.maxC) && limits.minC < limits.maxC,
      'INVALID_TARGET_LIMITS');
    requireProgramme(limits.stepC === undefined || (Number.isFinite(limits.stepC) && limits.stepC > 0),
      'INVALID_TARGET_STEP');
  }
  const result = {} as Record<Weekday, readonly ProgrammePeriod[]>;
  for (const day of WEEKDAYS) {
    const events = value[day];
    requireProgramme(Array.isArray(events) && events.length >= 1 && events.length <= maximumPeriodsPerDay,
      'INVALID_DAILY_PERIOD_COUNT');
    let previous = -1;
    result[day] = Object.freeze(events.map((event: unknown) => {
      requireProgramme(isRecord(event) && hasExactKeys(event, ['startMinute', 'targetC']), 'INVALID_PROGRAMME_PERIOD');
      const minute = event.startMinute;
      const target = event.targetC;
      requireProgramme(typeof minute === 'number' && Number.isInteger(minute) && minute >= 0 && minute < 1440
        && minute > previous, 'PERIOD_TIMES_MUST_BE_STRICTLY_INCREASING');
      requireProgramme(typeof target === 'number' && Number.isFinite(target), 'FINITE_TEMPERATURE_REQUIRED');
      if (limits) {
        requireProgramme(target >= limits.minC && target <= limits.maxC, 'TEMPERATURE_OUTSIDE_CONFIGURED_LIMITS');
        if (limits.stepC !== undefined) {
          const steps = (target - limits.minC) / limits.stepC;
          requireProgramme(Math.abs(steps - Math.round(steps)) < 1e-8, 'TEMPERATURE_OUTSIDE_CONFIGURED_STEP');
        }
      }
      previous = minute;
      return Object.freeze({startMinute: minute, targetC: Object.is(target, -0) ? 0 : target});
    }));
  }
  return Object.freeze(result);
}

export function programmeFingerprint(programme: WeeklyProgramme): string {
  const copy = copyProgramme(programme);
  return createHash('sha256').update(JSON.stringify(WEEKDAYS.map(day => copy[day]))).digest('hex');
}
