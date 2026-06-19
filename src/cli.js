#!/usr/bin/env node
// Entry point for the host-managed test runner (ARCHITECTURE.md §6). Wires the
// pipeline: catalog -> acquire -> install -> run -> verify.

import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { loadCatalog } from './catalog.js';
import { acquire } from './acquire.js';
import { installAll } from './install.js';
import { acquireDevice } from './device/index.js';
import { runConnectivity } from './run.js';
import { repoRoot } from './paths.js';

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('case', { type: 'string', describe: 'test case under tests/cases/ (e.g. connectivity-mda)' })
    .option('catalog', { type: 'string', describe: 'catalog name; defaults to the case\'s catalog' })
    .option('device', { type: 'string', default: 'auto', choices: ['auto', 'local', 'gmd', 'firebase'],
      describe: 'auto = existing target -> Firebase (if there) -> GMD' })
    .option('serial', { type: 'string', describe: 'adb serial (local/auto provider)' })
    .option('token', { type: 'string',
      describe: 'GitHub PAT (artifact-read) for downloads; defaults to $GITHUB_TOKEN. Do not commit it.' })
    .option('host-apk', { type: 'string',
      describe: 'path to a locally-built host APK (with the JS controller) to install before running; ' +
        'transitional until plugin APKs ship compose-app+controller and self-host' })
    .option('reinstall', { type: 'boolean', default: false,
      describe: 'force reinstall every package (default: skip if already installed)' })
    .option('skip-acquire', { type: 'boolean', default: false,
      describe: 'skip downloading APKs (run against what is already installed)' })
    .option('skip-install', { type: 'boolean', default: false,
      describe: 'skip adb install entirely' })
    .check((a) => {
      if (!a.case && !a.catalog) throw new Error('Provide --case or --catalog.');
      return true;
    })
    .strict()
    .parse();

  const testCase = argv.case ? await loadCase(argv.case) : null;
  const catalogName = argv.catalog ?? testCase?.catalog;

  if (argv.skipAcquire) {
    console.log('[1-2/5] skip catalog/acquire (running against installed apps)');
  } else {
    if (!catalogName) throw new Error('No catalog: pass --catalog, use a --case that names one, or --skip-acquire.');
    console.log(`[1/5] load catalog: ${catalogName}`);
    const catalog = await loadCatalog(catalogName);
    console.log(`[2/5] acquire ${catalog.entries.length} entr(y/ies)`);
    await acquire(catalog, { token: argv.token });
  }

  console.log(`[3/5] acquire device: ${argv.device}`);
  const device = await acquireDevice(argv.device, { serial: argv.serial });

  try {
    if (argv.skipInstall) {
      console.log('[4/5] skip install');
    } else {
      console.log(`[4/5] install APKs${argv.reinstall ? ' (force reinstall)' : ''}`);
      await installAll(device.serial, { reinstall: argv.reinstall });
    }

    if (argv.hostApk) {
      console.log(`[4b] install host APK: ${argv.hostApk}`);
      await installApk(device.serial, argv.hostApk);
    }

    console.log('[5/5] run');
    if (!testCase) {
      console.warn('  no --case given; setup complete, nothing to run.');
      return;
    }
    await runCase(device.serial, testCase);
  } finally {
    await device.dispose();
  }
}

const run = promisify(execFile);
async function installApk(serial, apkPath) {
  const args = serial ? ['-s', serial] : [];
  await run('adb', [...args, 'install', '-r', '-g', apkPath]);
}

async function loadCase(name) {
  const file = path.join(repoRoot, 'tests', 'cases', `${name}.json`);
  return JSON.parse(await readFile(file, 'utf8'));
}

async function runCase(serial, c) {
  switch (c.type) {
    case 'connectivity': {
      const results = await runConnectivity(serial, c);
      const failed = results.filter((r) => !r.ok);
      console.log(`connectivity: ${results.length - failed.length}/${results.length} passed`);
      if (failed.length) process.exitCode = 1;
      break;
    }
    // TODO: 'render' case type -> our offline renderer + verify.js golden compare.
    default:
      throw new Error(`Unknown case type: ${c.type}`);
  }
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
