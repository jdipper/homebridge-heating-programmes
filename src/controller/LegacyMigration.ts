import {createHash} from 'node:crypto';
import {constants} from 'node:fs';
import {lstat, open, readdir, realpath} from 'node:fs/promises';
import {join} from 'node:path';
import {copyProgramme, isRecord, ProgrammeProfile, WEEKDAYS, WeeklyProgramme} from '../programmes.js';
import {restoreThermostatControlPolicy, ThermostatControlPolicy} from './ControlPolicy.js';

const PROFILE_IDS: readonly ProgrammeProfile[] = ['home', 'away', 'holiday'];
const DAY_MASKS = [1, 2, 4, 8, 16, 32, 64] as const;
const FILE_PATTERN = /^TuyaThermostatProfiles\.([a-f0-9]{16})\.json$/;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_INSTANCES = 16;
const MAX_ROOMS = 256;

export interface LegacyProgrammeVersion {
  id: string;
  at: number;
  source: 'draft' | 'native';
  profile?: ProgrammeProfile;
  programme: WeeklyProgramme;
}

export interface LegacyMigrationRoom {
  provider: 'tuya';
  deviceId: string;
  legacyId: string;
  sourceInstanceId: string;
  name?: string;
  timeZone: string;
  clockVerified: boolean;
  profiles: Partial<Record<ProgrammeProfile, WeeklyProgramme>>;
  enabled: boolean;
  history?: {temperatures: Record<string, unknown>[]; programmes: LegacyProgrammeVersion[]};
}

export interface LegacyMigration {
  sourceFiles: {name: string; sha256: string}[];
  controls: ThermostatControlPolicy;
  rooms: Record<string, LegacyMigrationRoom>;
  /** Preserved for auditing only; never interpreted as fresh observations or confirmation. */
  legacyHistory: Record<string, unknown>;
  recoveryRequired: string | null;
  interruptedDeviceIds: string[];
}

function requireValid(condition: unknown, reason: string): asserts condition {
  if (!condition) throw new Error(`Legacy heating migration: ${reason}`);
}

function deviceId(value: unknown): string {
  requireValid(typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value), 'invalid device identity.');
  return value;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(stableJson).join(',') + ']';
  if (isRecord(value)) return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + stableJson(value[key])).join(',') + '}';
  return JSON.stringify(value) ?? 'undefined';
}

/** Exact legacy four-period conversion. No missing day, event or midnight period is invented. */
export function convertLegacyTuyaProgramme(value: unknown): WeeklyProgramme {
  requireValid(isRecord(value) && Array.isArray(value.days) && value.days.length === 7,
    'a saved programme does not contain a complete week.');
  const result: Record<string, unknown> = {};
  const seen = new Set<number>();
  for (const day of value.days) {
    requireValid(isRecord(day) && typeof day.day === 'number' && DAY_MASKS.includes(day.day as typeof DAY_MASKS[number])
      && !seen.has(day.day) && Array.isArray(day.events) && day.events.length === 4,
    'a saved programme has an invalid or repeated day.');
    seen.add(day.day);
    const events = day.events.map(event => {
      requireValid(isRecord(event) && Number.isSafeInteger(event.event) && typeof event.event === 'number'
        && event.event >= 0 && event.event <= 3 && Number.isSafeInteger(event.hour) && typeof event.hour === 'number'
        && event.hour >= 0 && event.hour <= 23 && Number.isSafeInteger(event.minute) && typeof event.minute === 'number'
        && event.minute >= 0 && event.minute <= 59 && typeof event.temperature === 'number',
      'a saved programme has an invalid event.');
      return {event: event.event, startMinute: event.hour * 60 + event.minute, targetC: event.temperature};
    }).sort((a, b) => a.event - b.event);
    requireValid(events.every((event, index) => event.event === index), 'a saved programme has missing or duplicate events.');
    const weekday = WEEKDAYS[DAY_MASKS.indexOf(day.day as typeof DAY_MASKS[number])]!;
    result[weekday] = events.map(({startMinute, targetC}) => ({startMinute, targetC}));
  }
  return copyProgramme(result, 4, {minC: 5, maxC: 40, stepC: 0.5});
}

function roomSettings(value: unknown): Pick<LegacyMigrationRoom, 'name' | 'timeZone' | 'clockVerified'> {
  if (value === undefined) return {timeZone: 'Europe/London', clockVerified: false};
  requireValid(isRecord(value) && typeof value.timeZone === 'string' && value.timeZone.length <= 100
    && typeof value.clockVerified === 'boolean', 'invalid room settings.');
  try { new Intl.DateTimeFormat('en-GB', {timeZone: value.timeZone}).format(0); }
  catch { throw new Error('Legacy heating migration: invalid room time zone.'); }
  requireValid(value.name === undefined || (typeof value.name === 'string' && value.name.trim().length > 0
    && value.name.length <= 80 && !/[\x00-\x1f\x7f]/.test(value.name)), 'invalid room name.');
  return {timeZone: value.timeZone, clockVerified: value.clockVerified,
    ...(typeof value.name === 'string' ? {name: value.name} : {})};
}

function roomHistory(value: unknown, now: number): LegacyMigrationRoom['history'] {
  if (value === undefined) return undefined;
  requireValid(isRecord(value), 'invalid saved room history.');
  const temperatures: Record<string, unknown>[] = [];
  const programmes: LegacyProgrammeVersion[] = [];
  const validTime = (at: unknown): at is number => typeof at === 'number' && Number.isSafeInteger(at)
    && at > 0 && at <= now + 300_000;
  const validTemp = (temperature: unknown, target: boolean) => typeof temperature === 'number'
    && Number.isFinite(temperature) && temperature >= (target ? 5 : -40) && temperature <= (target ? 40 : 100);
  for (const point of (Array.isArray(value.temperatures) ? value.temperatures : []).slice(-1500)) {
    // Keep the old history's accepted observations only. Never stamp imported data with the migration time.
    if (!isRecord(point) || !validTime(point.at) || typeof point.online !== 'boolean'
      || (point.sourceAt !== undefined && (!validTime(point.sourceAt) || point.sourceAt > point.at + 300_000))
      || (point.currentTemperature !== undefined && !validTemp(point.currentTemperature, false))
      || (point.targetTemperature !== undefined && !validTemp(point.targetTemperature, true))
      || (!point.online && (point.currentTemperature !== undefined || point.targetTemperature !== undefined))) continue;
    temperatures.push({at: point.at, online: point.online,
      ...(point.sourceAt === undefined ? {} : {sourceAt: point.sourceAt}),
      ...(point.currentTemperature === undefined ? {} : {currentTemperature: point.currentTemperature}),
      ...(point.targetTemperature === undefined ? {} : {targetTemperature: point.targetTemperature})});
  }
  const seen = new Set<string>();
  for (const version of (Array.isArray(value.programmes) ? value.programmes : []).slice(-50)) {
    if (!isRecord(version) || typeof version.id !== 'string'
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(version.id)
      || seen.has(version.id) || !validTime(version.at) || !['draft', 'native'].includes(version.source as string)
      || (version.profile !== undefined && !PROFILE_IDS.includes(version.profile as ProgrammeProfile))
      || (version.source === 'draft' && version.profile === undefined)) continue;
    try {
      programmes.push({id: version.id, at: version.at, source: version.source as 'draft' | 'native',
        ...(version.profile === undefined ? {} : {profile: version.profile as ProgrammeProfile}),
        programme: convertLegacyTuyaProgramme(version.programme)});
      seen.add(version.id);
    } catch { /* Malformed historical versions stay in the original source, not in restore candidates. */ }
  }
  temperatures.sort((a, b) => (a.at as number) - (b.at as number));
  programmes.sort((a, b) => a.at - b.at);
  return {temperatures, programmes};
}

async function readPrivateFile(directory: string, name: string): Promise<{value: unknown; sha256: string}> {
  const file = await open(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    requireValid(before.isFile() && !(before.mode & 0o077) && before.size > 0 && before.size <= MAX_FILE_BYTES
      && (!process.getuid || before.uid === process.getuid()), 'settings source must be an owner-only bounded regular file.');
    // The same owner can still replace or enlarge a legacy file during cutover.
    // Never let an unexpectedly growing file turn this into an unbounded read.
    const buffer = Buffer.alloc(Math.min(MAX_FILE_BYTES + 1, before.size + 1));
    let length = 0;
    while (length < buffer.length) {
      const {bytesRead} = await file.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const bytes = buffer.subarray(0, length);
    const after = await file.stat();
    requireValid(bytes.length <= MAX_FILE_BYTES && before.size === after.size && before.mtimeMs === after.mtimeMs
      && before.ctimeMs === after.ctimeMs, 'settings changed while being read. Stop the old controller before migration.');
    return {value: JSON.parse(bytes.toString('utf8')), sha256: createHash('sha256').update(bytes).digest('hex')};
  } finally { await file.close(); }
}

/**
 * Read-only migration input. The caller owns the one-time atomic new-state write and ownership cutover.
 * Existing device confirmations/snapshots have no authority here and no operation is resumed.
 */
export async function readLegacyMigration(persistPath: string, now = Date.now()): Promise<LegacyMigration | null> {
  requireValid(Number.isSafeInteger(now) && now > 0, 'invalid migration time.');
  const directoryInfo = await lstat(persistPath);
  requireValid(directoryInfo.isDirectory() && !directoryInfo.isSymbolicLink() && !(directoryInfo.mode & 0o022)
    && (!process.getuid || directoryInfo.uid === process.getuid()), 'settings directory must be owned and not writable by other users.');
  const directory = await realpath(persistPath);
  const names = (await readdir(directory)).filter(name => FILE_PATTERN.test(name)).sort();
  if (!names.length) return null;
  requireValid(names.length <= MAX_INSTANCES, 'too many legacy instances; choose the instances to migrate explicitly.');
  const sourceFiles: LegacyMigration['sourceFiles'] = [];
  const rooms: Record<string, LegacyMigrationRoom> = {};
  const legacyHistory: Record<string, unknown> = {};
  const interrupted = new Set<string>();
  let controls: ThermostatControlPolicy | undefined;
  const recoveryReasons = new Set<string>();
  for (const name of names) {
    const instanceId = FILE_PATTERN.exec(name)![1]!;
    const {value, sha256} = await readPrivateFile(directory, name);
    requireValid(isRecord(value) && (value.version === 1 || value.version === 2) && isRecord(value.profiles),
      'unsupported legacy settings format.');
    const profiles = value.profiles;
    requireValid(profiles.version === 1 && isRecord(profiles.devices) && Array.isArray(profiles.enabledDeviceIds)
      && (profiles.anyoneHome === null || typeof profiles.anyoneHome === 'boolean') && typeof profiles.holiday === 'boolean',
    'invalid legacy profile settings.');
    const nextControls = restoreThermostatControlPolicy(value.controls, profiles.anyoneHome as boolean | null,
      profiles.holiday, now);
    if (controls) requireValid(stableJson(controls) === stableJson(nextControls),
      'multiple Tuya instances have different household rules. Choose one household policy before migration.');
    else controls = nextControls;
    if (nextControls.recoveryRequired) recoveryReasons.add(nextControls.recoveryRequired);
    const enabled = new Set(profiles.enabledDeviceIds.map(deviceId));
    requireValid(enabled.size === profiles.enabledDeviceIds.length, 'duplicate enabled device identity.');
    requireValid(value.rooms === undefined || isRecord(value.rooms), 'invalid room settings container.');
    requireValid(value.overrides === undefined || isRecord(value.overrides), 'invalid saved override state.');
    requireValid(value.history === undefined || (isRecord(value.history) && value.history.version === 1
      && isRecord(value.history.devices)), 'invalid saved history container.');
    const savedRooms = isRecord(value.rooms) ? value.rooms : {};
    const history = isRecord(value.history) && isRecord(value.history.devices) ? value.history.devices : {};
    for (const [rawId, saved] of Object.entries(profiles.devices)) {
      const id = deviceId(rawId);
      const key = `tuya:${id}`;
      requireValid(!Object.hasOwn(rooms, key), 'a thermostat appears in more than one legacy instance.');
      requireValid(Object.keys(rooms).length < MAX_ROOMS && isRecord(saved) && isRecord(saved.programmes),
        'invalid or excessive saved room profiles.');
      const programmes: LegacyMigrationRoom['profiles'] = {};
      for (const [profile, programme] of Object.entries(saved.programmes)) {
        requireValid(PROFILE_IDS.includes(profile as ProgrammeProfile), 'unknown saved programme name.');
        programmes[profile as ProgrammeProfile] = convertLegacyTuyaProgramme(programme);
      }
      requireValid(!enabled.has(id) || PROFILE_IDS.every(profile => programmes[profile]),
        'an automatically controlled room lacks a complete Home/Away/Holiday profile set.');
      rooms[key] = {provider: 'tuya', deviceId: id, legacyId: id, sourceInstanceId: instanceId,
        ...roomSettings(savedRooms[id]), profiles: programmes, enabled: enabled.has(id),
        ...(history[id] === undefined ? {} : {history: roomHistory(history[id], now)})};
      if (saved.inFlight !== undefined && saved.inFlight !== null) interrupted.add(key);
    }
    requireValid([...enabled].every(id => Object.hasOwn(profiles.devices as Record<string, unknown>, id)),
      'an enabled thermostat has no saved profile record.');
    for (const [rawId, override] of Object.entries(isRecord(value.overrides) ? value.overrides : {})) {
      const id = deviceId(rawId);
      requireValid(isRecord(override) && ['starting', 'active', 'resuming', 'recovery-required', 'failed', 'completed']
        .includes(override.status as string), 'unrecognized saved override status.');
      if (override.status !== 'failed' && override.status !== 'completed') interrupted.add(`tuya:${id}`);
    }
    sourceFiles.push({name, sha256});
    if (value.history !== undefined) legacyHistory[instanceId] = structuredClone(value.history);
  }
  if (interrupted.size) recoveryReasons.add('An upload or temporary override was in progress in the Tuya controller. '
    + 'Review the affected thermostats before enabling shared household changes; no interrupted operation was resumed.');
  const recoveryRequired = [...recoveryReasons].join(' ') || null;
  return {sourceFiles, controls: {...controls!, recoveryRequired}, rooms, legacyHistory,
    recoveryRequired, interruptedDeviceIds: [...interrupted].sort()};
}
