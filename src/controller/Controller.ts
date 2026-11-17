import {EventEmitter} from 'node:events';
import {randomUUID} from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {copyProgramme, isRecord, ProgrammeProfile, programmeFingerprint, WeeklyProgramme} from '../programmes';
import {HeatingZone, matchesFreshProgrammeTarget, ProgrammeProvider, ProviderPreview} from './Provider';
import {fromEditor, toEditor} from './EditorProgramme';
import {createThermostatControlPolicy, evaluateThermostatControlPolicy, policyDeadlines, policyIntent,
  policyMinutes, policyTimestamp, restoreThermostatControlPolicy, ThermostatControlPolicy} from './ControlPolicy';
import {getThermostatNowNext, isThermostatTimeZone} from './NowNext';
import ThermostatHistory from './History';
import {readPrivateJson, writePrivateJson} from './PrivateFile';
import {readLegacyMigration} from './LegacyMigration';
import RuntimeServer from './RuntimeServer';

interface Room {
  provider: 'tuya' | 'hive'; deviceId: string;
  name?: string; timeZone: string; clockVerified: boolean;
  profiles: Partial<Record<ProgrammeProfile, WeeklyProgramme>>;
  enabled: boolean;
  requestedProfile: ProgrammeProfile | null;
  confirmation?: {profile: ProgrammeProfile; programme: WeeklyProgramme; at: number};
  inFlight?: {profile: ProgrammeProfile; operationId: string};
  failure?: string;
  /** A failed identical automatic selection is never replayed; later different intent may prepare afresh. */
  failureProfile?: ProgrammeProfile | null;
}
interface SavedState {
  version: 1; controls: ThermostatControlPolicy; rooms: Record<string, Room>;
  history?: unknown; migration?: {sourceFiles: {name: string; sha256: string}[]; importedAt: number};
  cachedZones?: Record<string, HeatingZone>;
  observationIds?: string[];
}
interface Plan {id: string; expiresAt: number; devices: {id: string; profile: ProgrammeProfile; preview: ProviderPreview; changes: number}[]}
interface Job {status: string; error?: string; requestedProfile?: ProgrammeProfile}
const profiles: ProgrammeProfile[] = ['home', 'away', 'holiday'];
function profile(value: unknown): ProgrammeProfile {
  if (!profiles.includes(value as ProgrammeProfile)) throw new Error('Choose Home, Away or Holiday.');
  return value as ProgrammeProfile;
}
function errorMessage(error: unknown): string {return error instanceof Error ? error.message : 'Heating operation failed.';}
function intent(policy: ThermostatControlPolicy): ProgrammeProfile | null {
  const selected = policyIntent(policy);
  return selected.holiday ? 'holiday' : selected.anyoneHome === null ? null : selected.anyoneHome ? 'home' : 'away';
}

/** One owner of household policy and saved profiles. Vendor sessions stay in their plugins. */
export class HeatingController extends EventEmitter {
  readonly instanceId = '0000000000000001';
  private saved: SavedState = {version: 1, controls: createThermostatControlPolicy(), rooms: {}};
  private zones = new Map<string, HeatingZone>();
  private jobs = new Map<string, Job>();
  private running = new Map<string, Promise<void>>();
  private reserved = new Set<string>();
  private pending = new Map<string, ProgrammeProfile>();
  private automatic = new Map<string, {abort: AbortController; profile: ProgrammeProfile; fingerprint: string; timeZone?: string}>();
  private plans = new Map<string, Plan>();
  private history = new ThermostatHistory();
  private stateQueue: Promise<void> = Promise.resolve();
  private refreshOperation?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private poll?: NodeJS.Timeout;
  private closed = false;
  private ready = false;
  private server: RuntimeServer;
  private legacyReadOnlyServer?: RuntimeServer;
  private systemErrors: Record<string, string> = {};
  private file: string;
  constructor(private persistPath: string, private providers: ProgrammeProvider[],
    private log: {warn(...values: unknown[]): void} = console) {
    super();
    if (new Set(providers.map(provider => provider.id)).size !== providers.length) throw new Error('Only one provider per system is supported.');
    this.file = path.join(persistPath, 'HeatingProgrammes.json');
    this.server = new RuntimeServer(persistPath, this.instanceId, this.handle);
  }
  get householdPresence() {return this.saved.controls.actualHome;}
  get homeActive() {return this.saved.controls.holidayActive ? false : this.saved.controls.actualHome;}
  get holidayActive() {return this.saved.controls.holidayActive;}

  async start(options: {publishServer?: boolean; poll?: boolean; migrate?: boolean} = {}): Promise<void> {
    await fs.mkdir(this.persistPath, {recursive: true, mode: 0o700});
    // An old live household owner must be retired before this one can control heating.
    for (const name of await fs.readdir(this.persistPath)) {
      if (!/^TuyaRuntime\.[a-f0-9]{16}\.json$/.test(name)) continue;
      try {
        const descriptor = await readPrivateJson(path.join(this.persistPath, name));
        if (isRecord(descriptor) && Number.isSafeInteger(descriptor.pid) && (descriptor.pid as number) > 0) {
          try {process.kill(descriptor.pid as number, 0);}
          catch (error) {if ((error as NodeJS.ErrnoException).code === 'ESRCH') continue; throw error;}
          throw new Error('The Tuya household controller is still running. Install its device-provider build before starting the shared controller.');
        }
      } catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
    }
    if (options.publishServer !== false) await this.server.start();
    try {
      try {
        this.saved = this.restore(await readPrivateJson(this.file));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        const migration = options.migrate === false ? null : await readLegacyMigration(this.persistPath);
        if (migration) {
          this.saved.controls = migration.controls;
          if (migration.recoveryRequired) this.saved.controls.recoveryRequired = migration.recoveryRequired;
          for (const [id, room] of Object.entries(migration.rooms)) {
            this.saved.rooms[id] = {provider: room.provider, deviceId: room.deviceId, name: room.name,
              timeZone: room.timeZone, clockVerified: room.clockVerified, profiles: room.profiles,
              enabled: room.enabled, requestedProfile: room.enabled ? intent(this.saved.controls) : null};
          }
          this.saved.migration = {sourceFiles: migration.sourceFiles, importedAt: Date.now()};
          const historyDevices = Object.fromEntries(Object.entries(migration.rooms).map(([id, room]) => [id, {
            temperatures: room.history?.temperatures ?? [], programmes: room.history?.programmes.map(version => ({
              ...version, programme: toEditor(version.programme),
            })) ?? [],
          }]));
          this.saved.history = {version: 1, devices: historyDevices};
        }
      }
      this.history.restore(this.saved.history);
      for (const [id, zone] of Object.entries(this.saved.cachedZones ?? {})) {
        if (!this.saved.rooms[id] || !isRecord(zone) || zone.id !== this.saved.rooms[id]!.deviceId
          || !isRecord(zone.periods) || !isRecord(zone.limits) || typeof zone.name !== 'string'
          || typeof zone.mode !== 'string' || typeof zone.scheduled !== 'boolean' || !Number.isSafeInteger(zone.readAt)
          || !Number.isInteger(zone.periods.min) || !Number.isInteger(zone.periods.max)
          || zone.periods.min < 1 || zone.periods.max > 6 || zone.periods.min > zone.periods.max) continue;
        try {
          if (zone.programme) copyProgramme(zone.programme, zone.periods.max, zone.limits);
          this.zones.set(id, {...zone, online: false, writeEnabled: false});
        } catch { /* Cached programmes have no authority and can be read again. */ }
      }
      await this.refresh();
      this.saved.controls = restoreThermostatControlPolicy(this.saved.controls,
        this.saved.controls.actualHome, this.saved.controls.holidayActive, Date.now());
      await this.save();
      this.ready = true;
      if (options.publishServer !== false) {
        const sources = this.saved.migration?.sourceFiles ?? [];
        if (sources.length === 1) {
          const legacyId = /^TuyaThermostatProfiles\.([a-f0-9]{16})\.json$/.exec(sources[0]!.name)?.[1];
          if (legacyId) {
            this.legacyReadOnlyServer = new RuntimeServer(this.persistPath, legacyId,
              async (route, body) => {
                await this.legacyRead(route, body);
                return {...this.legacyView(), instanceId: legacyId};
              }, {descriptorName: `TuyaRuntime.${legacyId}.json`, socketName: `tuya-${legacyId}.sock`,
                ownerName: `SharedHeatingReadOnlyOwner.${legacyId}.json`, plugin: '@jdipper/homebridge-tuya',
                compatibility: 'shared-read-only'});
            await this.legacyReadOnlyServer.start();
          }
        }
      }
      // Startup only restores intent. It never uploads a programme or retries an interrupted operation.
      this.schedulePolicy();
      if (options.poll !== false) {
        this.poll = setInterval(() => {void this.refresh().catch(() => undefined);}, 60_000);
        this.poll.unref();
      }
    } catch (error) {
      this.ready = false;
      await this.legacyReadOnlyServer?.close(); await this.server.close(); throw error;
    }
  }

  private restore(value: unknown): SavedState {
    if (!isRecord(value) || value.version !== 1 || !isRecord(value.rooms)) throw new Error('Invalid shared heating settings.');
    const controls = restoreThermostatControlPolicy(value.controls, null, false, Date.now());
    const rooms: Record<string, Room> = {};
    for (const [id, source] of Object.entries(value.rooms)) {
      if (!isRecord(source) || !['tuya','hive'].includes(source.provider as string)
        || typeof source.deviceId !== 'string' || id !== `${source.provider}:${source.deviceId}`
        || !/^(tuya|hive):[A-Za-z0-9_-]{1,128}$/.test(id) || !isRecord(source.profiles)
        || typeof source.enabled !== 'boolean') throw new Error('Invalid saved heating room.');
      const programmes: Room['profiles'] = {};
      for (const [key, programme] of Object.entries(source.profiles)) programmes[profile(key)] = copyProgramme(programme);
      if (source.enabled && profiles.some(key => !programmes[key])) throw new Error('An enabled heating room needs all three saved programmes.');
      rooms[id] = {provider: source.provider as Room['provider'], deviceId: source.deviceId, ...this.settings(source),
        profiles: programmes, enabled: source.enabled, requestedProfile: source.enabled ? intent(controls) : null};
      if (source.inFlight) {
        rooms[id]!.failure = 'A programme operation was interrupted. Read and verify before applying again.';
        if (isRecord(source.inFlight) && profiles.includes(source.inFlight.profile as ProgrammeProfile)) {
          rooms[id]!.failureProfile = source.inFlight.profile as ProgrammeProfile;
        }
      } else if (typeof source.failure === 'string') {
        rooms[id]!.failure = source.failure;
        if (source.failureProfile === null || profiles.includes(source.failureProfile as ProgrammeProfile)) {
          rooms[id]!.failureProfile = source.failureProfile as ProgrammeProfile | null;
        }
      }
      // Old confirmations are deliberately not restored as current hardware evidence.
    }
    if (value.observationIds !== undefined && (!Array.isArray(value.observationIds) || value.observationIds.length > 4096
      || value.observationIds.some(id => typeof id !== 'string' || id.length > 256))) throw new Error('Invalid saved temperature observation cursor.');
    return {version: 1, controls, rooms, history: value.history, observationIds: value.observationIds as string[] | undefined,
      ...(isRecord(value.cachedZones) ? {cachedZones: value.cachedZones as unknown as Record<string, HeatingZone>} : {}),
      ...(isRecord(value.migration) ? {migration: value.migration as unknown as SavedState['migration']} : {})};
  }

  private settings(source: Record<string, unknown>): Pick<Room, 'name' | 'timeZone' | 'clockVerified'> {
    if (source.name !== undefined && (typeof source.name !== 'string' || source.name.length > 100)) throw new Error('Choose a room name of up to 100 characters.');
    if (source.timeZone !== undefined && !isThermostatTimeZone(source.timeZone)) throw new Error('Choose a valid time zone.');
    if (source.clockVerified !== undefined && typeof source.clockVerified !== 'boolean') throw new Error('Clock confirmation must be on or off.');
    return {name: typeof source.name === 'string' ? source.name.trim() || undefined : undefined, timeZone: source.timeZone as string ?? 'Europe/London',
      clockVerified: source.clockVerified as boolean ?? false};
  }

  private provider(id: string): ProgrammeProvider {
    const room = this.saved.rooms[id];
    const provider = this.providers.find(item => item.id === room?.provider);
    if (!room || !provider) throw new Error('Choose a room with a connected heating system.');
    return provider;
  }
  private ids(value: unknown): string[] {
    if (!Array.isArray(value) || value.length === 0 || value.length > 256 || value.some(id => typeof id !== 'string' || !Object.hasOwn(this.saved.rooms, id))) throw new Error('Select one or more heating rooms.');
    return [...new Set(value)] as string[];
  }
  private id(value: unknown): string {return this.ids([value])[0]!;}
  private busy(id: string): void {if (this.running.has(id) || this.reserved.has(id)) throw new Error('A selected room already has an operation in progress.');}
  private validate(id: string, programme: WeeklyProgramme): WeeklyProgramme {
    const zone = this.zones.get(id);
    if (!zone) throw new Error('Refresh this room before editing its programme.');
    const valid = copyProgramme(programme, zone.periods.max, zone.limits);
    if (Object.values(valid).some(events => events.length < zone.periods.min)) throw new Error(`${zone.name} needs ${zone.periods.min} periods per day.`);
    return valid;
  }

  async refresh(refreshRoomNames = false): Promise<void> {
    if (this.closed) return;
    if (this.refreshOperation) {
      await this.refreshOperation;
      if (refreshRoomNames) await this.refresh(true);
      return;
    }
    this.refreshOperation = (async () => {
      await Promise.all(this.providers.map(async provider => {
        try {
          const zones = await (refreshRoomNames && provider.refresh ? provider.refresh() : provider.list());
          const found = new Set<string>();
          await this.transaction(() => {
          for (const zone of zones) {
            const id = `${provider.id}:${zone.id}`;
            if (!/^(tuya|hive):[A-Za-z0-9_-]{1,128}$/.test(id) || found.has(id)) throw new Error('Invalid or duplicate provider room.');
            found.add(id);
            if (!this.saved.rooms[id]) this.saved.rooms[id] = {provider: provider.id, deviceId: zone.id,
              timeZone: 'Europe/London', clockVerified: false, profiles: {}, enabled: false, requestedProfile: null};
            this.observe(id, zone);
          }
          for (const [id, room] of Object.entries(this.saved.rooms)) {
            if (room.provider === provider.id && !found.has(id)) this.markUnavailable(id);
          }
          });
          delete this.systemErrors[provider.id];
        } catch (error) {
          this.systemErrors[provider.id] = errorMessage(error);
          await this.transaction(() => {
            for (const [id, room] of Object.entries(this.saved.rooms)) if (room.provider === provider.id) this.markUnavailable(id);
          });
        }
      }));
      this.emit('change');
    })().finally(() => {this.refreshOperation = undefined;});
    return this.refreshOperation;
  }
  private markUnavailable(id: string): void {
    const zone = this.zones.get(id);
    if (zone) this.zones.set(id, {...zone, online: false});
    delete this.saved.rooms[id]!.confirmation;
  }
  private observe(id: string, zone: HeatingZone): void {
    this.zones.set(id, structuredClone(zone));
    const room = this.saved.rooms[id]!;
    if (!zone.online || !zone.scheduled || (room.confirmation && zone.programme
      && programmeFingerprint(zone.programme) !== programmeFingerprint(room.confirmation.programme))) delete room.confirmation;
    if (zone.programme) this.history.recordProgramme(id, {source: 'native', programme: toEditor(zone.programme)});
    const seen = new Set(this.saved.observationIds ?? []);
    for (const observation of zone.observations ?? []) {
      const key = observation.id ? `${id}:${observation.id}` : undefined;
      if (key && seen.has(key)) continue;
      this.history.ingestTemperature(id, observation);
      if (key) seen.add(key);
    }
    this.saved.observationIds = [...seen].slice(-4096);
    const observation = zone as HeatingZone & {temperatureReceivedAt?: number; temperatureReportedAt?: number};
    if (observation.temperatureReceivedAt) this.history.ingestTemperature(id, {
      at: observation.temperatureReceivedAt, sourceAt: observation.temperatureReportedAt,
      currentTemperature: zone.measuredC ?? undefined, online: zone.online, unit: 'c',
    });
  }

  view() {
    const selected = intent(this.saved.controls);
    return {instanceId: this.instanceId,
      thermostats: Object.entries(this.saved.rooms).map(([id, room]) => {
        const zone = this.zones.get(id);
        const job = this.jobs.get(id);
        const confirmation = room.confirmation;
        const confirmed = Boolean(zone?.online && zone.scheduled && zone.programme && confirmation
          && programmeFingerprint(zone.programme) === programmeFingerprint(confirmation.programme)
          && confirmation.profile === room.requestedProfile && room.profiles[confirmation.profile]
          && programmeFingerprint(room.profiles[confirmation.profile]!) === programmeFingerprint(confirmation.programme)
          && !room.inFlight && !room.failure && !this.saved.controls.recoveryRequired);
        const schedule = zone?.programme ? {days: toEditor(zone.programme).days.map(day => ({...day, complete: true})),
          complete: true, errors: []} : undefined;
        return {id, name: room.name ?? zone?.roomName ?? zone?.name ?? `${room.provider} thermostat`,
          provider: room.provider, systemName: this.providers.find(item => item.id === room.provider)?.title ?? room.provider,
          roomName: zone?.roomName, deviceName: zone?.name, customName: room.name,
          nameSource: room.name ? 'custom' : zone?.roomName ? room.provider : 'device',
          online: zone?.online ?? false, currentTemperature: zone?.measuredC ?? undefined, targetTemperature: zone?.targetC ?? undefined,
          targetReadAt: zone?.targetReadAt,
          mode: zone?.mode, grouping: room.provider === 'tuya' ? 0 : undefined, scheduled: zone?.scheduled ?? false,
          timeZone: room.timeZone, clockVerified: room.clockVerified,
          nowNext: zone?.programme ? getThermostatNowNext(toEditor(zone.programme), room) : undefined,
          lastUpdated: zone?.readAt, schedule, scheduleFingerprint: zone?.fingerprint,
          programmeWriteMode: zone?.programmeWriteMode,
          programmeLimits: {minPeriods: zone?.periods.min ?? (room.provider === 'tuya' ? 4 : 1),
            maxPeriods: zone?.periods.max ?? (room.provider === 'tuya' ? 4 : 6), minC: zone?.limits.minC ?? 5,
            maxC: zone?.limits.maxC ?? 32, stepC: zone?.limits.stepC ?? 0.5}, writeEnabled: zone?.writeEnabled ?? false,
          profiles: Object.fromEntries(Object.entries(room.profiles).map(([key, week]) => [key, toEditor(week)])),
          enabled: room.enabled, programmeHistory: this.history.programmeHistory(id),
          sync: {status: job?.status ?? (room.failure ? 'failed' : confirmed ? 'verified' : room.requestedProfile ? 'pending' : 'idle'),
            profileStatus: room.inFlight ? 'applying' : room.failure ? 'failed' : confirmed ? 'confirmed' : room.requestedProfile ? 'pending' : 'idle',
            requestedProfile: room.requestedProfile, confirmedProfile: confirmation?.profile ?? null, confirmedAt: confirmation?.at ?? null,
            applyingProfile: room.inFlight?.profile ?? null, queuedProfile: this.pending.get(id) ?? null,
            lastAttemptedProfile: job?.requestedProfile ?? null, confirmationMatchesRequested: confirmed,
            error: job?.error ?? room.failure},
        };
      }),
      presence: {home: this.saved.controls.actualHome, effectiveHome: this.saved.controls.effectiveHome,
        holdUntil: this.saved.controls.holdUntil},
      holiday: {active: this.saved.controls.holidayActive, returnAt: this.saved.controls.returnAt,
        preheatMinutes: this.saved.controls.preheatMinutes, preheating: this.saved.controls.preheating,
        recoveryRequired: this.saved.controls.recoveryRequired},
      controls: {recoveryRequired: this.saved.controls.recoveryRequired}, systemErrors: {...this.systemErrors},
      selectedProfile: selected, migration: this.saved.migration};
  }

  /** Compatibility for the already scheduled investigation: reads only, with original device IDs. */
  legacyView() {
    const view = this.view();
    return {...view, thermostats: view.thermostats.filter(room => room.provider === 'tuya')
      .map(room => ({...room, id: room.id.slice(5)}))};
  }
  async legacyRead(route: string, body: Record<string, unknown>): Promise<void> {
    if (route === '/thermostats') {await this.handle(route, {}); return;}
    if (route !== '/schedules/read' || Object.keys(body).some(key => key !== 'deviceIds')
      || !Array.isArray(body.deviceIds) || body.deviceIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id))) {
      throw new Error('The compatibility endpoint supports native programme reads only.');
    }
    await this.handle(route, {deviceIds: body.deviceIds.map(id => `tuya:${id}`)});
  }

  handle = async (route: string, body: Record<string, unknown>): Promise<unknown> => {
    if (this.closed || !this.ready) throw new Error('The heating controller is starting or shutting down.');
    switch (route) {
      case '/thermostats': return this.view();
      case '/rooms/refresh': await this.refresh(true); return this.view();
      case '/rooms/save': {
        const id = this.id(body.deviceId);
        await this.transaction(() => {
          const room = this.saved.rooms[id]!, settings = this.settings({...room, ...body});
          if (room.provider === 'tuya' && settings.timeZone !== room.timeZone) delete room.confirmation;
          Object.assign(room, settings);
        });
        return this.view();
      }
      case '/temperatures/history': {
        const id = this.id(body.deviceId);
        const hours = body.hours === undefined ? 24 : body.hours;
        if (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0 || hours > 720) throw new Error('Choose a history range up to 30 days.');
        return {...this.view(), temperatureHistory: this.history.temperatureHistory(id, hours)};
      }
      case '/profiles/history': return {...this.view(), programmeHistory: this.history.programmeHistory(this.id(body.deviceId))};
      case '/profiles/restore': {
        const id = this.id(body.deviceId);
        const version = typeof body.versionId === 'string' ? this.history.getProgrammeVersion(id, body.versionId) : undefined;
        if (!version) throw new Error('Choose a retained programme version.');
        return this.handle('/profiles/save', {...body, schedule: version.programme});
      }
      case '/profiles/save': {
        const id = this.id(body.deviceId), key = profile(body.profile);
        const programme = this.validate(id, fromEditor(body.schedule));
        await this.transaction(() => {
          const room = this.saved.rooms[id]!;
          if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new Error('Automatic selection must be explicitly enabled or disabled.');
          const next = {...room.profiles, [key]: programme};
          const enabled = body.enabled === undefined ? room.enabled : body.enabled as boolean;
          if (enabled && profiles.some(item => !next[item])) throw new Error('Save complete Home, Away and Holiday programmes first.');
          if (body.enabled === true && !room.enabled && !this.zones.get(id)?.writeEnabled) throw new Error('Programme uploads must be enabled for this thermostat before enabling automatic changes.');
          if (room.profiles[key]) this.history.recordProgramme(id, {source: 'draft', profile: key, programme: toEditor(room.profiles[key]!)});
          this.history.recordProgramme(id, {source: 'draft', profile: key, programme: toEditor(programme)});
          room.profiles = next; room.enabled = enabled; room.requestedProfile = enabled ? intent(this.saved.controls) : null;
          if (room.confirmation?.profile === key && programmeFingerprint(room.confirmation.programme) !== programmeFingerprint(programme)) delete room.confirmation;
          delete room.failure; delete room.failureProfile;
          this.plans.clear();
        });
        if (!this.running.has(id)) this.jobs.delete(id);
        return this.view();
      }
      case '/schedules/read': {
        const ids = this.ids(body.deviceIds);
        const key = body.verifyProfile === undefined ? undefined : profile(body.verifyProfile);
        ids.forEach(id => {this.busy(id); if (key && !this.saved.rooms[id]!.profiles[key]) throw new Error('Save the selected programme before verifying it.');});
        for (const id of ids) this.launch(id, key ? 'verifying' : 'reading', async () => {
          const room = this.saved.rooms[id]!;
          const expected = key ? room.profiles[key] : undefined;
          const timeZone = room.timeZone, startedAt = Date.now();
          const observed = await this.provider(id).read(room.deviceId);
          await this.transaction(() => {
            this.observe(id, observed);
            const current = this.saved.rooms[id]!;
            if (key) {
              if (!observed.online || !observed.scheduled || !observed.programme || !expected
                || programmeFingerprint(observed.programme) !== programmeFingerprint(expected)
                || !current.profiles[key] || programmeFingerprint(current.profiles[key]!) !== programmeFingerprint(expected)) throw new Error('The complete stored programme or Scheduled mode does not match. No changes were sent.');
              if (room.provider === 'tuya' && (current.timeZone !== timeZone
                || !matchesFreshProgrammeTarget(observed, expected, timeZone, startedAt))) {
                throw new Error('The current target temperature does not freshly match the active programme period. No changes were sent.');
              }
              current.confirmation = {profile: key, programme: expected, at: Date.now()}; delete current.failure; delete current.failureProfile;
            }
          });
          this.jobs.set(id, {status: observed.programme ? 'verified' : 'partial'});
        });
        return this.view();
      }
      case '/schedules/apply': case '/profiles/select': {
        if (body.preview === true) return this.preview(this.ids(body.deviceIds), profile(body.profile));
        if (typeof body.previewId !== 'string') throw new Error('Review the programme changes first.');
        const plan = this.plans.get(body.previewId);
        if (!plan || plan.expiresAt <= Date.now()) throw new Error('Preview expired. Review again before applying.');
        for (const item of plan.devices) {
          this.busy(item.id);
          const current = this.saved.rooms[item.id]!.profiles[item.profile];
          if (!current || programmeFingerprint(current) !== programmeFingerprint(item.preview.programme)) throw new Error('A draft changed after preview. Review again.');
          const room = this.saved.rooms[item.id]!;
          if (room.provider === 'tuya' && item.preview.activeTarget?.timeZone !== room.timeZone) {
            throw new Error('The room time zone changed after preview. Review again.');
          }
        }
        this.plans.delete(plan.id);
        for (const item of plan.devices) this.launchApply(item.id, item.profile, item.preview);
        return this.view();
      }
      case '/presence/hold': return this.setPolicy(policy => ({...policy, holdUntil: policyTimestamp(body.until, 'Keep Home until', Date.now())}));
      case '/controls/recover':
        if (body.confirm !== true) throw new Error('Review and explicitly confirm recovery.');
        return this.setPolicy(policy => ({...policy, recoveryRequired: null}));
      case '/home': case '/presence':
        if (typeof body.home !== 'boolean') throw new Error('Presence must indicate whether anyone is home.');
        return this.setPolicy(policy => ({...policy, actualHome: body.home as boolean,
          effectiveHome: body.home as boolean,
          ...(route === '/home' && body.home ? {holidayActive: false, returnAt: null, preheatMinutes: 0, preheating: false} : {})}), true);
      case '/holiday':
        if (typeof body.active !== 'boolean') throw new Error('Holiday must be on or off.');
        return this.setPolicy(policy => {
          const active = body.active as boolean;
          if (!active && policy.holidayActive && policy.actualHome === null
            && (policy.holdUntil === null || policy.holdUntil <= Date.now())
            && Object.values(this.saved.rooms).some(room => room.enabled)) throw new Error('Set household presence before ending Holiday.');
          const returnAt = active && body.returnAt !== undefined ? policyTimestamp(body.returnAt, 'Holiday return', Date.now())
            : active ? policy.returnAt : null;
          const preheatMinutes = body.preheatMinutes === undefined ? policy.preheatMinutes : policyMinutes(body.preheatMinutes, 'Preheat lead', 1440);
          if (active && returnAt !== null && returnAt - preheatMinutes * 60000 <= Date.now() && preheatMinutes > 0) throw new Error('Choose a return after the preheat period.');
          return {...policy, holidayActive: active, returnAt, preheatMinutes, preheating: false};
        }, true);
      default: throw new Error('Unsupported heating operation.');
    }
  };

  private async preview(ids: string[], key: ProgrammeProfile): Promise<unknown> {
    ids.forEach(id => this.busy(id));
    ids.forEach(id => this.reserved.add(id));
    try {
      const devices: Plan['devices'] = [];
      for (let offset = 0; offset < ids.length; offset += 3) {
        const results = await Promise.allSettled(ids.slice(offset, offset + 3).map(async id => {
          const room = this.saved.rooms[id]!, zone = this.zones.get(id);
          const programme = room.profiles[key];
          if (!programme) throw new Error('Save the selected profile for every selected room first.');
          if (!zone?.online || !zone.writeEnabled || !zone.fingerprint) throw new Error('Read a complete current programme and enable uploads before applying.');
          const prepared = await this.provider(id).prepare(room.deviceId, this.validate(id, programme), zone.fingerprint,
            room.provider === 'tuya' ? {activeTarget: {timeZone: room.timeZone}} : undefined);
          const changes = Object.keys(programme).reduce((count, day) => {
            const desired = programme[day as keyof WeeklyProgramme], previous = zone.programme?.[day as keyof WeeklyProgramme] ?? [];
            return count + Array.from({length: Math.max(desired.length, previous.length)}, (_, slot) =>
              JSON.stringify(desired[slot]) !== JSON.stringify(previous[slot])).filter(Boolean).length;
          }, 0);
          return {id, profile: key, preview: prepared, changes};
        }));
        for (const result of results) {
          if (result.status === 'rejected') throw result.reason;
          devices.push(result.value);
        }
      }
      const plan: Plan = {id: randomUUID(), expiresAt: Math.min(...devices.map(item => item.preview.expiresAt)), devices};
      for (const [id, stale] of this.plans) if (stale.expiresAt <= Date.now()) this.plans.delete(id);
      while (this.plans.size >= 20) this.plans.delete(this.plans.keys().next().value!);
      this.plans.set(plan.id, plan);
      return {...this.view(), preview: {id: plan.id, expiresAt: plan.expiresAt,
        devices: devices.map(item => ({id: item.id, name: this.view().thermostats.find(room => room.id === item.id)!.name,
          profile: key, changes: item.changes}))},
        warnings: ['Each heating system is applied and verified separately. A failure may leave different programmes active.']};
    } finally {
      ids.forEach(id => this.reserved.delete(id));
      for (const id of ids) this.drainPending(id);
    }
  }

  private async setPolicy(change: (policy: ThermostatControlPolicy) => ThermostatControlPolicy, explicitSelection = false): Promise<unknown> {
    const changed: {id: string; key: ProgrammeProfile}[] = [];
    await this.transaction(() => {
      const controls = evaluateThermostatControlPolicy(change(this.saved.controls), Date.now());
      this.saved.controls = controls;
      if (controls.recoveryRequired) return;
      const key = intent(controls);
      for (const [id, room] of Object.entries(this.saved.rooms)) {
        const next = room.enabled ? key : null;
        if (next && (room.requestedProfile !== next || (explicitSelection && room.failure
          && room.failureProfile !== undefined && room.failureProfile !== next))) changed.push({id, key: next});
        room.requestedProfile = next;
      }
    });
    this.schedulePolicy();
    for (const {id, key} of changed) {
      if (this.running.has(id) || this.reserved.has(id)) this.pending.set(id, key);
      else this.launchApply(id, key);
    }
    return this.view();
  }

  private cancelObsoleteAutomatic(): void {
    for (const [id, operation] of this.automatic) {
      if (operation.abort.signal.aborted) continue;
      const room = this.saved.rooms[id];
      if (!room?.enabled) operation.abort.abort('disabled');
      else if (room.requestedProfile !== operation.profile) operation.abort.abort('intent-changed');
      else if (operation.timeZone !== undefined && room.timeZone !== operation.timeZone) operation.abort.abort('time-zone-changed');
      else if (!room.profiles[operation.profile]
        || programmeFingerprint(room.profiles[operation.profile]!) !== operation.fingerprint) operation.abort.abort('draft-changed');
    }
  }

  private launchApply(id: string, key: ProgrammeProfile, preview?: ProviderPreview): void {
    this.busy(id);
    const desiredAtStart = this.saved.rooms[id]!.profiles[key];
    const automatic = preview || !desiredAtStart ? undefined : {
      abort: new AbortController(), profile: key, fingerprint: programmeFingerprint(desiredAtStart),
      timeZone: this.saved.rooms[id]!.provider === 'tuya' ? this.saved.rooms[id]!.timeZone : undefined,
    };
    if (automatic) this.automatic.set(id, automatic);
    const operationId = randomUUID();
    this.launch(id, 'applying', async () => {
      const room = this.saved.rooms[id]!;
      const desired = room.profiles[key];
      if (!desired) throw new Error('This room has no saved programme for the requested profile.');
      const provider = this.provider(id);
      let prepared = preview;
      let dispatched = false;
      const obsolete = () => Boolean(automatic?.abort.signal.aborted);
      const finishObsolete = async () => {
        await this.transaction(() => {const current = this.saved.rooms[id]!;
          if (current.inFlight?.operationId === operationId) delete current.inFlight;
          // An old successful request cannot confirm the latest household intent.
          delete current.confirmation;
        });
        this.jobs.set(id, {status: 'pending', requestedProfile: key});
      };
      try {
        if (!prepared) {
          if (room.failure && (room.failureProfile === undefined || room.failureProfile === key)) {
            throw new Error('A previous identical programme operation needs review. Verify the thermostat before applying again.');
          }
          // The provider owns a fresh native baseline and enforces Scheduled mode
          // before upload. The controller still checks the saved draft before apply.
          prepared = await provider.prepare(room.deviceId, this.validate(id, desired), undefined, {requireScheduled: true,
            ...(room.provider === 'tuya' ? {activeTarget: {timeZone: automatic!.timeZone!}} : {})});
        }
        const currentDraft = this.saved.rooms[id]!.profiles[key];
        if (!currentDraft || programmeFingerprint(prepared.programme) !== programmeFingerprint(currentDraft)
          || programmeFingerprint(prepared.programme) !== programmeFingerprint(desired)) throw new Error('The saved programme changed during preparation.');
        if (room.provider === 'tuya' && prepared.activeTarget?.timeZone !== this.saved.rooms[id]!.timeZone) {
          throw new Error('The room time zone changed during preparation. Review again.');
        }
        if (!preview && (obsolete() || !this.saved.rooms[id]!.enabled || this.saved.rooms[id]!.requestedProfile !== key)) {
          await finishObsolete(); return;
        }
        await this.transaction(() => {const current = this.saved.rooms[id]!;
          if (!current.profiles[key] || programmeFingerprint(current.profiles[key]!) !== programmeFingerprint(desired)) throw new Error('The saved programme changed before upload.');
          current.inFlight = {profile: key, operationId}; delete current.failure; delete current.failureProfile;});
        if (obsolete()) {await finishObsolete(); return;}
        if (this.closed || prepared.expiresAt <= Date.now()) throw new Error('Programme application stopped before upload.');
        dispatched = true;
        const applyStartedAt = Date.now();
        const result = await provider.apply(prepared.token, automatic ? {signal: automatic.abort.signal} : undefined);
        if (result.readback) await this.transaction(() => {this.observe(id, result.readback!);});
        if (obsolete() && ((result.status === 'not-applied' && !result.writeAttempted)
          || (result.superseded === true && result.status !== 'unknown' && result.status !== 'confirmed'))) {
          await finishObsolete(); return;
        }
        if (result.status !== 'confirmed' || !result.readback?.online || !result.readback.scheduled || !result.readback.programme
          || programmeFingerprint(result.readback.programme) !== programmeFingerprint(desired)) {
          throw new Error(`${result.reason} Do not automatically retry; read and verify this thermostat.`);
        }
        if (room.provider === 'tuya' && (prepared.activeTarget?.timeZone !== this.saved.rooms[id]!.timeZone
          || !matchesFreshProgrammeTarget(result.readback, desired, prepared.activeTarget.timeZone, applyStartedAt))) {
          throw new Error('The current target temperature does not freshly match the active programme period. Do not automatically retry; read and verify this thermostat.');
        }
        if (obsolete()) {await finishObsolete(); return;}
        let confirmed = false;
        await this.transaction(() => {const current = this.saved.rooms[id]!;
          // A selection/draft edit can win the state queue after provider readback.
          if (obsolete() || (!preview && (!current.enabled || current.requestedProfile !== key))
            || !current.profiles[key] || programmeFingerprint(current.profiles[key]!) !== programmeFingerprint(desired)) {
            if (current.inFlight?.operationId === operationId) delete current.inFlight;
            delete current.confirmation; return;
          }
          current.confirmation = {profile: key, programme: desired, at: Date.now()}; confirmed = true;
          delete current.inFlight; delete current.failure; delete current.failureProfile;});
        this.jobs.set(id, {status: confirmed && !obsolete() ? 'verified' : 'pending', requestedProfile: key});
      } finally {
        if (prepared && !dispatched) await provider.discard?.(prepared.token).catch(() => undefined);
        if (this.automatic.get(id) === automatic) this.automatic.delete(id);
      }
    }, key);
  }

  private launch(id: string, status: string, task: () => Promise<void>, key?: ProgrammeProfile): void {
    this.busy(id);
    this.jobs.set(id, {status, requestedProfile: key});
    const promise = Promise.resolve().then(task).catch(async error => {
      const reason = errorMessage(error);
      // Retain a later different selection. It will acquire its own fresh baseline
      // only after this operation and its provider queue have finished.
      if (this.pending.get(id) === key) this.pending.delete(id);
      await this.transaction(() => {const room = this.saved.rooms[id]!;
        const unknownFailure = room.failure && room.failureProfile === undefined;
        room.failure = reason;
        if (!unknownFailure) room.failureProfile = key ?? null;
        delete room.inFlight; delete room.confirmation;
      }).catch(() => {this.saved.controls.recoveryRequired = 'Could not save the heating outcome. Review recovery.';});
      this.jobs.set(id, {status: 'failed', error: reason, requestedProfile: key});
      this.log.warn('Heating room operation needs attention.');
    }).finally(() => {
      this.automatic.delete(id);
      this.running.delete(id);
      this.emit('change');
      this.drainPending(id);
    });
    this.running.set(id, promise);
    this.emit('change');
  }
  private drainPending(id: string): void {
    if (this.running.has(id) || this.reserved.has(id)) return;
    const queued = this.pending.get(id);
    this.pending.delete(id);
    const room = this.saved.rooms[id];
    if (queued && !this.closed && !this.saved.controls.recoveryRequired
      && (!room?.failure || (room.failureProfile !== undefined && room.failureProfile !== queued))
      && room?.enabled && room.requestedProfile === queued) this.launchApply(id, queued);
  }
  private schedulePolicy(): void {
    clearTimeout(this.timer);
    if (this.closed) return;
    const next = policyDeadlines(this.saved.controls).sort((a,b) => a-b)[0];
    if (next === undefined) return;
    this.timer = setTimeout(() => {void this.setPolicy(policy => policy).catch(async () => {
      this.saved.controls.recoveryRequired = 'A household deadline could not be saved. Review and resume control.';
      await this.save().catch(() => undefined); this.emit('change');
    });}, Math.min(2147483647, Math.max(1, next - Date.now())));
    this.timer.unref();
  }
  private async save(): Promise<void> {
    await writePrivateJson(this.file, {...this.saved, history: this.history.snapshot(),
      cachedZones: Object.fromEntries([...this.zones].map(([id, zone]) => [id, zone]))});
  }
  private transaction(change: () => void): Promise<void> {
    const operation = this.stateQueue.then(async () => {
      const previous = structuredClone(this.saved), history = this.history.snapshot();
      try {change(); await this.save();}
      catch (error) {this.saved = previous; this.history.restore(history); throw error;}
      this.cancelObsoleteAutomatic();
      this.emit('change');
    });
    this.stateQueue = operation.catch(() => undefined);
    return operation;
  }
  async idle(): Promise<void> {await Promise.allSettled([...this.running.values()]); await this.stateQueue;}
  async close(): Promise<void> {
    this.closed = true;
    this.ready = false;
    clearTimeout(this.timer); clearInterval(this.poll); this.pending.clear(); this.plans.clear();
    for (const operation of this.automatic.values()) operation.abort.abort('closed');
    await this.refreshOperation; await this.idle(); await this.save();
    await this.legacyReadOnlyServer?.close(); await this.server.close();
  }
}
