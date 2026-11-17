import {createHash, randomUUID} from 'node:crypto';
import {
  copyProgramme, hasExactKeys, isRecord, programmeFingerprint, ProgrammeValidationError, requireProgramme,
  TargetLimits, Weekday, WEEKDAYS, WeeklyProgramme,
} from '../programmes.js';

export type HiveZoneType = 'heating' | 'trvcontrol';
export interface HiveProduct {
  readonly id: string;
  readonly type: string;
  readonly state?: Readonly<Record<string, unknown>>;
  readonly props?: Readonly<Record<string, unknown>>;
}
export interface HiveNativePeriod {
  readonly start: number;
  readonly value: {readonly target: number};
}
export type HiveNativeWeek = Readonly<Record<Weekday, readonly HiveNativePeriod[]>>;
export interface HiveWritePreconditions {
  readonly schedule: HiveNativeWeek;
  readonly mode: string;
  readonly target: number | null;
  readonly holiday: unknown | null;
  readonly autoBoost: unknown | null;
  readonly autoBoostTarget: unknown | null;
  readonly heatingHolidays: readonly {readonly id: string; readonly holiday: unknown | null}[];
}
export interface HiveScheduleCommand {
  readonly schedule: HiveNativeWeek;
  readonly preconditions: HiveWritePreconditions;
  readonly expiresAt: number;
  /** Ask the private transport to reject dispatch unless its fresh write guard is present. */
  readonly requireFreshPreconditions?: true;
}
export interface HiveWriteAcknowledgement { readonly status: number; readonly body: unknown }
export interface HiveProgrammeTransport {
  readProducts(): Promise<readonly HiveProduct[]>;
  /** A private capability check, not a cloud read. Unadvertised transports keep the client guard. */
  supportsFreshWritePreconditions?(): Promise<boolean>;
  writeSchedule(zone: {readonly id: string; readonly type: HiveZoneType}, command: HiveScheduleCommand): Promise<HiveWriteAcknowledgement>;
}

/** Only use not-sent when the transport can prove it did not issue the request. */
export class HiveTransportError extends Error {
  constructor(public readonly code: string, public readonly outcome: 'not-sent' | 'unknown') {
    super(code);
    this.name = 'HiveTransportError';
  }
}

export interface HiveZoneSnapshot {
  readonly id: string;
  readonly type: HiveZoneType;
  readonly name: string;
  readonly online: boolean;
  readonly measuredC: number | null;
  readonly targetC: number | null;
  readonly mode: string;
  readonly nativeHolidayActive: boolean;
  readonly programme: WeeklyProgramme;
  readonly fingerprint: string;
  readonly readAt: number;
}

export interface PreparedProgramme {
  readonly token: string;
  readonly zone: HiveZoneSnapshot;
  readonly baselineFingerprint: string;
  readonly programme: WeeklyProgramme;
  readonly changesRequired: boolean;
  readonly expiresAt: number;
}

export interface ApplyResult {
  readonly status: 'confirmed' | 'conflict' | 'not-applied' | 'unconfirmed' | 'unknown';
  readonly reason: string;
  readonly zoneId: string;
  readonly writeAttempted: boolean;
  readonly acknowledged: boolean;
  readonly readback?: HiveZoneSnapshot;
}

export interface HiveAdapterOptions {
  /** Model limits must be supplied deliberately; the adapter does not guess them. */
  readonly targetLimits: TargetLimits;
  readonly previewTtlMs?: number;
  readonly maxPendingPreviews?: number;
  readonly verificationReads?: number;
  readonly verificationDelayMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
}

interface Observation {
  readonly snapshot: HiveZoneSnapshot;
  readonly controls: string;
  readonly accountHoliday: string;
  readonly preconditions: HiveWritePreconditions;
}
interface PreparedRecord {
  readonly view: PreparedProgramme;
  readonly baseline: Observation;
}

/** Hive echoes unused slots as exact copies of the final event. Only that padding is removed. */
export function parseHiveProgramme(value: unknown): WeeklyProgramme {
  requireProgramme(isRecord(value) && hasExactKeys(value, WEEKDAYS), 'COMPLETE_NATIVE_HIVE_WEEK_REQUIRED');
  const programme: Record<string, unknown> = {};
  for (const day of WEEKDAYS) {
    const raw = value[day];
    requireProgramme(Array.isArray(raw) && raw.length >= 1 && raw.length <= 6, 'INVALID_NATIVE_HIVE_EVENT_COUNT');
    const events = raw.map((event: unknown) => {
      requireProgramme(isRecord(event) && hasExactKeys(event, ['start', 'value']) && isRecord(event.value)
        && hasExactKeys(event.value, ['target']), 'UNSUPPORTED_NATIVE_HIVE_EVENT');
      requireProgramme(typeof event.start === 'number' && Number.isInteger(event.start) && event.start >= 0 && event.start < 1440,
        'INVALID_NATIVE_HIVE_TIME');
      requireProgramme(typeof event.value.target === 'number' && Number.isFinite(event.value.target), 'INVALID_NATIVE_HIVE_TARGET');
      return {startMinute: event.start, targetC: event.value.target};
    });
    const last = events.at(-1)!;
    while (events.length > 1) {
      const previous = events.at(-2)!;
      if (previous.startMinute !== last.startMinute || previous.targetC !== last.targetC) break;
      events.pop();
    }
    programme[day] = events;
  }
  return copyProgramme(programme);
}

export function serializeHiveProgramme(programme: WeeklyProgramme, limits?: TargetLimits): HiveNativeWeek {
  const copy = copyProgramme(programme, 6, limits);
  const result = {} as Record<Weekday, readonly HiveNativePeriod[]>;
  for (const day of WEEKDAYS) {
    result[day] = Object.freeze(copy[day].map(period => Object.freeze({
      start: period.startMinute, value: Object.freeze({target: period.targetC}),
    })));
  }
  return Object.freeze(result);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (isRecord(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
  return JSON.stringify(value) ?? 'undefined';
}

/** Preserve JSON metadata without sharing mutable API objects or dropping unknown values. */
function copyControlJson(value: unknown, ancestors = new Set<object>(), depth = 0): unknown | null {
  requireProgramme(depth <= 20, 'NATIVE_HIVE_CONTROL_METADATA_TOO_DEEP');
  if (value === undefined || value === null) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    requireProgramme(Number.isFinite(value), 'INVALID_NATIVE_HIVE_CONTROL_NUMBER');
    return Object.is(value, -0) ? 0 : value;
  }
  requireProgramme(typeof value === 'object' && !ancestors.has(value), 'INVALID_NATIVE_HIVE_CONTROL_METADATA');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return Object.freeze(value.map(item => copyControlJson(item, ancestors, depth + 1)));
    requireProgramme(isRecord(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null),
      'INVALID_NATIVE_HIVE_CONTROL_OBJECT');
    return Object.freeze(Object.fromEntries(Object.keys(value).map(key => [key, copyControlJson(value[key], ancestors, depth + 1)])));
  } finally {
    ancestors.delete(value);
  }
}

function holidayActive(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  // Unknown Holiday metadata is not evidence that Holiday is inactive.
  if (!isRecord(value)) return true;
  if (typeof value.active !== 'boolean' || typeof value.enabled !== 'boolean') return true;
  return value.active || value.enabled;
}

function protectedControls(preconditions: HiveWritePreconditions): string {
  return stableJson({mode: preconditions.mode, holiday: preconditions.holiday,
    autoBoost: preconditions.autoBoost, autoBoostTarget: preconditions.autoBoostTarget});
}

function accountHolidayState(products: readonly HiveProduct[]): {
  fingerprint: string; active: boolean; heatingHolidays: HiveWritePreconditions['heatingHolidays'];
} {
  const heating = products.filter(p => p.type === 'heating').map(p => {
    requireProgramme(typeof p.id === 'string' && /^[A-Za-z0-9-]{6,100}$/.test(p.id), 'INVALID_HIVE_HEATING_ZONE_ID');
    return Object.freeze({id: p.id, holiday: copyControlJson(p.props?.holidayMode)});
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  requireProgramme(heating.every((p, index) => index === 0 || p.id !== heating[index - 1]?.id), 'DUPLICATE_HIVE_HEATING_ZONE_ID');
  return {fingerprint: createHash('sha256').update(stableJson(heating)).digest('hex'),
    active: heating.some(p => holidayActive(p.holiday)), heatingHolidays: Object.freeze(heating)};
}

function zoneObservation(product: HiveProduct, products: readonly HiveProduct[], readAt: number): Observation {
  requireProgramme(product.type === 'heating' || product.type === 'trvcontrol', 'UNSUPPORTED_HIVE_ZONE_TYPE');
  requireProgramme(typeof product.id === 'string' && /^[A-Za-z0-9-]{6,100}$/.test(product.id), 'INVALID_HIVE_ZONE_ID');
  const programme = parseHiveProgramme(product.state?.schedule);
  const accountHoliday = accountHolidayState(products);
  const snapshot: HiveZoneSnapshot = Object.freeze({
    id: product.id, type: product.type,
    name: typeof product.state?.name === 'string' ? product.state.name : product.id.slice(-6),
    online: product.props?.online === true,
    measuredC: typeof product.props?.temperature === 'number' && Number.isFinite(product.props.temperature) ? product.props.temperature : null,
    targetC: typeof product.state?.target === 'number' && Number.isFinite(product.state.target) ? product.state.target : null,
    mode: typeof product.state?.mode === 'string' ? product.state.mode : 'UNKNOWN',
    nativeHolidayActive: holidayActive(product.props?.holidayMode) || accountHoliday.active,
    programme, fingerprint: programmeFingerprint(programme), readAt,
  });
  const preconditions: HiveWritePreconditions = Object.freeze({
    schedule: serializeHiveProgramme(programme), mode: snapshot.mode, target: snapshot.targetC,
    holiday: copyControlJson(product.props?.holidayMode), autoBoost: copyControlJson(product.state?.autoBoost),
    autoBoostTarget: copyControlJson(product.state?.autoBoostTarget), heatingHolidays: accountHoliday.heatingHolidays,
  });
  return {snapshot, controls: protectedControls(preconditions), accountHoliday: accountHoliday.fingerprint, preconditions};
}

function acknowledgementMatches(reply: HiveWriteAcknowledgement, desired: WeeklyProgramme): boolean {
  if (reply.status !== 200 || !isRecord(reply.body) || !hasExactKeys(reply.body, ['schedule'])) return false;
  try {
    return programmeFingerprint(parseHiveProgramme(reply.body.schedule)) === programmeFingerprint(desired);
  } catch {
    return false;
  }
}

/** Provider foundation only: no household policy, accessories, timers or credentials. */
export class HiveProgrammeAdapter {
  private readonly previews = new Map<string, PreparedRecord>();
  private readonly tails = new Map<string, Promise<unknown>>();
  private readonly now: () => number;
  private readonly ttl: number;
  private readonly maximum: number;
  private readonly limits: TargetLimits;
  private readonly verificationReads: number;
  private readonly verificationDelay: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(private readonly transport: HiveProgrammeTransport, options: HiveAdapterOptions) {
    this.now = options.now ?? Date.now;
    this.ttl = options.previewTtlMs ?? 5 * 60_000;
    this.maximum = options.maxPendingPreviews ?? 100;
    requireProgramme(Number.isFinite(this.ttl) && this.ttl > 0 && Number.isInteger(this.maximum) && this.maximum > 0,
      'INVALID_PREVIEW_OPTIONS');
    this.limits = Object.freeze({...options.targetLimits});
    this.verificationReads = options.verificationReads ?? 3;
    this.verificationDelay = options.verificationDelayMs ?? 1000;
    this.sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
    requireProgramme(Number.isInteger(this.verificationReads) && this.verificationReads >= 1 && this.verificationReads <= 3
      && Number.isFinite(this.verificationDelay) && this.verificationDelay >= 0 && this.verificationDelay <= 5000,
      'INVALID_READBACK_OPTIONS');
    // Validate limits even before the first user programme exists.
    copyProgramme(Object.fromEntries(WEEKDAYS.map(day => [day, [{startMinute: 0, targetC: this.limits.minC}]])), 6, this.limits);
  }

  async readZones(): Promise<readonly HiveZoneSnapshot[]> {
    const products = await this.transport.readProducts();
    const ids = new Set<string>();
    const zones = products.filter(p => p.type === 'heating' || p.type === 'trvcontrol').map(p => {
      requireProgramme(!ids.has(p.id), 'DUPLICATE_HIVE_ZONE_ID');
      ids.add(p.id);
      return zoneObservation(p, products, this.now()).snapshot;
    });
    return Object.freeze(zones);
  }

  async prepare(zoneId: string, programme: WeeklyProgramme): Promise<PreparedProgramme> {
    const desired = copyProgramme(programme, 6, this.limits);
    return this.serial(zoneId, async () => {
      const baseline = await this.observe(zoneId);
      this.requireWritable(baseline.snapshot);
      this.prune();
      requireProgramme(this.previews.size < this.maximum, 'TOO_MANY_PENDING_PREVIEWS');
      const view: PreparedProgramme = Object.freeze({token: randomUUID(), zone: baseline.snapshot,
        baselineFingerprint: baseline.snapshot.fingerprint, programme: desired,
        changesRequired: baseline.snapshot.fingerprint !== programmeFingerprint(desired), expiresAt: this.now() + this.ttl});
      this.previews.set(view.token, {view, baseline});
      return view;
    });
  }

  async apply(token: string): Promise<ApplyResult> {
    const queued = this.previews.get(token);
    requireProgramme(queued, 'UNKNOWN_OR_CONSUMED_PREVIEW');
    return this.serial(queued.view.zone.id, async () => {
      const record = this.previews.get(token);
      requireProgramme(record, 'UNKNOWN_OR_CONSUMED_PREVIEW');
      this.previews.delete(token);
      const zoneId = record.view.zone.id;
      const result = (status: ApplyResult['status'], reason: string, writeAttempted: boolean,
        acknowledged = false, readback?: HiveZoneSnapshot): ApplyResult => Object.freeze({status, reason, zoneId, writeAttempted, acknowledged, readback});
      if (this.now() >= record.view.expiresAt) return result('not-applied', 'PREVIEW_EXPIRED', false);
      let before: Observation;
      let guardedWrite = false;
      try {
        // The guarded runtime performs the same fresh comparison immediately
        // before its cloud POST. Do not repeat that GET in the client as well.
        guardedWrite = record.view.changesRequired
          && await this.transport.supportsFreshWritePreconditions?.() === true;
        before = guardedWrite ? record.baseline : await this.observe(zoneId);
        this.requireWritable(before.snapshot);
      } catch (error) {
        return result('not-applied', error instanceof ProgrammeValidationError ? error.code : 'FRESH_BASELINE_READ_FAILED', false);
      }
      if (before.snapshot.type !== record.baseline.snapshot.type || before.snapshot.fingerprint !== record.baseline.snapshot.fingerprint
        || before.snapshot.targetC !== record.baseline.snapshot.targetC || before.controls !== record.baseline.controls
        || before.accountHoliday !== record.baseline.accountHoliday) return result('conflict', 'LIVE_BASELINE_CHANGED', false, false, before.snapshot);
      const command: HiveScheduleCommand = Object.freeze({schedule: serializeHiveProgramme(record.view.programme, this.limits),
        preconditions: before.preconditions, expiresAt: record.view.expiresAt,
        ...(guardedWrite ? {requireFreshPreconditions: true as const} : {})});
      // Authentication and the fresh read can outlast a nearly expired preview.
      // No asynchronous work may occur between this check and the apply decision.
      if (this.now() >= record.view.expiresAt) return result('not-applied', 'PREVIEW_EXPIRED', false, false, before.snapshot);
      if (!record.view.changesRequired) return result('confirmed', 'PROGRAMME_ALREADY_MATCHES', false, false, before.snapshot);
      let acknowledged = false;
      let uncertain = false;
      let notSent = false;
      try {
        const reply = await this.transport.writeSchedule({id: zoneId, type: before.snapshot.type}, command);
        acknowledged = acknowledgementMatches(reply, record.view.programme);
        uncertain = !acknowledged;
      } catch (error) {
        notSent = error instanceof HiveTransportError && error.outcome === 'not-sent';
        uncertain = !notSent;
      }
      let after: Observation | undefined;
      const matches = (observation: Observation): boolean => observation.snapshot.online && observation.snapshot.mode === 'SCHEDULE'
        && !observation.snapshot.nativeHolidayActive && observation.snapshot.fingerprint === programmeFingerprint(record.view.programme)
        && observation.controls === before.controls && observation.accountHoliday === before.accountHoliday;
      // Only acknowledged writes receive bounded read-only verification retries.
      // An ambiguous write stays ambiguous even if its diagnostic read matches.
      for (let attempt = 0; attempt < (acknowledged ? this.verificationReads : 1); attempt++) {
        if (attempt) await this.sleep(this.verificationDelay);
        try { after = await this.observe(zoneId); } catch { after = undefined; }
        if (after && matches(after)) break;
      }
      if (notSent) return result('not-applied', 'TRANSPORT_CONFIRMED_REQUEST_NOT_SENT', false, false, after?.snapshot);
      if (uncertain) return result('unknown', 'WRITE_OUTCOME_NOT_CONFIRMED', true, false, after?.snapshot);
      if (!after) return result('unconfirmed', 'READBACK_FAILED', true, acknowledged);
      const confirmed = matches(after);
      return confirmed ? result('confirmed', 'COMPLETE_NATIVE_WEEK_MATCHED', true, acknowledged, after.snapshot)
        : result('unconfirmed', 'NATIVE_WEEK_OR_CONTROLS_NOT_CONFIRMED', true, acknowledged, after.snapshot);
    });
  }

  private async observe(zoneId: string): Promise<Observation> {
    requireProgramme(typeof zoneId === 'string' && /^[A-Za-z0-9-]{6,100}$/.test(zoneId), 'INVALID_HIVE_ZONE_ID');
    const products = await this.transport.readProducts();
    const matches = products.filter(p => p.id === zoneId);
    requireProgramme(matches.length === 1 && matches[0], 'EXPECTED_ONE_HIVE_ZONE');
    return zoneObservation(matches[0], products, this.now());
  }

  private requireWritable(zone: HiveZoneSnapshot): void {
    requireProgramme(zone.online, 'HIVE_ZONE_OFFLINE');
    requireProgramme(zone.mode === 'SCHEDULE', 'HIVE_ZONE_NOT_IN_SCHEDULE_MODE');
    requireProgramme(!zone.nativeHolidayActive, 'NATIVE_HIVE_HOLIDAY_ACTIVE_OR_UNKNOWN');
    requireProgramme(zone.targetC !== null, 'HIVE_TARGET_UNAVAILABLE');
  }

  private prune(): void {
    for (const [token, record] of this.previews) if (this.now() >= record.view.expiresAt) this.previews.delete(token);
  }

  private async serial<T>(zoneId: string, action: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(zoneId) ?? Promise.resolve();
    const operation = prior.catch(() => undefined).then(action);
    this.tails.set(zoneId, operation);
    try { return await operation; } finally { if (this.tails.get(zoneId) === operation) this.tails.delete(zoneId); }
  }
}
