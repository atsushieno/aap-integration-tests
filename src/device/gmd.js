// GMD provider — the chosen path on GitHub Actions, set up at build time
// (ARCHITECTURE.md §8). Ordering policy (see ./auto.js): if no GMD setup exists,
// create one, then launch it and hand its adb serial to the runner.
//
// NOTE on naming: "GMD" (Gradle Managed Devices) strictly means AVDs whose
// lifecycle Gradle owns while it runs the instrumented test task. Our runner is
// adb-target-centric (ARCHITECTURE.md §8: "anything adb can connect to"), so
// here we manage the emulator/AVD lifecycle ourselves and expose an adb serial.
// If we later prefer Gradle to own the device for path-A instrumented runs, that
// becomes a separate execution mode rather than a device provider.
//
// KNOWN RISK: aap-core's build.yml has GMD tests disabled because the emulator
// snapshot failed on hosted runners. This lifecycle must be validated there.

import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { sdkTool } from '../sdk.js';

const run = promisify(execFile);

// Default to a system image matching the host arch (arm64 hosts can't run x86_64 AVDs well).
const DEFAULT_IMAGE = process.arch === 'arm64'
  ? 'system-images;android-35;google_apis;arm64-v8a'
  : 'system-images;android-35;google_apis;x86_64';

const ADB = () => sdkTool('adb', ['platform-tools', 'adb']);
const EMULATOR = () => sdkTool('emulator', ['emulator', 'emulator']);
const AVDMANAGER = () =>
  sdkTool('avdmanager', ['cmdline-tools', 'latest', 'bin', 'avdmanager'], ['tools', 'bin', 'avdmanager']);

export async function acquire(opts = {}) {
  const cfg = {
    avdName: opts.avdName || process.env.AAP_ITEST_AVD || 'aap_itest',
    image: opts.systemImage || process.env.AAP_ITEST_IMAGE || DEFAULT_IMAGE,
    deviceProfile: opts.deviceProfile || 'pixel_5',
    headless: opts.headless ?? true,
    bootTimeoutMs: opts.bootTimeoutMs ?? 300_000,
  };

  await ensureAvd(cfg);
  const port = await freeEmulatorPort();
  const serial = `emulator-${port}`;
  const proc = launchEmulator(cfg, port);

  try {
    await waitForBoot(serial, cfg.bootTimeoutMs);
  } catch (e) {
    try { await run(ADB(), ['-s', serial, 'emu', 'kill']); } catch {}
    throw e;
  }

  return {
    serial,
    dispose: async () => {
      try { await run(ADB(), ['-s', serial, 'emu', 'kill']); } catch {}
      try { proc.kill(); } catch {}
    },
  };
}

async function ensureAvd(cfg) {
  const have = await listAvds();
  if (have.includes(cfg.avdName)) return;
  console.log(`gmd: creating AVD "${cfg.avdName}" (${cfg.image})`);
  await createAvd(cfg);
}

async function listAvds() {
  try {
    const { stdout } = await run(EMULATOR(), ['-list-avds']);
    return stdout.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function createAvd(cfg) {
  // `avdmanager create avd` prompts to create a custom hardware profile; decline
  // with "no" on stdin. Requires the system image to be installed already
  // (sdkmanager) — surface a clear hint if it is missing.
  return new Promise((resolve, reject) => {
    const p = spawn(AVDMANAGER(), [
      'create', 'avd', '-n', cfg.avdName, '-k', cfg.image, '-d', cfg.deviceProfile, '--force',
    ]);
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.stdin.write('no\n');
    p.stdin.end();
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(
            `avdmanager create failed (${code}). Is the system image installed? ` +
              `Try: sdkmanager "${cfg.image}". ${err.trim()}`)));
  });
}

function launchEmulator(cfg, port) {
  const args = [
    '-avd', cfg.avdName, '-port', String(port),
    '-no-snapshot', '-no-boot-anim', '-no-audio', '-gpu', 'swiftshader_indirect',
  ];
  if (cfg.headless) args.push('-no-window');
  console.log(`gmd: launching ${EMULATOR()} ${args.join(' ')}`);
  const p = spawn(EMULATOR(), args, { detached: false, stdio: 'ignore' });
  p.on('error', (e) => console.error(`gmd: emulator spawn error: ${e.message}`));
  return p;
}

/** Pick the lowest free even emulator port (5554, 5556, ...) not already taken. */
async function freeEmulatorPort() {
  let used = [];
  try {
    const { stdout } = await run(ADB(), ['devices']);
    used = [...stdout.matchAll(/emulator-(\d+)/g)].map((m) => Number(m[1]));
  } catch {}
  for (let port = 5554; port <= 5680; port += 2)
    if (!used.includes(port)) return port;
  throw new Error('No free emulator port in 5554..5680.');
}

async function waitForBoot(serial, timeoutMs) {
  await run(ADB(), ['-s', serial, 'wait-for-device']);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const { stdout } = await run(ADB(), ['-s', serial, 'shell', 'getprop', 'sys.boot_completed']);
      if (stdout.trim() === '1') {
        console.log(`gmd: ${serial} booted`);
        return;
      }
    } catch { /* device still coming up */ }
    await delay(2000);
  }
  throw new Error(`Timed out waiting for ${serial} to boot (${timeoutMs} ms).`);
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
