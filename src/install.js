// adb install of staged APKs, skipping when the device already has a matching
// versionCode (ARCHITECTURE.md §6, §7). Package name + versionCode are derived
// from the APK (aapt/badging) — never authored by hand.
//
// DRAFT: shells out to `adb` / `aapt`; assumes both are on PATH.

import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { paths } from './paths.js';
import { buildTool } from './sdk.js';

const run = promisify(execFile);

/**
 * Install every staged APK (.work/downloaded and .work/local override).
 * @param {string} [deviceSerial]
 * @param {{reinstall?: boolean}} [opts]
 *   reinstall=false (default): skip a package that is already installed.
 *   reinstall=true:            force `install -r` for every package.
 */
export async function installAll(deviceSerial, opts = {}) {
  const adb = (args) =>
    run('adb', deviceSerial ? ['-s', deviceSerial, ...args] : args);

  for (const apk of await stagedApks()) {
    const { pkg } = await badging(apk);
    if (!opts.reinstall && (await isInstalled(adb, pkg))) {
      console.log(`skip ${pkg} (already installed; pass --reinstall to force)`);
      continue;
    }
    console.log(`${opts.reinstall ? 'reinstall' : 'install'} ${pkg} <- ${path.basename(apk)}`);
    await installOne(adb, pkg, apk);
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

/** Parse package + versionCode via `aapt dump badging` (falls back to aapt2). */
async function badging(apkPath) {
  const stdout = await dumpBadging(apkPath);
  const pkg = /package: name='([^']+)'/.exec(stdout)?.[1];
  const versionCode = /versionCode='([^']+)'/.exec(stdout)?.[1];
  if (!pkg) throw new Error(`Could not read package name from ${apkPath}.`);
  return { pkg, versionCode: versionCode ?? null };
}

async function dumpBadging(apkPath) {
  // Prefer SDK build-tools (env may not put them on PATH), then fall back to PATH.
  for (const tool of [buildTool('aapt2'), buildTool('aapt'), 'aapt2', 'aapt']) {
    try {
      const { stdout } = await run(tool, ['dump', 'badging', apkPath]);
      return stdout;
    } catch (e) {
      if (e.code === 'ENOENT') continue; // tool not found here; try the next
      throw e;
    }
  }
  throw new Error('Neither `aapt2` nor `aapt` found (SDK build-tools or PATH); needed to read APK metadata.');
}

/** Whether `pkg` is installed on the device (exact package-name match). */
async function isInstalled(adb, pkg) {
  try {
    const { stdout } = await adb(['shell', 'pm', 'list', 'packages', pkg]);
    return stdout.split('\n').some((l) => l.trim() === `package:${pkg}`);
  } catch {
    return false;
  }
}
