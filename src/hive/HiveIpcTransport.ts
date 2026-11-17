import { constants } from 'node:fs';
import { open, lstat, realpath, stat } from 'node:fs/promises';
import { request } from 'node:http';
import { dirname, join } from 'node:path';

import {
  HiveProduct,
  HiveProgrammeTransport,
  HiveScheduleCommand,
  HiveTransportError,
  HiveWriteAcknowledgement,
  HiveZoneType,
} from './HiveProgrammeAdapter';

// Keep the existing provider usable while installations move to the scoped fork.
// These package identities do not relax any of the private runtime checks below.
const HIVE_PROVIDER_PLUGINS = ['homebridge-hivehome-control', '@jdipper/homebridge-hivehome-control'] as const;
type HiveProviderPlugin = typeof HIVE_PROVIDER_PLUGINS[number];

interface RuntimeDescriptor {
  version: 1;
  protocolVersion: 1;
  plugin: HiveProviderPlugin;
  instanceId: string;
  pid: number;
  socketPath: string;
  token: string;
  capabilities: {
    read: true;
    write: boolean;
    enrolledZoneIds: string[];
    freshWritePreconditions?: boolean;
  };
}

interface RuntimeReply {
  protocolVersion: 1;
  instanceId: string;
  products?: HiveProduct[];
  outcome?: 'acknowledged' | 'unknown' | 'rejected';
  httpStatus?: number;
  response?: unknown;
  errorCode?: string;
  writeAttempted?: boolean;
}

export interface HiveIpcTransportOptions {
  /** Homebridge's storage directory. Credentials are never read by this client. */
  storagePath: string;
  timeoutMs?: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hiveProviderPlugin(value: unknown): value is HiveProviderPlugin {
  return HIVE_PROVIDER_PLUGINS.some(plugin => plugin === value);
}

/** Versioned private connection to the vendor plugin's existing Hive session. */
export class HiveIpcTransport implements HiveProgrammeTransport {
  private readonly storagePath: string;
  private readonly timeoutMs: number;

  constructor(options: HiveIpcTransportOptions) {
    this.storagePath = options.storagePath;
    this.timeoutMs = options.timeoutMs ?? 45_000;
    if (!this.storagePath || !Number.isInteger(this.timeoutMs) || this.timeoutMs < 100 || this.timeoutMs > 60_000) {
      throw new HiveTransportError('HIVE_IPC_OPTIONS_INVALID', 'not-sent');
    }
  }

  async getCapabilities(): Promise<Readonly<RuntimeDescriptor['capabilities']>> {
    const descriptor = await this.readDescriptor();
    return { ...descriptor.capabilities, enrolledZoneIds: [...descriptor.capabilities.enrolledZoneIds] };
  }

  async supportsFreshWritePreconditions(): Promise<boolean> {
    return (await this.readDescriptor()).capabilities.freshWritePreconditions === true;
  }

  async readProducts(): Promise<readonly HiveProduct[]> {
    const descriptor = await this.readDescriptor();
    const { status, body } = await this.call(descriptor, '/products/read', {}, false);
    if (status !== 200 || !Array.isArray(body.products) || body.products.some(product =>
      !record(product) || typeof product.id !== 'string' || !['heating', 'trvcontrol'].includes(product.type))) {
      throw new HiveTransportError('HIVE_IPC_READ_NOT_CONFIRMED', 'not-sent');
    }
    return body.products;
  }

  async writeSchedule(
    zone: { readonly id: string; readonly type: HiveZoneType },
    command: HiveScheduleCommand,
    options: {readonly signal?: AbortSignal} = {},
  ): Promise<HiveWriteAcknowledgement> {
    if (options.signal?.aborted) throw new HiveTransportError('HIVE_PROGRAMME_SUPERSEDED', 'not-sent');
    const descriptor = await this.readDescriptor();
    if (!descriptor.capabilities.write || !descriptor.capabilities.enrolledZoneIds.includes(zone.id)) {
      throw new HiveTransportError('HIVE_PROGRAMME_WRITES_NOT_ENABLED', 'not-sent');
    }
    if (command.requireFreshPreconditions === true && descriptor.capabilities.freshWritePreconditions !== true) {
      throw new HiveTransportError('HIVE_FRESH_WRITE_GUARD_UNAVAILABLE', 'not-sent');
    }
    if (!Number.isSafeInteger(command.expiresAt) || command.expiresAt <= Date.now()) {
      throw new HiveTransportError('HIVE_PROGRAMME_PREVIEW_EXPIRED', 'not-sent');
    }
    if (options.signal?.aborted) throw new HiveTransportError('HIVE_PROGRAMME_SUPERSEDED', 'not-sent');
    const { status, body } = await this.call(descriptor, '/schedules/write', {
      deviceId: zone.id,
      type: zone.type,
      schedule: command.schedule,
      preconditions: command.preconditions,
      ...(command.requireFreshPreconditions === true ? {requireFreshPreconditions: true} : {}),
    }, true, command.expiresAt);
    if (body.outcome === 'rejected' && body.writeAttempted === false) {
      throw new HiveTransportError('HIVE_PROGRAMME_WRITE_REJECTED', 'not-sent');
    }
    if (status !== 200 || body.outcome !== 'acknowledged' || body.writeAttempted !== true ||
        !Number.isInteger(body.httpStatus) || (body.httpStatus as number) < 100 || (body.httpStatus as number) > 599) {
      throw new HiveTransportError('HIVE_PROGRAMME_WRITE_OUTCOME_UNKNOWN', 'unknown');
    }
    return { status: body.httpStatus as number, body: body.response };
  }

  private async readDescriptor(): Promise<RuntimeDescriptor> {
    try {
      const persist = await realpath(join(this.storagePath, 'persist'));
      const directory = await stat(persist);
      if (!directory.isDirectory() || directory.mode & 0o022 ||
          (process.getuid && directory.uid !== process.getuid())) {
        throw new Error('private directory required');
      }
      const runtimePath = join(dirname(persist), 'heating-runtime');
      const runtime = await lstat(runtimePath);
      if (!runtime.isDirectory() || runtime.isSymbolicLink() || runtime.mode & 0o077
        || (process.getuid && runtime.uid !== process.getuid())) throw new Error('private runtime directory required');
      const descriptorFile = await open(join(persist, 'hive-programmes-runtime.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
      let data: unknown;
      try {
        const info = await descriptorFile.stat();
        if (!info.isFile() || info.mode & 0o077 || info.size > 16_384 ||
            (process.getuid && info.uid !== process.getuid())) {
          throw new Error('private descriptor required');
        }
        data = JSON.parse(await descriptorFile.readFile('utf8'));
      } finally {
        await descriptorFile.close();
      }
      if (!record(data) || data.version !== 1 || data.protocolVersion !== 1 || !hiveProviderPlugin(data.plugin) ||
          !Number.isSafeInteger(data.pid) || (data.pid as number) <= 0 ||
          typeof data.instanceId !== 'string' || !/^[a-f0-9]{32}$/.test(data.instanceId) ||
          typeof data.token !== 'string' || !/^[a-f0-9]{64}$/.test(data.token) ||
          data.socketPath !== join(runtimePath, `hive-programmes-${data.pid}.sock`) ||
          !record(data.capabilities) || data.capabilities.read !== true || typeof data.capabilities.write !== 'boolean' ||
          (data.capabilities.freshWritePreconditions !== undefined && typeof data.capabilities.freshWritePreconditions !== 'boolean') ||
          !Array.isArray(data.capabilities.enrolledZoneIds) || data.capabilities.enrolledZoneIds.length > 256 ||
          data.capabilities.enrolledZoneIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id))) {
        throw new Error('valid runtime identity required');
      }
      const descriptor = data as unknown as RuntimeDescriptor;
      const socket = await lstat(descriptor.socketPath);
      if (!socket.isSocket() || socket.mode & 0o077 || (process.getuid && socket.uid !== process.getuid())) {
        throw new Error('private socket required');
      }
      process.kill(descriptor.pid, 0);
      return descriptor;
    } catch {
      throw new HiveTransportError('HIVE_IPC_RUNTIME_UNAVAILABLE', 'not-sent');
    }
  }

  private call(
    descriptor: RuntimeDescriptor,
    route: '/products/read' | '/schedules/write',
    payload: unknown,
    writing: boolean,
    expiresAt?: number,
  ): Promise<{ status: number; body: RuntimeReply }> {
    const encoded = JSON.stringify(payload);
    if (Buffer.byteLength(encoded) > 131_072) {
      throw new HiveTransportError('HIVE_IPC_REQUEST_TOO_LARGE', 'not-sent');
    }
    return new Promise((resolve, reject) => {
      let finished = false;
      let deadline: NodeJS.Timeout | undefined;
      const fail = (): void => {
        if (finished) return;
        finished = true;
        if (deadline) clearTimeout(deadline);
        reject(new HiveTransportError('HIVE_IPC_REQUEST_FAILED', writing ? 'unknown' : 'not-sent'));
      };
      const req = request({
        socketPath: descriptor.socketPath,
        path: route,
        method: 'POST',
        headers: {
          authorization: `Bearer ${descriptor.token}`,
          'x-hive-programmes-instance': descriptor.instanceId,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(encoded),
          ...(expiresAt === undefined ? {} : { 'x-hive-programmes-expires-at': String(expiresAt) }),
        },
      }, response => {
        const chunks: Buffer[] = [];
        let length = 0;
        response.on('data', chunk => {
          length += chunk.length;
          if (length > 524_288) {
            response.destroy();
            req.destroy();
            fail();
          } else chunks.push(Buffer.from(chunk));
        });
        response.on('error', fail);
        response.on('aborted', fail);
        response.on('end', () => {
          if (finished) return;
          try {
            if (!response.headers['content-type']?.toLowerCase().includes('application/json')) throw new Error('JSON response required');
            const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (!record(body) || body.protocolVersion !== 1 || body.instanceId !== descriptor.instanceId) {
              throw new Error('runtime identity mismatch');
            }
            finished = true;
            if (deadline) clearTimeout(deadline);
            resolve({ status: response.statusCode ?? 0, body: body as unknown as RuntimeReply });
          } catch { fail(); }
        });
      });
      deadline = setTimeout(() => { req.destroy(); fail(); }, this.timeoutMs);
      deadline.unref();
      req.setTimeout(this.timeoutMs, () => { req.destroy(); fail(); });
      req.on('error', fail);
      req.end(encoded);
    });
  }
}
