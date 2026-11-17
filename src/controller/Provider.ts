import {TargetLimits, WeeklyProgramme} from '../programmes';

export interface HeatingZone {
  id: string;
  name: string;
  roomName?: string;
  online: boolean;
  measuredC: number | null;
  targetC: number | null;
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
}
export interface ProviderApplyResult {
  status: 'confirmed' | 'conflict' | 'not-applied' | 'unconfirmed' | 'unknown';
  reason: string;
  writeAttempted: boolean;
  readback?: HeatingZone;
}
export interface ProviderPrepareOptions {
  /** Automatic household changes must not cancel a manual Hold or boost. */
  requireScheduled?: boolean;
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
  apply(token: string): Promise<ProviderApplyResult>;
  /** Release a queue-owned automatic baseline when draft/policy checks abort before apply. */
  discard?(token: string): Promise<void>;
}
