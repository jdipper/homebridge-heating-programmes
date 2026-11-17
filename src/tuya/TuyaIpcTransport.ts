import {constants} from 'node:fs';
import {lstat, open, readdir, realpath, stat} from 'node:fs/promises';
import {request} from 'node:http';
import {dirname, join} from 'node:path';
import {copyProgramme, isRecord, requireProgramme, WeeklyProgramme} from '../programmes';
import {HeatingZone, matchesFreshProgrammeTarget, ProgrammeProvider, ProviderApplyOptions, ProviderApplyResult, ProviderPrepareOptions, ProviderPreview} from '../controller/Provider';
import {isThermostatTimeZone} from '../controller/NowNext';

interface Descriptor {
  version: 1;
  protocolVersion: 1;
  plugin: '@jdipper/homebridge-tuya';
  instanceId: string;
  pid: number;
  socketPath: string;
  token: string;
  capabilities?: {automaticFreshBaseline?: boolean; automaticCancellation?: boolean; activeTargetAlignment?: boolean};
}
export interface TuyaIpcTransportOptions {
  storagePath: string;
  instanceId?: string;
}
interface PreparedOwner {descriptor: Descriptor; deviceId: string; programme: WeeklyProgramme; expiresAt: number; automatic: boolean;
  activeTarget?: {timeZone: string}}

/** Private device connection. It never reads Tuya credentials or decides household intent. */
export class TuyaIpcTransport implements ProgrammeProvider {
  readonly id = 'tuya' as const;
  readonly title = 'FastWarm';
  private readonly previews = new Map<string, PreparedOwner>();

  constructor(private readonly options: TuyaIpcTransportOptions) {
    requireProgramme(typeof options.storagePath === 'string' && options.storagePath.length > 0
      && (options.instanceId === undefined || /^[a-f0-9]{16}$/.test(options.instanceId)), 'TUYA_IPC_OPTIONS_INVALID');
  }

  async list(): Promise<HeatingZone[]> {
    return this.readZones('/provider/list');
  }

  async refresh(): Promise<HeatingZone[]> {
    return this.readZones('/provider/refresh');
  }

  private async readZones(route: '/provider/list' | '/provider/refresh'): Promise<HeatingZone[]> {
    const descriptor = await this.descriptor();
    const body = await this.call(descriptor, route, {}, false);
    requireProgramme(Array.isArray(body.zones) && body.zones.length <= 256, 'TUYA_IPC_INVALID_ZONE_LIST');
    const zones = body.zones.map(zone => this.zone(zone));
    requireProgramme(new Set(zones.map(zone => zone.id)).size === zones.length, 'TUYA_IPC_DUPLICATE_ZONE');
    return zones;
  }

  async read(deviceId: string): Promise<HeatingZone> {
    this.deviceId(deviceId);
    const descriptor = await this.descriptor();
    const body = await this.call(descriptor, '/provider/read', {deviceId}, false);
    const zone = this.zone(body.zone);
    requireProgramme(zone.id === deviceId, 'TUYA_IPC_ZONE_ID_MISMATCH');
    return zone;
  }

  async prepare(deviceId: string, programme: WeeklyProgramme, expectedFingerprint?: string,
    options: ProviderPrepareOptions = {}): Promise<ProviderPreview> {
    this.deviceId(deviceId);
    const desired = copyProgramme(programme, 4, {minC: 5, maxC: 40, stepC: 0.5});
    requireProgramme(Object.values(desired).every(periods => periods.length === 4), 'TUYA_FOUR_PERIODS_REQUIRED');
    requireProgramme(expectedFingerprint === undefined || /^[a-f0-9]{64}$/.test(expectedFingerprint),
      'TUYA_IPC_INVALID_BASELINE');
    requireProgramme(options.activeTarget === undefined || (isRecord(options.activeTarget)
      && Object.keys(options.activeTarget).length === 1 && isThermostatTimeZone(options.activeTarget.timeZone)),
    'TUYA_IPC_INVALID_ACTIVE_TARGET');
    const activeTarget = options.activeTarget && {timeZone: options.activeTarget.timeZone};
    const descriptor = await this.descriptor();
    requireProgramme(!activeTarget || descriptor.capabilities?.activeTargetAlignment === true,
      'TUYA_IPC_ACTIVE_TARGET_ALIGNMENT_REQUIRED');
    const automatic = options.requireScheduled === true && expectedFingerprint === undefined
      && descriptor.capabilities?.automaticFreshBaseline === true;
    const body = await this.call(descriptor, automatic ? '/provider/prepare-automatic' : '/provider/prepare', {deviceId, programme: desired,
      ...(expectedFingerprint === undefined ? {} : {expectedFingerprint}),
      ...(activeTarget ? {activeTarget} : {}),
      ...(options.requireScheduled === true ? {requireScheduled: true} : {})}, false);
    const preview = body.preview;
    requireProgramme(isRecord(preview) && typeof preview.token === 'string' && /^[a-f0-9-]{36}$/.test(preview.token)
      && preview.deviceId === deviceId && typeof preview.changesRequired === 'boolean'
      && typeof preview.expiresAt === 'number' && Number.isSafeInteger(preview.expiresAt)
      && preview.expiresAt > Date.now() && preview.expiresAt <= Date.now() + 5 * 60_000 + 5000, 'TUYA_IPC_INVALID_PREVIEW');
    // Old providers can ignore an unknown request field. Do not accept their
    // preview for automatic changes without explicit proof of the fresh guard.
    requireProgramme(options.requireScheduled !== true || preview.requireScheduled === true,
      'TUYA_IPC_SCHEDULED_BASELINE_GUARD_REQUIRED');
    requireProgramme(!automatic || preview.automaticFreshBaseline === true, 'TUYA_IPC_OWNED_BASELINE_REQUIRED');
    requireProgramme(!activeTarget || (isRecord(preview.activeTarget) && Object.keys(preview.activeTarget).length === 1
      && preview.activeTarget.timeZone === activeTarget.timeZone), 'TUYA_IPC_ACTIVE_TARGET_GUARD_REQUIRED');
    const received = copyProgramme(preview.programme, 4, {minC: 5, maxC: 40, stepC: 0.5});
    requireProgramme(JSON.stringify(received) === JSON.stringify(desired), 'TUYA_IPC_PREVIEW_PROGRAMME_MISMATCH');
    for (const [token, owner] of this.previews) {
      if (owner.expiresAt <= Date.now()) this.previews.delete(token);
    }
    while (this.previews.size >= 64) this.previews.delete(this.previews.keys().next().value!);
    this.previews.set(preview.token, {descriptor, deviceId, programme: received, expiresAt: preview.expiresAt, automatic,
      ...(activeTarget ? {activeTarget} : {})});
    return {token: preview.token, deviceId, programme: received, expiresAt: preview.expiresAt,
      changesRequired: preview.changesRequired, ...(activeTarget ? {activeTarget} : {})};
  }

  async apply(token: string, options: ProviderApplyOptions = {}): Promise<ProviderApplyResult> {
    const startedAt = Date.now();
    const owner = this.previews.get(token);
    this.previews.delete(token);
    if (!owner || owner.expiresAt <= Date.now()) {
      return {status: 'not-applied', reason: 'The FastWarm preview expired or was already used. Prepare it again.', writeAttempted: false};
    }
    if (options.signal?.aborted) {
      await this.discardOwner(token, owner).catch(() => undefined);
      return {status: 'not-applied', reason: 'The automatic selection was superseded before dispatch.', writeAttempted: false};
    }
    let descriptor: Descriptor;
    try {
      descriptor = await this.descriptor();
      if (descriptor.instanceId !== owner.descriptor.instanceId || descriptor.pid !== owner.descriptor.pid
        || descriptor.token !== owner.descriptor.token
        || (owner.automatic && descriptor.capabilities?.automaticFreshBaseline !== true)
        || (owner.activeTarget && descriptor.capabilities?.activeTargetAlignment !== true)) throw new Error('runtime changed');
    } catch {
      return {status: 'not-applied', reason: 'The FastWarm connection changed. Prepare a fresh preview.', writeAttempted: false};
    }
    if (options.signal?.aborted) {
      await this.discardOwner(token, owner).catch(() => undefined);
      return {status: 'not-applied', reason: 'The automatic selection was superseded before dispatch.', writeAttempted: false};
    }
    let cancellation: Promise<void> | undefined;
    let cancellationProvedNotApplied = false;
    const cancel = () => {
      // Older providers finish their already-submitted apply before the
      // controller prepares the latest selection. Never guess a cancel route.
      if (!cancellation && owner.automatic && descriptor.capabilities?.automaticCancellation === true) {
        cancellation = this.call(descriptor, '/provider/cancel-automatic', {token}, false)
          .then(body => {
            requireProgramme(typeof body.cancelled === 'boolean'
              && (body.notApplied === undefined || typeof body.notApplied === 'boolean')
              && (body.notApplied !== true || body.cancelled === true), 'TUYA_IPC_INVALID_CANCELLATION');
            cancellationProvedNotApplied = body.cancelled === true && body.notApplied === true;
          })
          .catch(() => undefined);
      }
    };
    options.signal?.addEventListener('abort', cancel, {once: true});
    try {
      const body = await this.call(descriptor, owner.automatic ? '/provider/apply-automatic' : '/provider/apply', {token}, true);
      requireProgramme(!owner.automatic || body.automaticFreshBaseline === true, 'TUYA_IPC_OWNED_BASELINE_REQUIRED');
      const result = body.result;
      requireProgramme(isRecord(result) && typeof result.status === 'string'
        && ['confirmed', 'conflict', 'not-applied', 'unconfirmed', 'unknown'].includes(result.status)
        && typeof result.reason === 'string' && result.reason.length <= 4096 && typeof result.writeAttempted === 'boolean',
      'TUYA_IPC_INVALID_APPLY_RESULT');
      requireProgramme(result.superseded === undefined || typeof result.superseded === 'boolean', 'TUYA_IPC_INVALID_SUPERSESSION');
      requireProgramme(result.superseded !== true || Boolean(owner.automatic && options.signal?.aborted
        && descriptor.capabilities?.automaticCancellation === true && result.status !== 'unknown' && result.status !== 'confirmed'),
      'TUYA_IPC_INVALID_SUPERSESSION');
      const readback = result.readback === undefined ? undefined : this.zone(result.readback);
      requireProgramme(!readback || readback.id === owner.deviceId, 'TUYA_IPC_ZONE_ID_MISMATCH');
      requireProgramme(result.status !== 'confirmed' || Boolean(readback?.online && readback.scheduled && readback.programme
        && JSON.stringify(readback.programme) === JSON.stringify(owner.programme)),
        'TUYA_IPC_CONFIRMATION_MISSING_READBACK');
      requireProgramme(result.status !== 'confirmed' || !owner.activeTarget || Boolean(readback
        && matchesFreshProgrammeTarget(readback, owner.programme, owner.activeTarget.timeZone, startedAt)),
      'TUYA_IPC_CONFIRMATION_MISSING_ACTIVE_TARGET');
      return {status: result.status as ProviderApplyResult['status'], reason: result.reason,
        writeAttempted: result.writeAttempted, ...(readback ? {readback} : {}), ...(result.superseded === true ? {superseded: true} : {})};
    } catch {
      // A cancellation RPC can overtake apply on another socket connection.
      // Only the provider's irreversible pre-claim cancellation proves no write;
      // cancelling an already claimed operation never provides this guarantee.
      await cancellation;
      if (cancellationProvedNotApplied && options.signal?.aborted) {
        return {status: 'not-applied', reason: 'The automatic selection was superseded before the provider claimed it.',
          writeAttempted: false, superseded: true};
      }
      return {status: 'unknown', reason: 'The FastWarm result could not be confirmed. Do not automatically retry.', writeAttempted: true};
    } finally {
      options.signal?.removeEventListener('abort', cancel);
      await cancellation;
    }
  }

  async discard(token: string): Promise<void> {
    const owner = this.previews.get(token); this.previews.delete(token);
    if (owner) await this.discardOwner(token, owner);
  }

  private async discardOwner(token: string, owner: PreparedOwner): Promise<void> {
    if (!owner?.automatic) return;
    const descriptor = await this.descriptor();
    if (descriptor.instanceId !== owner.descriptor.instanceId || descriptor.pid !== owner.descriptor.pid
      || descriptor.token !== owner.descriptor.token) return;
    const body = await this.call(descriptor, '/provider/discard', {token}, false);
    requireProgramme(body.discarded === true, 'TUYA_IPC_DISCARD_NOT_CONFIRMED');
  }

  private deviceId(id: string) {
    requireProgramme(typeof id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(id), 'TUYA_IPC_INVALID_DEVICE_ID');
  }

  private zone(value: unknown): HeatingZone {
    requireProgramme(isRecord(value), 'TUYA_IPC_INVALID_ZONE');
    this.deviceId(value.id as string);
    const finiteOrNull = (number: unknown) => number === null || (typeof number === 'number' && Number.isFinite(number));
    requireProgramme(typeof value.name === 'string' && value.name.length <= 256
      && (value.roomName === undefined || (typeof value.roomName === 'string' && value.roomName.length <= 256))
      && typeof value.online === 'boolean' && finiteOrNull(value.measuredC) && finiteOrNull(value.targetC)
      && typeof value.mode === 'string' && value.mode.length <= 64 && typeof value.scheduled === 'boolean'
      && typeof value.readAt === 'number' && Number.isSafeInteger(value.readAt) && value.readAt >= 0
      && typeof value.writeEnabled === 'boolean' && isRecord(value.limits)
      && value.limits.minC === 5 && value.limits.maxC === 40 && value.limits.stepC === 0.5
      && isRecord(value.periods) && value.periods.min === 4 && value.periods.max === 4,
    'TUYA_IPC_INVALID_ZONE');
    let programme: WeeklyProgramme | undefined;
    if (value.programme !== undefined || value.fingerprint !== undefined) {
      requireProgramme(typeof value.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(value.fingerprint),
        'TUYA_IPC_INVALID_ZONE_FINGERPRINT');
      programme = copyProgramme(value.programme, 4, {minC: 5, maxC: 40, stepC: 0.5});
      requireProgramme(Object.values(programme).every(periods => periods.length === 4), 'TUYA_FOUR_PERIODS_REQUIRED');
    }
    const result: HeatingZone = {
      id: value.id as string, name: value.name, online: value.online, measuredC: value.measuredC as number | null,
      targetC: value.targetC as number | null, mode: value.mode, scheduled: value.scheduled, readAt: value.readAt,
      writeEnabled: value.writeEnabled, limits: {minC: 5, maxC: 40, stepC: 0.5}, periods: {min: 4, max: 4},
      ...(value.roomName === undefined ? {} : {roomName: value.roomName as string}),
      ...(programme ? {programme, fingerprint: value.fingerprint as string} : {}),
    };
    if (value.programmeWriteMode !== undefined) {
      requireProgramme(typeof value.programmeWriteMode === 'string'
        && ['single-events', 'whole-days', 'grouped-events', 'grouped-days'].includes(value.programmeWriteMode),
      'TUYA_IPC_INVALID_WRITE_MODE');
      result.programmeWriteMode = value.programmeWriteMode as HeatingZone['programmeWriteMode'];
    }
    if (value.targetReadAt !== undefined) {
      requireProgramme(typeof value.targetReadAt === 'number' && Number.isSafeInteger(value.targetReadAt)
        && value.targetReadAt >= 0 && value.targetReadAt <= Date.now(), 'TUYA_IPC_INVALID_TARGET_OBSERVATION');
      result.targetReadAt = value.targetReadAt;
    }
    // Only forward actual accepted observations. A poll never invents a temperature timestamp.
    for (const key of ['temperatureReceivedAt', 'temperatureReportedAt'] as const) {
      if (value[key] !== undefined) {
        requireProgramme(typeof value[key] === 'number' && Number.isSafeInteger(value[key]) && value[key] >= 0,
          'TUYA_IPC_INVALID_OBSERVATION');
        Object.assign(result, {[key]: value[key]});
      }
    }
    if (value.temperatureSource !== undefined) {
      requireProgramme(typeof value.temperatureSource === 'string' && value.temperatureSource.length <= 64,
        'TUYA_IPC_INVALID_OBSERVATION');
      Object.assign(result, {temperatureSource: value.temperatureSource});
    }
    if (value.observations !== undefined) {
      requireProgramme(Array.isArray(value.observations) && value.observations.length <= 200, 'TUYA_IPC_INVALID_OBSERVATIONS');
      const observations = value.observations.map(point => {
        requireProgramme(isRecord(point) && Object.keys(point).every(key =>
          ['id', 'at', 'sourceAt', 'currentTemperature', 'targetTemperature', 'online', 'unit'].includes(key))
          && (point.id === undefined || (typeof point.id === 'string'
            && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(point.id)))
          && typeof point.at === 'number' && Number.isSafeInteger(point.at) && point.at > 0 && point.at <= Date.now() + 300_000
          && typeof point.online === 'boolean'
          && (point.sourceAt === undefined || (typeof point.sourceAt === 'number' && Number.isSafeInteger(point.sourceAt)
            && point.sourceAt > 0 && point.sourceAt <= point.at + 300_000))
          && (point.currentTemperature === undefined || (typeof point.currentTemperature === 'number'
            && Number.isFinite(point.currentTemperature) && point.currentTemperature >= 0 && point.currentTemperature <= 113))
          && (point.targetTemperature === undefined || (typeof point.targetTemperature === 'number'
            && Number.isFinite(point.targetTemperature) && point.targetTemperature >= 5 && point.targetTemperature <= 40))
          && (point.unit === undefined || point.unit === 'c' || point.unit === 'f'), 'TUYA_IPC_INVALID_OBSERVATION');
        return {at: point.at, online: point.online,
          ...(point.id === undefined ? {} : {id: point.id}),
          ...(point.sourceAt === undefined ? {} : {sourceAt: point.sourceAt}),
          ...(point.currentTemperature === undefined ? {} : {currentTemperature: point.currentTemperature}),
          ...(point.targetTemperature === undefined ? {} : {targetTemperature: point.targetTemperature}),
          ...(point.unit === undefined ? {} : {unit: point.unit})};
      });
      Object.assign(result, {observations});
    }
    return result;
  }

  private async descriptor(): Promise<Descriptor> {
    try {
      const persist = await realpath(join(this.options.storagePath, 'persist'));
      const directory = await stat(persist);
      if (!directory.isDirectory() || directory.mode & 0o022 || (process.getuid && directory.uid !== process.getuid())) {
        throw new Error('private directory required');
      }
      const runtimePath = join(dirname(persist), 'heating-runtime');
      const runtime = await lstat(runtimePath);
      if (!runtime.isDirectory() || runtime.isSymbolicLink() || runtime.mode & 0o077
        || (process.getuid && runtime.uid !== process.getuid())) throw new Error('private runtime directory required');
      const names = this.options.instanceId
        ? [`TuyaProgrammeProvider.${this.options.instanceId}.json`]
        : (await readdir(persist)).filter(name => /^TuyaProgrammeProvider\.[a-f0-9]{16}\.json$/.test(name));
      requireProgramme(names.length === 1, 'TUYA_IPC_CHOOSE_ONE_INSTANCE');
      const name = names[0]!;
      const file = await open(join(persist, name), constants.O_RDONLY | constants.O_NOFOLLOW);
      let value: unknown;
      try {
        const info = await file.stat();
        if (!info.isFile() || info.mode & 0o077 || info.size > 16_384 || (process.getuid && info.uid !== process.getuid())) {
          throw new Error('private descriptor required');
        }
        value = JSON.parse(await file.readFile('utf8'));
      } finally {
        await file.close();
      }
      requireProgramme(isRecord(value) && value.version === 1 && value.protocolVersion === 1
        && value.plugin === '@jdipper/homebridge-tuya' && typeof value.instanceId === 'string'
        && /^[a-f0-9]{16}$/.test(value.instanceId) && name === `TuyaProgrammeProvider.${value.instanceId}.json`
        && typeof value.pid === 'number' && Number.isSafeInteger(value.pid) && value.pid > 0
        && typeof value.token === 'string' && /^[a-f0-9]{64}$/.test(value.token)
        && value.socketPath === join(runtimePath, `tuya-programmes-${value.instanceId}.sock`)
        && (value.capabilities === undefined || (isRecord(value.capabilities)
          && (value.capabilities.automaticFreshBaseline === undefined || typeof value.capabilities.automaticFreshBaseline === 'boolean')
          && (value.capabilities.automaticCancellation === undefined || typeof value.capabilities.automaticCancellation === 'boolean')
          && (value.capabilities.activeTargetAlignment === undefined || typeof value.capabilities.activeTargetAlignment === 'boolean'))),
      'TUYA_IPC_INVALID_DESCRIPTOR');
      const descriptor = value as unknown as Descriptor;
      const socket = await lstat(descriptor.socketPath);
      if (!socket.isSocket() || socket.mode & 0o077 || (process.getuid && socket.uid !== process.getuid())) {
        throw new Error('private socket required');
      }
      process.kill(descriptor.pid, 0);
      return descriptor;
    } catch {
      throw new Error('The FastWarm programme connection is unavailable. Start its Tuya bridge and choose one instance.');
    }
  }

  private call(descriptor: Descriptor, route: string, payload: object, writing: boolean): Promise<Record<string, unknown>> {
    const encoded = JSON.stringify(payload);
    requireProgramme(Buffer.byteLength(encoded) <= 131_072, 'TUYA_IPC_REQUEST_TOO_LARGE');
    const timeoutMs = writing ? 10 * 60_000 : 60_000;
    return new Promise((resolve, reject) => {
      let finished = false;
      let deadline: NodeJS.Timeout | undefined;
      const fail = () => {
        if (finished) return;
        finished = true;
        if (deadline) clearTimeout(deadline);
        reject(new Error(writing ? 'TUYA_IPC_WRITE_OUTCOME_UNKNOWN' : 'TUYA_IPC_READ_FAILED'));
      };
      const req = request({socketPath: descriptor.socketPath, path: route, method: 'POST', headers: {
        authorization: `Bearer ${descriptor.token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(encoded),
      }}, response => {
        let length = 0;
        const chunks: Buffer[] = [];
        response.on('data', chunk => {
          length += chunk.length;
          if (length > 524_288) { response.destroy(); req.destroy(); fail(); }
          else chunks.push(Buffer.from(chunk));
        });
        response.on('error', fail);
        response.on('aborted', fail);
        response.on('end', () => {
          if (finished) return;
          try {
            const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            requireProgramme(response.statusCode === 200 && response.headers['content-type']?.includes('application/json')
              && isRecord(value) && value.protocolVersion === 1 && value.instanceId === descriptor.instanceId,
            'TUYA_IPC_RESPONSE_NOT_CONFIRMED');
            finished = true;
            if (deadline) clearTimeout(deadline);
            resolve(value);
          } catch { fail(); }
        });
      });
      deadline = setTimeout(() => { req.destroy(); fail(); }, timeoutMs);
      deadline.unref();
      req.setTimeout(timeoutMs, () => { req.destroy(); fail(); });
      req.on('error', fail);
      req.end(encoded);
    });
  }
}
