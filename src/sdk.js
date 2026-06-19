// Android SDK location + tool resolution, shared by the device provider and the installer.
// Prefers env (ANDROID_SDK_ROOT/ANDROID_HOME), else the conventional per-OS install location.

import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function resolveSdk() {
  const fromEnv = process.env.ANDROID_SDK_ROOT || process.env.ANDROID_HOME;
  if (fromEnv) return fromEnv;
  const home = os.homedir();
  for (const p of [path.join(home, 'Library', 'Android', 'sdk'), path.join(home, 'Android', 'Sdk')])
    if (existsSync(p)) return p;
  return '';
}

export const SDK = resolveSdk();

/** Absolute path to a tool within the SDK (first candidate subpath that exists), else the bare name (PATH). */
export function sdkTool(name, ...candidateSubpaths) {
  for (const sp of candidateSubpaths) {
    const p = path.join(SDK, ...sp);
    if (SDK && existsSync(p)) return p;
  }
  return name;
}

/** Resolve a build-tools binary (e.g. aapt2) from the highest installed build-tools version, else the bare name. */
export function buildTool(name) {
  if (!SDK) return name;
  const dir = path.join(SDK, 'build-tools');
  if (!existsSync(dir)) return name;
  const versions = readdirSync(dir).sort();
  for (let i = versions.length - 1; i >= 0; i--) {
    const p = path.join(dir, versions[i], name);
    if (existsSync(p)) return p;
  }
  return name;
}
