import { readdir, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { paths } from './paths.js';
import { buildTool } from './sdk.js';

const run = promisify(execFile);

// Checksums are stored on the device so they survive inside the cached AVD userdata image.
const CHECKSUM_DIR = '/data/local/tmp/aap-checksums';

/**
 * Install every staged APK (.work/downloaded and .work/local override).
 * Skips a package only when the staged APK's SHA-256 matches the checksum
 * stored on the device after the previous install. This is the only reliable
 * signal: versionCode is manually bumped and almost never changes in debug builds.
 *
 * @param {string} [deviceSerial]
 * @param {{reinstall?: boolean}} [opts]
 */
export async function installAll(deviceSerial, opts = {}) {
  const adb = (args) =>
    run('adb', deviceSerial ? ['-s', deviceSerial, ...args] : args);

  for (const apk of await stagedApks()) {
    const { pkg } = await badging(apk);
    if (!opts.reinstall) {
      const staged = await apkChecksum(apk);
      const installed = await deviceChecksum(adb, pkg);
      if (installed === staged) {
        console.log(`skip ${pkg} (installed APK matches staged sha256)`);
        continue;
      }
      console.log(`${installed ? 'reinstall' : 'install'} ${pkg} <- ${path.basename(apk)}`);
    } else {
      console.log(`reinstall ${pkg} <- ${path.basename(apk)}`);
    }
    await installOne(adb, pkg, apk);
    await storeChecksum(adb, pkg, await apkChecksum(apk));
  }
}

/**
 * Install one APK. `-t` allows test-only APKs (locally-built `assembleDebug` outputs are marked
 * test-only). On a signing-key mismatch (e.g. a locally-built override vs the CI-downloaded
 * package), uninstall and retry.
 */
async function installOne(adb, pkg, apk) {
  try {
    await adb(['install', '-t', '-r', '-g', apk]);
  } catch (e) {
    const msg = String(e.stderr ?? e.message ?? e);
    if (/INSTALL_FAILED_UPDATE_INCOMPATIBLE|signatures do not match/i.test(msg)) {
      console.log(`  signature mismatch for ${pkg}; uninstalling and reinstalling`);
      try { await adb(['uninstall', pkg]); } catch { /* not installed / best-effort */ }
      await adb(['install', '-t', '-g', apk]);
    } else {
      throw e;
    }
  }
}

async function stagedApks() {
  // local overrides take precedence over downloaded (ARCHITECTURE.md §7).
  const dirs = [paths.local, paths.downloaded];
  const seen = new Map(); // basename -> full path
  for (const dir of dirs) {
    let names = [];
    try { names = await readdir(dir); } catch { /* dir may not exist yet */ }
    for (const n of names)
      if (n.endsWith('.apk') && !seen.has(n)) seen.set(n, path.join(dir, n));
  }
  return [...seen.values()];
}

/** Parse package name via `aapt dump badging` (falls back to aapt2). */
async function badging(apkPath) {
  const stdout = await dumpBadging(apkPath);
  const pkg = /package: name='([^']+)'/.exec(stdout)?.[1];
  if (!pkg) throw new Error(`Could not read package name from ${apkPath}.`);
  return { pkg };
}

async function dumpBadging(apkPath) {
  for (const tool of [buildTool('aapt2'), buildTool('aapt'), 'aapt2', 'aapt']) {
    try {
      const { stdout } = await run(tool, ['dump', 'badging', apkPath]);
      return stdout;
    } catch (e) {
      if (e.code === 'ENOENT') continue;
      throw e;
    }
  }
  throw new Error('Neither `aapt2` nor `aapt` found (SDK build-tools or PATH); needed to read APK metadata.');
}

async function apkChecksum(apkPath) {
  const data = await readFile(apkPath);
  return createHash('sha256').update(data).digest('hex');
}

/** Read the checksum stored on the device for `pkg`, or null if absent. */
async function deviceChecksum(adb, pkg) {
  try {
    const { stdout } = await adb(['shell', `cat ${CHECKSUM_DIR}/${pkg} 2>/dev/null`]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** Persist the checksum on the device so it survives in the cached AVD userdata. */
async function storeChecksum(adb, pkg, checksum) {
  // checksum is a hex string — no shell escaping concerns.
  await adb(['shell', `mkdir -p ${CHECKSUM_DIR} && echo ${checksum} > ${CHECKSUM_DIR}/${pkg}`]);
}
