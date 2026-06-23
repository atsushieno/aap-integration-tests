#!/usr/bin/env node
// Entry point for the host-managed test runner (ARCHITECTURE.md §6). Wires the
// pipeline: catalog -> acquire -> install -> run -> verify.

import { mkdir, readFile, rm } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { loadCatalog } from './catalog.js';
import { acquire } from './acquire.js';
import { installAll } from './install.js';
import { acquireDevice } from './device/index.js';
import { runByodPresetOutput, runConnectivity, runInspect, runPreset, runUapmdAapUiRouting, runUapmdProject, runUapmdLoadProject } from './run.js';
import { paths, repoRoot } from './paths.js';
import { defaultSuiteName, listSuites, loadSuite } from './suite.js';

async function main() {
  const argv = yargs(hideBin(process.argv))
    .option('case', { type: 'string', default: npmConfigString('case'),
      describe: 'test case under tests/cases/ (e.g. connectivity-mda)' })
    .option('suite', { type: 'string',
      default: npmConfigString('suite'),
      describe: `suite to run (${listSuites().join('|')}); defaults to ${defaultSuiteName} when no --case/--catalog is given` })
    .option('catalog', { type: 'string', default: npmConfigString('catalog'),
      describe: 'catalog name; defaults to the case\'s catalog' })
    .option('device', { type: 'string', default: npmConfigString('device') ?? 'auto', choices: ['auto', 'local', 'gmd', 'firebase'],
      describe: 'auto = existing target -> Firebase (if there) -> GMD' })
    .option('serial', { type: 'string', default: npmConfigString('serial'),
      describe: 'adb serial (local/auto provider)' })
    .option('token', { type: 'string',
      describe: 'GitHub PAT (artifact-read) for downloads; defaults to $GITHUB_TOKEN. Do not commit it.' })
    .option('host-apk', { type: 'string', default: npmConfigString('host-apk'),
      describe: 'path to a locally-built host APK (with the JS controller) to install before running; ' +
        'transitional until plugin APKs ship compose-app+controller and self-host' })
    .option('reinstall', { type: 'boolean', default: npmConfigBoolean('reinstall'),
      describe: 'force reinstall every package (default: skip if already installed)' })
    .option('skip-acquire', { type: 'boolean', default: npmConfigBoolean('skip-acquire'),
      describe: 'skip downloading APKs (run against what is already installed)' })
    .option('skip-install', { type: 'boolean', default: npmConfigBoolean('skip-install'),
      describe: 'skip adb install entirely' })
    .check((a) => {
      if (a.case && a.suite) throw new Error('Pass either --case or --suite, not both.');
      return true;
    })
    .strict()
    .parse();

  const plan = await loadRunPlan(argv);

  if (argv.skipAcquire) {
    console.log('[1-2/5] skip catalog/acquire (running against installed apps)');
  } else {
    if (!plan.catalogNames.length) throw new Error('No catalog: pass --catalog, use a --case/--suite that names one, or --skip-acquire.');
    await resetDownloadedApks();
    for (const catalogName of plan.catalogNames) {
      console.log(`[1/5] load catalog: ${catalogName}`);
      const catalog = await loadCatalog(catalogName);
      console.log(`[2/5] acquire ${catalog.entries.length} entr(y/ies) from ${catalogName}`);
      await acquire(catalog, { token: argv.token });
    }
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
    if (!plan.runs.length) {
      console.warn('  no --case given; setup complete, nothing to run.');
      return;
    }
    const results = [];
    for (const item of plan.runs) {
      console.log(`\n=== ${item.name} (catalog: ${item.catalogName ?? 'skipped'}) ===`);
      try {
        const result = await runCase(device.serial, item.testCase);
        results.push({ name: item.name, ...result });
      } catch (e) {
        const error = String(e.message ?? e);
        console.error(`ERROR ${item.name} — ${error}`);
        results.push({ name: item.name, ok: false, error });
      }
    }
    summarize(results);
  } finally {
    await device.dispose();
  }
}

const run = promisify(execFile);
async function installApk(serial, apkPath) {
  const args = serial ? ['-s', serial] : [];
  // -t allows test-only APKs (locally-built assembleDebug outputs are test-only).
  await run('adb', [...args, 'install', '-t', '-r', '-g', apkPath]);
}

async function loadCase(name) {
  const file = path.join(repoRoot, 'tests', 'cases', `${name}.json`);
  return JSON.parse(await readFile(file, 'utf8'));
}

async function loadRunPlan(argv) {
  if (argv.case) {
    const testCase = await loadCase(argv.case);
    const catalogName = argv.catalog ?? testCase.catalog;
    return {
      catalogNames: catalogName ? [catalogName] : [],
      runs: [{ name: argv.case, catalogName, testCase }],
    };
  }

  if (argv.catalog && !argv.suite) {
    return { catalogNames: [argv.catalog], runs: [] };
  }

  const suiteName = argv.suite ?? defaultSuiteName;
  const suite = loadSuite(suiteName);
  const runs = [];
  for (const entry of suite) {
    const testCase = await loadCase(entry.case);
    const catalogName = argv.catalog ?? entry.catalog ?? testCase.catalog;
    runs.push({ name: entry.case, catalogName, testCase });
  }
  return { catalogNames: unique(runs.map((r) => r.catalogName).filter(Boolean)), runs };
}

async function runCase(serial, c) {
  switch (c.type) {
    case 'connectivity': {
      const results = await runConnectivity(serial, c);
      const failed = results.filter((r) => !r.ok);
      console.log(`connectivity: ${results.length - failed.length}/${results.length} passed`);
      return caseResult(failed);
    }
    case 'inspect': {
      const results = await runInspect(serial, c);
      const failed = results.filter((r) => !r.ok || r.state?.roundTrip === false);
      console.log(`inspect: ${results.length - failed.length}/${results.length} passed`);
      return caseResult(failed);
    }
    case 'preset': {
      const results = await runPreset(serial, c);
      const failed = results.filter((r) => !r.ok);
      console.log(`preset: ${results.length - failed.length}/${results.length} passed`);
      return caseResult(failed);
    }
    case 'byod-preset-output': {
      const results = await runByodPresetOutput(serial, c);
      const failed = results.filter((r) => !r.ok);
      console.log(`byod-preset-output: ${results.length - failed.length}/${results.length} passed`);
      return caseResult(failed);
    }
    case 'uapmd-project': {
      const results = await runUapmdProject(serial, c);
      const failed = results.filter((r) => !r.ok);
      console.log(`uapmd-project: ${results.length - failed.length}/${results.length} passed`);
      return caseResult(failed);
    }
    case 'uapmd-load-project': {
      const results = await runUapmdLoadProject(serial, c);
      const failed = results.filter((r) => !r.ok);
      console.log(`uapmd-load-project: ${results.length - failed.length}/${results.length} passed`);
      return caseResult(failed);
    }
    case 'uapmd-aap-ui-routing': {
      const results = await runUapmdAapUiRouting(serial, c);
      const failed = results.filter((r) => !r.ok);
      console.log(`uapmd-aap-ui-routing: ${results.length - failed.length}/${results.length} passed`);
      return caseResult(failed);
    }
    // TODO: 'render' case type -> our offline renderer + verify.js golden compare.
    default:
      throw new Error(`Unknown case type: ${c.type}`);
  }
}

function caseResult(failed) {
  if (!failed.length) return { ok: true };
  return { ok: false, error: summarizeFailures(failed) };
}

function summarize(results) {
  const failed = results.filter((r) => !r.ok);
  console.log('\n=== summary ===');
  for (const r of results) {
    const details = r.error ? ` — ${r.error}` : '';
    console.log(`${r.ok ? 'PASS' : 'FAIL'} ${r.name}${details}`);
  }
  console.log(`${results.length - failed.length}/${results.length} cases passed`);
  if (failed.length) process.exitCode = 1;
}

function summarizeFailures(failed) {
  return failed.map(describeFailure).filter(Boolean).join('; ');
}

function describeFailure(r) {
  if (r.error) return r.error;
  if (r.state?.roundTrip === false) return `${r.plugin ?? r.test ?? 'result'} state roundTrip mismatch`;
  if (r.test === 'uapmd-project') {
    return `roundTrip:${r.roundTrip} (${r.tracksBeforeSave ?? '?'}->${r.tracksAfterLoad ?? '?'}) ` +
      `missing:[${(r.missing ?? []).join(',')}] pluginsLoaded:[${(r.pluginsLoaded ?? []).join(',')}] ` +
      `(save:${r.saveError ?? '-'} load:${r.loadError ?? '-'})`;
  }
  if (r.test === 'uapmd-load-project') {
    return `loaded ${r.loadedCount ?? '?'}/${r.expectedCount ?? '?'}${formatProjectRefsForSummary(r)}`;
  }
  const json = JSON.stringify(r);
  return json && json.length > 500 ? `${json.slice(0, 497)}...` : json;
}

function formatProjectRefsForSummary(r) {
  const missing = formatRefs(r.missing);
  const failed = formatRefs(r.failed);
  const unexpected = formatRefs(r.unexpected);
  return ` missing:[${missing}] failed:[${failed}] unexpected:[${unexpected}] loadErr:${r.loadError ?? '-'}`;
}

function formatRefs(refs) {
  if (!Array.isArray(refs) || refs.length === 0) return '';
  return refs.map((ref) => ref.displayName || ref.pluginId || JSON.stringify(ref)).join(', ');
}

function unique(values) {
  return [...new Set(values)];
}

function npmConfigString(name) {
  return process.env[npmConfigEnvName(name)] || undefined;
}

function npmConfigBoolean(name) {
  const value = process.env[npmConfigEnvName(name)];
  if (value == null) return false;
  return !/^(false|0|no|off)?$/i.test(value);
}

function npmConfigEnvName(name) {
  return `npm_config_${name.replace(/-/g, '_')}`;
}

async function resetDownloadedApks() {
  await rm(paths.downloaded, { recursive: true, force: true });
  await mkdir(paths.downloaded, { recursive: true });
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
