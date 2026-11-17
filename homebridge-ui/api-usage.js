'use strict';

const fs = require('node:fs/promises');
const {constants} = require('node:fs');
const path = require('node:path');

const CATEGORIES = ['authentication', 'messaging', 'temperature', 'programme', 'read', 'control', 'other'];
const owned = stat => (!process.getuid || stat.uid === process.getuid()) && (stat.mode & 0o077) === 0;

/** Read local counters only. This endpoint never contacts either heating service. */
async function readApiUsage(storagePath, now = Date.now()) {
  try {
    const persist = await fs.realpath(path.join(storagePath, 'persist'));
    const directory = await fs.stat(persist);
    if (!directory.isDirectory() || (directory.mode & 0o022) || (process.getuid && directory.uid !== process.getuid())) return {records: []};
    const files = (await fs.readdir(persist)).filter(file => /^TuyaApiUsage\.[a-f0-9]{16}\.json$/.test(file)).slice(0, 64);
    const records = [];
    for (const file of files) {
      let handle;
      try {
        handle = await fs.open(path.join(persist, file), constants.O_RDONLY | constants.O_NOFOLLOW);
        const stat = await handle.stat();
        if (!stat.isFile() || !owned(stat) || stat.size > 8192) continue;
        const value = JSON.parse(await handle.readFile('utf8'));
        const first = Date.parse(value.observedSince), last = Date.parse(value.updatedAt);
        if (value.version !== 1 || value.scope !== 'this-plugin-instance' || value.measure !== 'http-attempts-not-billing'
          || file !== `TuyaApiUsage.${value.instanceId}.json` || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value.month)
          || !Number.isSafeInteger(value.attempts) || value.attempts < 0 || !value.byCategory
          || Object.keys(value.byCategory).sort().join(',') !== [...CATEGORIES].sort().join(',')
          || !CATEGORIES.every(key => Number.isSafeInteger(value.byCategory[key]) && value.byCategory[key] >= 0)
          || CATEGORIES.reduce((sum, key) => sum + value.byCategory[key], 0) !== value.attempts
          || !Number.isFinite(first) || !Number.isFinite(last) || last < first || last > now + 300000
          || value.observedSince.slice(0, 7) !== value.month || value.updatedAt.slice(0, 7) !== value.month) continue;
        // Deliberately forward no filename, instance ID, URL or arbitrary file field.
        records.push({month: value.month, observedSince: value.observedSince, updatedAt: value.updatedAt,
          attempts: value.attempts, byCategory: Object.fromEntries(CATEGORIES.map(key => [key, value.byCategory[key]]))});
      } catch { /* An absent or invalid diagnostic file does not affect heating. */ }
      finally { await handle?.close(); }
    }
    records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return {records};
  } catch { return {records: []}; }
}

module.exports = {readApiUsage};
