import {randomBytes} from 'node:crypto';
import {constants} from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

export async function writePrivateJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), {recursive: true, mode: 0o700});
  const temporary = `${file}.${randomBytes(16).toString('hex')}.tmp`;
  const handle = await fs.open(temporary, 'wx', 0o600);
  try {
    try { await handle.writeFile(JSON.stringify(value, null, 2) + '\n'); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, {force: true}); }
}

export async function readPrivateJson(file: string): Promise<unknown> {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.mode & 0o077 || info.size > 8 * 1024 * 1024
      || (process.getuid && info.uid !== process.getuid())) throw new Error('A private regular controller file is required.');
    return JSON.parse(await handle.readFile('utf8'));
  } finally { await handle.close(); }
}
