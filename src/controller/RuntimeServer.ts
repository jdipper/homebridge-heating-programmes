import { createServer, IncomingMessage, Server, ServerResponse } from 'http';
import { randomBytes, timingSafeEqual } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import {readPrivateJson, writePrivateJson} from './PrivateFile';
import {lstatSync, unlinkSync} from 'node:fs';

export interface SharedRuntimeDescriptor {
  version: 1;
  instanceId: string;
  plugin: string;
  socketPath: string;
  token: string;
  pid: number;
  compatibility?: 'shared-read-only';
  ownerPlugin?: '@jdipper/homebridge-heating-programmes';
  readOnly?: true;
}

interface ServerOptions {
  descriptorName?: string; socketName?: string; ownerName?: string; plugin?: string;
  compatibility?: 'shared-read-only';
}

export type SharedRuntimeHandler = (route: string, body: Record<string, unknown>) => Promise<unknown>;

/** Private IPC for Homebridge's temporary UI server; it does not listen on the LAN. */
export default class RuntimeServer {
  private server?: Server;
  private descriptor?: SharedRuntimeDescriptor;
  private descriptorPath?: string;
  private ownerToken?: string;

  constructor(private persistPath: string, private instanceId: string, private handler: SharedRuntimeHandler,
    private options: ServerOptions = {}) {
    if (!/^[a-f0-9]{16}$/.test(instanceId)) {
      throw new Error('Invalid thermostat runtime instance ID.');
    }
    for (const name of [options.descriptorName, options.socketName, options.ownerName]) {
      if (name !== undefined && !/^[A-Za-z0-9_.-]{1,100}$/.test(name)) throw new Error('Invalid private heating endpoint name.');
    }
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }
    await fs.mkdir(this.persistPath, { recursive: true });
    this.persistPath = await fs.realpath(this.persistPath);
    const directory = await fs.lstat(this.persistPath);
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.mode & 0o022
      || (process.getuid && directory.uid !== process.getuid())) throw new Error('A private Homebridge persist directory is required.');
    // Homebridge's storage backend opens files in persist during child startup.
    // Unix sockets belong outside that scanned directory.
    const runtimePath = path.join(path.dirname(this.persistPath), 'heating-runtime');
    await fs.mkdir(runtimePath, {recursive: true, mode: 0o700});
    const runtimeDirectory = await fs.lstat(runtimePath);
    if (!runtimeDirectory.isDirectory() || runtimeDirectory.isSymbolicLink() || runtimeDirectory.mode & 0o077
      || (process.getuid && runtimeDirectory.uid !== process.getuid())) throw new Error('A private heating connection directory is required.');
    await this.acquireOwner();
    try {
    const descriptorPath = path.join(this.persistPath, this.options.descriptorName ?? 'HeatingProgrammesRuntime.json');
    try {
      const previous = await readPrivateJson(descriptorPath) as SharedRuntimeDescriptor;
      if (Number.isInteger(previous.pid) && previous.pid > 0) {
        try {
          process.kill(previous.pid, 0);
          throw new Error('A thermostat runtime with the same configuration is already running.');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
            throw error;
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) {
        throw error;
      }
    }

    const socketPath = process.platform === 'win32'
      ? `\\\\.\\pipe\\homebridge-heating-programmes`
      : path.join(runtimePath, this.options.socketName ?? 'heating-programmes.sock');
    // Keep the path supplied by the runtime local to its own persist directory.
    if (process.platform !== 'win32') {
      await fs.rm(socketPath, { force: true });
    }
    const descriptor: SharedRuntimeDescriptor = {
      version: 1, instanceId: this.instanceId, plugin: this.options.plugin ?? '@jdipper/homebridge-heating-programmes',
      socketPath, token: randomBytes(32).toString('hex'), pid: process.pid,
      ...(this.options.compatibility ? {compatibility: this.options.compatibility} : {}),
      ...(this.options.compatibility ? {ownerPlugin: '@jdipper/homebridge-heating-programmes' as const, readOnly: true as const} : {}),
    };
    const server = createServer((request, response) => {
      void this.onRequest(request, response, descriptor.token);
    });
    server.requestTimeout = 120_000;
    server.headersTimeout = 10_000;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(socketPath, () => {
        server.removeListener('error', reject); resolve();
      });
    });
    this.server = server;
    this.descriptor = descriptor;
    this.descriptorPath = descriptorPath;
    try {
      if (process.platform !== 'win32') {
        await fs.chmod(socketPath, 0o600);
      }
      await writePrivateJson(descriptorPath, descriptor);
    } catch (error) {
      await this.close();
      throw error;
    }
    } catch (error) {await this.releaseOwner(); throw error;}
  }

  private async acquireOwner(): Promise<void> {
    const file = path.join(this.persistPath, this.options.ownerName ?? 'HeatingProgrammesOwner.json');
    const token = randomBytes(32).toString('hex');
    try {
      const handle = await fs.open(file, 'wx', 0o600);
      try {await handle.writeFile(JSON.stringify({pid: process.pid, token})); await handle.sync();}
      finally {await handle.close();}
      this.ownerToken = token;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const before = await fs.lstat(file);
      const previous = await readPrivateJson(file) as {pid?: number};
      if (!Number.isSafeInteger(previous.pid) || previous.pid! <= 0) throw new Error('The heating owner lock needs review.');
      try {process.kill(previous.pid!, 0); throw new Error('Another shared heating controller is already running.');}
      catch (failure) {if ((failure as NodeJS.ErrnoException).code !== 'ESRCH') throw failure;}
      // Do not remove a replacement lock after another process has taken ownership.
      const current = lstatSync(file);
      if (current.ino !== before.ino || current.mtimeMs !== before.mtimeMs) throw new Error('Heating ownership changed. Retry startup.');
      unlinkSync(file);
      const handle = await fs.open(file, 'wx', 0o600);
      try {await handle.writeFile(JSON.stringify({pid: process.pid, token})); await handle.sync();}
      finally {await handle.close();}
      this.ownerToken = token;
    }
  }
  private async releaseOwner(): Promise<void> {
    if (!this.ownerToken) return;
    const file = path.join(this.persistPath, this.options.ownerName ?? 'HeatingProgrammesOwner.json');
    try {
      const current = await readPrivateJson(file) as {token?: string};
      if (current.token === this.ownerToken) await fs.rm(file);
    } catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;}
    this.ownerToken = undefined;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    if (this.descriptorPath && this.descriptor) {
      try {
        const current = JSON.parse(await fs.readFile(this.descriptorPath, 'utf8')) as SharedRuntimeDescriptor;
        if (current.token === this.descriptor.token) {
          await fs.rm(this.descriptorPath, { force: true });
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw error;
        }
      }
      if (process.platform !== 'win32') {
        await fs.rm(this.descriptor.socketPath, { force: true });
      }
    }
    this.descriptor = undefined;
    await this.releaseOwner();
  }

  private async onRequest(request: IncomingMessage, response: ServerResponse, token: string): Promise<void> {
    const reply = (status: number, body: unknown) => {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(body));
    };
    const authorization = request.headers.authorization ?? '';
    const expected = Buffer.from(`Bearer ${token}`);
    const received = Buffer.from(authorization);
    if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
      request.resume();
      reply(403, { error: 'Thermostat runtime access denied.' });
      return;
    }
    if (request.method !== 'POST' || !request.url || !/^\/[a-z/]+$/.test(request.url)) {
      request.resume();
      reply(405, { error: 'Use a supported thermostat operation.' });
      return;
    }
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 256 * 1024) {
          reply(413, { error: 'Thermostat request is too large.' });
          return;
        }
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        throw new Error('Thermostat request must be an object.');
      }
      reply(200, await this.handler(request.url, body));
    } catch (error) {
      if (!response.headersSent) {
        reply(400, { error: error instanceof Error ? error.message : 'Thermostat operation failed.' });
      }
    }
  }
}
