// Local device provider — an already-running emulator or physical device (the
// dev loop). Picks an existing adb target; tear-down is a no-op (we did not
// launch it, so we do not kill it).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Returns a usable Device, or null if none is connected. Never throws on "none". */
export async function find(opts = {}) {
  const serial = opts.serial ?? (await firstOnlineDevice());
  if (!serial) return null;
  return { serial, dispose: async () => {} };
}

export async function acquire(opts = {}) {
  const dev = await find(opts);
  if (!dev) throw new Error('No adb device found. Start an emulator or attach a device.');
  return dev;
}

/** First device in `adb devices` that is online (state `device`, not offline/unauthorized). */
async function firstOnlineDevice() {
  let stdout = '';
  try { ({ stdout } = await run('adb', ['devices'])); } catch { return null; }
  for (const line of stdout.split('\n').slice(1)) {
    const m = /^(\S+)\s+device$/.exec(line.trim());
    if (m) return m[1];
  }
  return null;
}
