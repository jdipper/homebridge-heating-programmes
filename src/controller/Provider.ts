import {TargetLimits, WeeklyProgramme} from '../programmes';
import {toEditor} from './EditorProgramme';
import {getThermostatNowNext, isThermostatTimeZone} from './NowNext';

export interface HeatingZone {
  id: string;
  name: string;
  roomName?: string;
  online: boolean;
  measuredC: number | null;
  targetC: number | null;
  /** Receipt time of a successful native target-property HTTP read, never a cache poll. */
  targetReadAt?: number;
  mode: string;
  scheduled: boolean;
  readAt: number;
  temperatureReceivedAt?: number;
  temperatureReportedAt?: number;
  temperatureSource?: string;
  observations?: {id?: string; at: number; sourceAt?: number; currentTemperature?: number; targetTemperature?: number;
    online: boolean; unit?: 'c' | 'f'}[];
  programme?: WeeklyProgramme;
  fingerprint?: string;
  writeEnabled: boolean;
  limits: TargetLimits;
  periods: {min: number; max: number};
  programmeWriteMode?: 'single-events' | 'whole-days' | 'grouped-events' | 'grouped-days';
}
export interface ProviderPreview {
  token: string;
  deviceId: string;
  programme: WeeklyProgramme;
  expiresAt: number;
  changesRequired: boolean;
  activeTarget?: {timeZone: string};
}
export interface ProviderApplyResult {
  status: 'confirmed' | 'conflict' | 'not-applied' | 'unconfirmed' | 'unknown';
  reason: string;
  writeAttempted: boolean;
  /** Explicit proof of known supersession, never an unknown or failed native write. */
  superseded?: boolean;
  readback?: HeatingZone;
}
export interface ProviderPrepareOptions {
  /** Automatic household changes must not cancel a manual Hold or boost. */
  requireScheduled?: boolean;
  /** Apply and verify the requested programme's currently active temperature. */
  activeTarget?: {timeZone: string};
}

/** A complete stored week is separate from a fresh proof of its active target. */
export function matchesFreshProgrammeTarget(zone: HeatingZone, programme: WeeklyProgramme, timeZone: string,
  since: number, now = Date.now()): boolean {
  if (!isThermostatTimeZone(timeZone) || !Number.isSafeInteger(zone.targetReadAt) || zone.targetReadAt! < since
    || zone.targetReadAt! > now || typeof zone.targetC !== 'number' || !Number.isFinite(zone.targetC)) return false;
  // This flag enables the calculation's DST-ambiguity guard only. It neither
  // reads nor changes the user's independent physical-clock confirmation.
  const clock = {timeZone, clockVerified: true};
  const atRead = getThermostatNowNext(toEditor(programme), clock, zone.targetReadAt);
  const current = getThermostatNowNext(toEditor(programme), clock, now);
  return Boolean(atRead.safeForExpiry && current.safeForExpiry && atRead.current && current.current
    && atRead.current.at === current.current.at && zone.targetC === atRead.current.temperature);
}
export interface ProviderApplyOptions {
  /** Superseding household intent stops commands that have not yet been submitted. */
  signal?: AbortSignal;
}
/** Vendor plugins retain authentication and wire operations; only the controller selects profiles. */
export interface ProgrammeProvider {
  id: 'tuya' | 'hive';
  title: string;
  list(): Promise<HeatingZone[]>;
  refresh?(): Promise<HeatingZone[]>;
  read(deviceId: string): Promise<HeatingZone>;
  prepare(deviceId: string, programme: WeeklyProgramme, expectedFingerprint?: string,
    options?: ProviderPrepareOptions): Promise<ProviderPreview>;
  apply(token: string, options?: ProviderApplyOptions): Promise<ProviderApplyResult>;
  /** Release a queue-owned automatic baseline when draft/policy checks abort before apply. */
  discard?(token: string): Promise<void>;
}
