// Test execution — connectivity smoke via the JS controller (path B,
// ARCHITECTURE.md §9). No verification: instantiate each plugin, let it process
// a few audio blocks, dispose. A pass just means the round-trip works.
//
// Path B is used because it needs nothing built: the plugin app ships compose-app,
// which embeds androidaudioplugin-js-controller, so the broadcast entry point and
// the aap.* facade already exist on-device.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { repoRoot } from './paths.js';
import { readUapmdProjectPluginReferences } from './uapmd-project.js';

const run = promisify(execFile);
const BROADCAST_TIMEOUT_MS = 30_000;

// Control surfaces: the two on-device automation entrypoints we drive over
// `adb am broadcast`. Both share the protocol shape (RUN_JS + base64 code,
// result via setResultData); they differ in action/receiver and readiness.
const SURFACES = {
  // aap-core's androidaudioplugin-js-controller (embedded in any AAP host app).
  aap: {
    action: 'org.androidaudioplugin.js.RUN_JS',
    receiver: (pkg) => `${pkg}/org.androidaudioplugin.js.AapAutomationReceiver`,
    readyProbe: 'aap.runtimeInfo()',
    isReady: (rc, data) => rc === 0 && flag(data, 'attached'),
  },
  // uapmd-app's AutomationReceiver (fixed package; returns code 2 until its
  // MainActivity is running).
  uapmd: {
    action: 'dev.atsushieno.uapmd.RUN_JS',
    asyncAction: 'dev.atsushieno.uapmd.RUN_JS_ASYNC',
    getJobAction: 'dev.atsushieno.uapmd.GET_JS_JOB',
    clearJobAction: 'dev.atsushieno.uapmd.CLEAR_JS_JOB',
    receiver: () => 'dev.atsushieno.uapmd/dev.atsushieno.uapmd.AutomationReceiver',
    readyProbe: '(1)',
    isReady: (rc) => rc === 0,
    isNotRunning: (rc, data) => rc === 2 || /uapmd-app is not running/i.test(data ?? ''),
    launchTimeoutMs: 180_000,
  },
};

/**
 * @param {string|undefined} serial
 * @param {{ hostPackage:string, plugins:string[], pluginPackages?:string[],
 *           stopPackages?:string[], frameCount?:number, sampleRate?:number, blocks?:number }} c
 * @returns {Promise<{plugin:string, ok:boolean, data?:string, error?:string}[]>}
 */
export async function runConnectivity(serial, c) {
  const frameCount = c.frameCount ?? 1024;
  const sampleRate = c.sampleRate ?? 48000;
  const blocks = c.blocks ?? 10;

  await stopApps(serial, c, c.hostPackage);
  await launchHost(serial, SURFACES.aap, c.hostPackage);

  const results = [];
  for (const plugin of c.plugins) {
    const r = await connectOnce(serial, SURFACES.aap, c.hostPackage, connectivityScript(plugin, frameCount, sampleRate, blocks));
    results.push({ plugin, ...r });
    console.log(`${r.ok ? 'PASS' : 'FAIL'} connectivity ${plugin}${r.ok ? '' : ` — ${r.error}`}`);
  }
  return results;
}

/**
 * Preset-selection test (path B): instantiate, then select a sample of preset indices and verify
 * the plugin SERVICE does not crash. Regression for the wavetable preset-select abort (an AAPXS
 * preset request made a JUCE plugin create an android.os.Handler on a thread without a Java Looper).
 *
 * IMPORTANT: that crash is ASYNCHRONOUS — setPreset returns OK to the host and the script finishes
 * with {ok:true} *before* the plugin service aborts on its own thread. So a host-side result check
 * alone gives a false pass. We must also confirm the plugin service process did not die: clear
 * logcat, run, settle, then scan logcat for a native abort of the plugin's service package(s).
 *
 * @param {string|undefined} serial
 * @param {{ hostPackage:string, plugins:string[], pluginPackages?:string[], stopPackages?:string[],
 *           presetIndices?:number[], frameCount?:number, sampleRate?:number, settleMs?:number }} c
 */
export async function runPreset(serial, c) {
  const frameCount = c.frameCount ?? 1024;
  const sampleRate = c.sampleRate ?? 48000;
  const settleMs = c.settleMs ?? 6000;
  const watch = c.pluginPackages ?? [];

  await stopApps(serial, c, c.hostPackage);
  await launchHost(serial, SURFACES.aap, c.hostPackage);

  const results = [];
  for (const plugin of c.plugins) {
    await adb(serial, ['logcat', '-c']).catch(() => {});
    const r = await connectOnce(serial, SURFACES.aap, c.hostPackage,
      presetScript(plugin, frameCount, sampleRate, c.presetIndices));
    await delay(settleMs);                          // let any async service abort surface
    const crash = await detectServiceCrash(serial, watch);

    const ok = r.ok && !crash;
    if (!ok) {
      const err = crash ? `plugin service crashed: ${crash}` : r.error;
      results.push({ plugin, ok: false, error: err });
      console.log(`FAIL preset ${plugin} — ${err}`);
      continue;
    }
    const v = unwrap(r.data);
    results.push({ plugin, ...v });
    console.log(`PASS preset ${plugin} — presetCount:${v.presetCount} ` +
      `selected:[${v.selected.map((s) => s.index).join(',')}] stateChanged:${v.stateChanged}`);
  }
  return results;
}

/** Scan logcat for a native abort / process death of any watched plugin-service package. */
async function detectServiceCrash(serial, packages) {
  if (!packages.length) return null;
  let stdout = '';
  try { ({ stdout } = await adb(serial, ['logcat', '-d'])); } catch { return null; }
  for (const line of stdout.split('\n')) {
    if (!/Fatal signal|SIGABRT|SIGSEGV|Can't create handler|has died/i.test(line)) continue;
    if (packages.some((p) => line.includes(p) || line.includes(shortProc(p))))
      return line.trim().slice(0, 240);
  }
  return null;
}

/** logcat tags truncate the process name to ~15 chars; match that suffix too. */
function shortProc(pkg) {
  return pkg.length > 15 ? pkg.slice(pkg.length - 15) : pkg;
}

/**
 * JS evaluated on-device: create -> prepare -> activate, then setPreset across a sample of indices
 * (default: first, second, middle, last) and report. Reading state before/after gives an
 * informational "did selection change anything" signal; the hard assertion is "no crash".
 */
function presetScript(pluginId, frameCount, sampleRate, presetIndices) {
  const pid = JSON.stringify(pluginId);
  const explicit = Array.isArray(presetIndices) ? JSON.stringify(presetIndices) : 'null';
  return `(function(){
    var inst = aap.instancing.create(${pid});
    inst.prepare(${frameCount}, ${sampleRate}).activate();
    var pc = inst.getPresetCount();
    var idx = ${explicit};
    if (!idx) { // default sample across the range
      idx = [0, 1, Math.floor(pc / 2), pc - 1];
    }
    var seen = {}, chosen = [];
    for (var k = 0; k < idx.length; k++) {
      var i = idx[k];
      if (i >= 0 && i < pc && !seen[i]) { seen[i] = 1; chosen.push(i); }
    }
    var stateBefore = inst.getState();
    var selected = [];
    for (var k = 0; k < chosen.length; k++) {
      inst.setPreset(chosen[k]);                       // the operation that crashed
      selected.push({ index: chosen[k], name: inst.getPresetName(chosen[k]) });
    }
    var stateAfter = inst.getState();
    inst.deactivate();
    inst.destroy();
    return { ok: true, pluginId: ${pid}, presetCount: pc, selected: selected,
             stateChanged: stateBefore !== stateAfter };
  })()`;
}

/**
 * Inspection smoke (path B): for each plugin, retrieve the parameter list, the preset list,
 * read opaque state, and round-trip set-state. No golden comparison — a pass means every one
 * of those AAP extension calls returned a well-formed result and set-state(get-state) was a no-op.
 *
 * @param {string|undefined} serial
 * @param {{ hostPackage:string, plugins:string[], pluginPackages?:string[], stopPackages?:string[],
 *           frameCount?:number, sampleRate?:number }} c
 * @returns {Promise<object[]>} per-plugin {plugin, ok, ...inspection} or {plugin, ok:false, error}
 */
export async function runInspect(serial, c) {
  const frameCount = c.frameCount ?? 1024;
  const sampleRate = c.sampleRate ?? 48000;

  await stopApps(serial, c, c.hostPackage);
  await launchHost(serial, SURFACES.aap, c.hostPackage);

  const results = [];
  for (const plugin of c.plugins) {
    const r = await connectOnce(serial, SURFACES.aap, c.hostPackage, inspectScript(plugin, frameCount, sampleRate));
    if (r.ok) {
      const v = unwrap(r.data);
      results.push({ plugin, ...v });
      const rt = v.state.length === 0 ? 'n/a' : v.state.roundTrip ? 'ok' : 'MISMATCH';
      console.log(`PASS inspect ${plugin} — params:${v.parameterCount} presets:${v.presetCount} ` +
        `state:${v.state.length}B roundTrip:${rt}`);
    } else {
      results.push({ plugin, ok: false, error: r.error });
      console.log(`FAIL inspect ${plugin} — ${r.error}`);
    }
  }
  return results;
}

/**
 * uapmd-based test (drives uapmd-app's automation surface): create a new (empty) project,
 * add a track per plugin and instantiate it, save the project, clear, reload, and verify the
 * tracks came back. Exercises the uapmd sequencer/project stack on top of AAP.
 *
 * @param {string|undefined} serial
 * @param {{ hostPackage?:string, plugins?:string[], pluginPackages?:string[], stopPackages?:string[],
 *           pluginFormat?:string, savePath?:string }} c
 */
export async function runUapmdProject(serial, c) {
  const surface = SURFACES.uapmd;
  const hostPackage = c.hostPackage ?? 'dev.atsushieno.uapmd';
  const plugins = c.plugins ?? [];
  await stopApps(serial, c, hostPackage);
  await launchHost(serial, surface, hostPackage);

  const scan = await connectOnce(serial, surface, hostPackage, uapmdScanScript());
  if (!scan.ok) {
    console.log(`FAIL uapmd-project — scan failed: ${scan.error}`);
    return [{ test: 'uapmd-project', ok: false, error: `scan failed: ${scan.error}` }];
  }

  const emptyProjectPath = await pushProjectToApp(serial, hostPackage, 'tests/cases/empty.uapmd');
  await launchHost(serial, surface, hostPackage);
  const reset = await connectOnce(serial, surface, hostPackage, uapmdLoadEmptyProjectScript(emptyProjectPath),
    4, { acceptSemanticFailure: true });
  if (!reset.ok) {
    console.log(`FAIL uapmd-project — reset failed: ${reset.error}`);
    return [{ test: 'uapmd-project', ok: false, error: `reset failed: ${reset.error}` }];
  }
  const resetResult = unwrap(reset.data);
  if (!resetResult.ok) {
    console.log(`FAIL uapmd-project — reset failed: ${JSON.stringify(resetResult)}`);
    return [{ test: 'uapmd-project', ok: false, error: `reset failed: ${JSON.stringify(resetResult)}` }];
  }

  const created = [];
  for (const plugin of plugins) {
    const create = await connectOnce(serial, surface, hostPackage, uapmdCreatePluginTrackScript(c.pluginFormat ?? 'AAP', plugin),
      4, { acceptSemanticFailure: true });
    if (!create.ok) {
      console.log(`FAIL uapmd-project — create ${plugin} failed: ${create.error}`);
      return [{ test: 'uapmd-project', ok: false, error: `create ${plugin} failed: ${create.error}` }];
    }
    const info = unwrap(create.data);
    if (!info.ok) {
      console.log(`FAIL uapmd-project — create ${plugin} failed: ${info.error ?? 'unknown error'}`);
      return [{ test: 'uapmd-project', ok: false, error: `create ${plugin} failed: ${info.error ?? 'unknown error'}` }];
    }
    const visible = await waitForUapmdPlugin(serial, surface, hostPackage, plugin, info.trackIndex);
    if (!visible.ok) {
      console.log(`FAIL uapmd-project — create ${plugin} did not become visible: ${visible.error}`);
      return [{ test: 'uapmd-project', ok: false, error: `create ${plugin} did not become visible: ${visible.error}` }];
    }
    created.push({ plugin, trackIndex: info.trackIndex });
  }

  const r = await connectOnce(serial, surface, hostPackage, uapmdProjectSaveLoadScript(c, plugins), 4,
    { acceptSemanticFailure: true });
  if (!r.ok) {
    console.log(`FAIL uapmd-project — ${r.error}`);
    return [{ test: 'uapmd-project', ok: false, error: r.error }];
  }
  const v = unwrap(r.data);
  console.log(`${v.ok ? 'PASS' : 'FAIL'} uapmd-project — ` +
    `tracksAdded:${v.tracksAdded} saved:${v.saved} loaded:${v.loaded} ` +
    `roundTrip:${v.roundTrip} (${v.tracksBeforeSave}->${v.tracksAfterLoad})` +
    (v.ok ? '' : ` missing:[${(v.missing ?? []).join(',')}] ` +
      `pluginsLoaded:[${(v.pluginsLoaded ?? []).join(',')}] ` +
      `(save:${v.saveError ?? '-'} load:${v.loadError ?? '-'})`));
  return [{ test: 'uapmd-project', created, ...v }];
}

/**
 * uapmd load-project test: push a .uapmd/.uapmdz project to the device, load it in uapmd-app,
 * and verify every plugin the project references actually instantiated. A loaded plugin node has a
 * non-empty pluginId in getTrackInfos(); a failed one has "".
 *
 * @param {string|undefined} serial
 * @param {{ hostPackage?:string, projectFile:string, pluginPackages?:string[], stopPackages?:string[] }} c
 */
export async function runUapmdLoadProject(serial, c) {
  const surface = SURFACES.uapmd;
  const hostPackage = c.hostPackage ?? 'dev.atsushieno.uapmd';
  const expected = await readUapmdProjectPluginReferences(c.projectFile);
  await stopApps(serial, c, hostPackage);
  await launchHost(serial, surface, hostPackage);

  const devicePath = await pushProjectToApp(serial, hostPackage, c.projectFile);
  // `adb push` / `run-as` can leave enough time for Android to stop the SDL
  // activity on a constrained CI emulator. Bring it back to foreground before
  // sending the heavy project-load automation payload.
  await launchHost(serial, surface, hostPackage);
  await delay(5000);
  // Loading many plugins (incl. heavy JUCE ones) is slow; allow extra retry attempts.
  const r = await runJsJob(serial, surface, hostPackage, uapmdLoadProjectScript(devicePath, expected),
    { timeoutMs: 180_000 });
  if (!r.ok) {
    let recoveryError = '';
    if (/timed out waiting for app thread/i.test(r.error ?? '')) {
      const recovered = await verifyUapmdLoadAfterAppThreadTimeout(serial, surface, hostPackage, expected);
      if (recovered.ok) return recovered.results;
      recoveryError = `; recovery verification failed: ${recovered.error}`;
    }
    const details = await automationTargetDetails(serial, hostPackage);
    const includeDetails = details && !/\(pid=/.test(r.error ?? '');
    const error = `${r.error}${recoveryError}${includeDetails ? ` (${details})` : ''}`;
    console.log(`FAIL uapmd-load-project — ${error}`);
    return [{ test: 'uapmd-load-project', ok: false, error, expectedCount: expected.length }];
  }
  const v = unwrap(r.data);
  if (!v.ok) {
    const settled = await verifyUapmdLoadAfterIncompleteResult(serial, surface, hostPackage, expected, v);
    if (settled.ok) return settled.results;
    console.log(`FAIL uapmd-load-project — loaded ${settled.value.loadedCount}/${expected.length} after settle` +
      formatProjectLoadFailure(settled.value) + formatInitialProjectLoadFailure(v));
    return [{ test: 'uapmd-load-project', expectedCount: expected.length, ...settled.value, initial: v }];
  }
  console.log(`${v.ok ? 'PASS' : 'FAIL'} uapmd-load-project — loaded ${v.loadedCount}/${expected.length}` +
    (v.ok ? '' : formatProjectLoadFailure(v)));
  return [{ test: 'uapmd-load-project', expectedCount: expected.length, ...v }];
}

async function verifyUapmdLoadAfterIncompleteResult(serial, surface, hostPackage, expected, initial) {
  await delay(5000);
  const r = await runJsJob(serial, surface, hostPackage, uapmdVerifyLoadedProjectScript(expected),
    { timeoutMs: 60_000, pollMs: 1000 });
  if (!r.ok)
    return { ok: false, value: { ok: false, loadedCount: initial.loadedCount, missing: initial.missing, failed: initial.failed, unexpected: initial.unexpected, loadError: r.error } };

  const v = unwrap(r.data);
  if (v.ok) {
    console.log(`PASS uapmd-load-project — loaded ${v.loadedCount}/${expected.length} after settle` +
      formatInitialProjectLoadFailure(initial));
    return {
      ok: true,
      results: [{
        test: 'uapmd-load-project',
        expectedCount: expected.length,
        settledAfterMs: 5000,
        initial,
        ...v
      }]
    };
  }
  return { ok: false, value: v };
}

async function verifyUapmdLoadAfterAppThreadTimeout(serial, surface, hostPackage, expected) {
  console.warn('uapmd-load-project: project load hit the 90s app-thread automation timeout; ' +
    'waiting for uapmd to become responsive and verifying loaded plugin state.');
  const r = await runJsJob(serial, surface, hostPackage, uapmdVerifyLoadedProjectScript(expected),
    { timeoutMs: 240_000, pollMs: 3000 });
  if (!r.ok) return { ok: false, error: r.error };

  const v = unwrap(r.data);
  console.log(`${v.ok ? 'PASS' : 'FAIL'} uapmd-load-project — loaded ${v.loadedCount}/${expected.length} after app-thread timeout` +
    (v.ok ? '' : formatProjectLoadFailure(v)));
  return { ok: true, results: [{ test: 'uapmd-load-project', expectedCount: expected.length, ...v }] };
}

function formatProjectLoadFailure(v) {
  const missing = formatPluginRefs(v.missing);
  const failed = formatPluginRefs(v.failed);
  const unexpected = formatPluginRefs(v.unexpected);
  return ` — missing:[${missing}] failed:[${failed}] unexpected:[${unexpected}] loadErr:${v.loadError ?? '-'}`;
}

function formatInitialProjectLoadFailure(v) {
  if (!v || v.ok) return '';
  return ` (initial loaded ${v.loadedCount}/${v.expectedCount ?? '?'} missing:[${formatPluginRefs(v.missing)}] failed:[${formatPluginRefs(v.failed)}] unexpected:[${formatPluginRefs(v.unexpected)}])`;
}

function formatPluginRefs(refs) {
  if (!Array.isArray(refs) || refs.length === 0) return '';
  return refs.map((r) => {
    const track = r.trackIndex === -1 ? 'master' :
      Number.isInteger(r.trackIndex) ? `track${r.trackIndex}` : 'track?';
    const plugin = Number.isInteger(r.pluginIndex) ? `plugin${r.pluginIndex}` :
      Number.isInteger(r.nodeIndex) ? `node${r.nodeIndex}` : 'plugin?';
    const name = r.displayName && r.displayName !== r.pluginId ? `${r.displayName} ` : '';
    return `${track}/${plugin} ${name}(${r.pluginId ?? '-'})`;
  }).join('; ');
}

/** Push a local project file into the app's private dir (run-as; debuggable app), readable by the app. */
async function pushProjectToApp(serial, hostPackage, projectFile) {
  const localPath = path.isAbsolute(projectFile) ? projectFile : path.join(repoRoot, projectFile);
  const name = path.basename(localPath);
  const tmp = `/data/local/tmp/${name}`;
  await adb(serial, ['push', localPath, tmp]);
  // /data/local/tmp isn't traversable by the app; copy into its sandbox via run-as.
  // Pass the whole command as ONE shell string so the nested `sh -c` script (with &&)
  // survives adb's argument flattening.
  await adb(serial, ['shell', `run-as ${hostPackage} sh -c 'mkdir -p files && cp ${tmp} files/${name}'`]);
  return `/data/data/${hostPackage}/files/${name}`;
}

/** Load the project, then collect which plugin nodes instantiated vs failed, and which expected are missing. */
function uapmdLoadProjectScript(devicePath, expectedPlugins) {
  return `(function(){
    function clearAllTracks() {
      for (var guard = 0; guard < 20; guard++) {
        var tracks = uapmd.sequencer.getTrackInfos() || [];
        if (tracks.length === 0) return true;
        for (var i = tracks.length - 1; i >= 0; i--) {
          var idx = (typeof tracks[i].trackIndex === 'number') ? tracks[i].trackIndex : i;
          try { uapmd.sequencer.removeTrack(idx); } catch (e) {}
        }
        try { uapmd.sequencer.clearTracks(); } catch (e) {}
      }
      return (uapmd.sequencer.getTrackInfos() || []).length === 0;
    }
    // Disable the live audio engine during the heavy load so the realtime render
    // thread does not compete for CPU (a busy engine can make a many-plugin load
    // slow enough to hit the app-thread timeout, or OOM/destabilize the device).
    try { uapmd.audio.setEngineEnabled(false); } catch (e) {}
    var load = uapmd.project.load(${JSON.stringify(devicePath)});
    try { uapmd.audio.setEngineEnabled(true); } catch (e) {}
    var tracks = uapmd.sequencer.getTrackInfos() || [];
    var loaded = [], failed = [];
    for (var i = 0; i < tracks.length; i++) {
      var nodes = tracks[i].nodes || [];
      for (var j = 0; j < nodes.length; j++) {
        var nd = nodes[j];
        if (!nd.isPlugin) continue;
        var ref = {
          trackIndex: i,
          nodeIndex: j,
          pluginIndex: j,
          pluginId: nd.pluginId || '',
          displayName: nd.displayName || ''
        };
        if (ref.pluginId.length > 0) loaded.push(ref);
        else failed.push(ref);
      }
    }
    var expected = ${JSON.stringify(expectedPlugins)};
    var remaining = loaded.slice();
    var missing = [];
    for (var k = 0; k < expected.length; k++) {
      var e = expected[k];
      var found = -1;
      for (var n = 0; n < remaining.length; n++) {
        if (remaining[n].pluginId === e.pluginId) { found = n; break; }
      }
      if (found >= 0) remaining.splice(found, 1);
      else missing.push(e);
    }
    return {
      ok: !!(load && load.success) && failed.length === 0 && missing.length === 0 && remaining.length === 0,
      loadedOk: !!(load && load.success),
      loadError: load && load.error,
      loadedCount: loaded.length,
      loaded: loaded,
      failedCount: failed.length,
      failed: failed,
      expectedCount: expected.length,
      expected: expected,
      missing: missing,
      unexpected: remaining
    };
  })()`;
}

function uapmdVerifyLoadedProjectScript(expectedPlugins) {
  return `(function(){
    var tracks = uapmd.sequencer.getTrackInfos() || [];
    var loaded = [], failed = [];
    for (var i = 0; i < tracks.length; i++) {
      var nodes = tracks[i].nodes || [];
      for (var j = 0; j < nodes.length; j++) {
        var nd = nodes[j];
        if (!nd.isPlugin) continue;
        var ref = {
          trackIndex: i,
          nodeIndex: j,
          pluginIndex: j,
          pluginId: nd.pluginId || '',
          displayName: nd.displayName || ''
        };
        if (ref.pluginId.length > 0) loaded.push(ref);
        else failed.push(ref);
      }
    }
    var expected = ${JSON.stringify(expectedPlugins)};
    var remaining = loaded.slice();
    var missing = [];
    for (var k = 0; k < expected.length; k++) {
      var e = expected[k];
      var found = -1;
      for (var n = 0; n < remaining.length; n++) {
        if (remaining[n].pluginId === e.pluginId) { found = n; break; }
      }
      if (found >= 0) remaining.splice(found, 1);
      else missing.push(e);
    }
    return {
      ok: failed.length === 0 && missing.length === 0 && remaining.length === 0,
      loadedOk: true,
      loadError: null,
      loadedCount: loaded.length,
      loaded: loaded,
      failedCount: failed.length,
      failed: failed,
      expectedCount: expected.length,
      expected: expected,
      missing: missing,
      unexpected: remaining
    };
  })()`;
}

async function waitForUapmdPlugin(serial, surface, hostPackage, pluginId, trackIndex) {
  let last = null;
  for (let i = 0; i < 12; i++) {
    const r = await connectOnce(serial, surface, hostPackage,
      uapmdPluginVisibleScript(pluginId, trackIndex), 3, { acceptSemanticFailure: true });
    if (!r.ok) return r;
    const v = unwrap(r.data);
    last = v;
    if (v.ok) return { ok: true, data: r.data };
    await delay(1000);
  }
  return { ok: false, error: `plugin ${pluginId} was not visible on track ${trackIndex}; last=${JSON.stringify(last)}` };
}

function uapmdResetTracksScript() {
  return `(function(){
    ${clearAllTracksFunctionSource()}
    var ok = clearAllTracks();
    return { ok: ok, tracksAfterReset: (uapmd.sequencer.getTrackInfos() || []).length };
  })()`;
}

function uapmdLoadEmptyProjectScript(devicePath) {
  return `(function(){
    try { uapmd.audio.setEngineEnabled(false); } catch (e) {}
    var load = uapmd.project.load(${JSON.stringify(devicePath)});
    var tracks = uapmd.sequencer.getTrackInfos() || [];
    return {
      ok: !!(load && load.success) && tracks.length === 0,
      loaded: !!(load && load.success),
      loadError: load && load.error,
      tracksAfterReset: tracks.length
    };
  })()`;
}

function uapmdCreatePluginTrackScript(format, pluginId) {
  return `(function(){
    var trackIndex = uapmd.sequencer.addTrack();
    try {
      var instanceId = uapmd.instancing.create(${JSON.stringify(format)}, ${JSON.stringify(pluginId)}, trackIndex);
      return { ok: true, pluginId: ${JSON.stringify(pluginId)}, trackIndex: trackIndex, instanceId: instanceId };
    } catch (e) {
      return { ok: false, pluginId: ${JSON.stringify(pluginId)}, trackIndex: trackIndex, error: String(e) };
    }
  })()`;
}

function uapmdPluginVisibleScript(pluginId, trackIndex) {
  return `(function(){
    var tracks = uapmd.sequencer.getTrackInfos() || [];
    var seen = [];
    for (var i = 0; i < tracks.length; i++) {
      var nodes = tracks[i].nodes || [];
      for (var j = 0; j < nodes.length; j++) {
        var nd = nodes[j];
        if (!nd.isPlugin) continue;
        seen.push({ trackIndex: i, pluginId: nd.pluginId || '', displayName: nd.displayName || '' });
        if (i === ${trackIndex} && nd.pluginId === ${JSON.stringify(pluginId)})
          return { ok: true, pluginId: ${JSON.stringify(pluginId)}, trackIndex: ${trackIndex}, seen: seen };
      }
    }
    return { ok: false, pluginId: ${JSON.stringify(pluginId)}, trackIndex: ${trackIndex}, seen: seen };
  })()`;
}

/** JS evaluated in uapmd-app after tracks/plugins are created: save -> clear -> load -> verify. */
function uapmdProjectSaveLoadScript(c, plugins) {
  const hostPackage = c.hostPackage ?? 'dev.atsushieno.uapmd';
  const expectedPlugins = JSON.stringify(plugins ?? []);
  // Use the app's private internal dir, which it owns and can create under. Scoped
  // storage forbids the app raw-mkdir'ing its /storage/.../Android/data/<pkg> dir.
  const savePath = JSON.stringify(
    c.savePath ?? `/data/data/${hostPackage}/files/itest-project.uapmd`);
  return `(function(){
    ${clearAllTracksFunctionSource()}
    var plugins = ${expectedPlugins};
    var count = function(t){ return Array.isArray(t) ? t.length : t; };
    var tracksBeforeSave = count(uapmd.sequencer.getTrackInfos());
    var save = uapmd.project.save(${savePath});
    clearAllTracks();                                         // wipe before reload
    var load = uapmd.project.load(${savePath});
    var tracks = uapmd.sequencer.getTrackInfos() || [];
    var tracksAfterLoad = count(tracks);
    var loadedPlugins = [];
    for (var i = 0; i < tracks.length; i++) {
      var nodes = tracks[i].nodes || [];
      for (var j = 0; j < nodes.length; j++) {
        var nd = nodes[j];
        if (nd.isPlugin && nd.pluginId) loadedPlugins.push(nd.pluginId);
      }
    }
    var missing = plugins.filter(function(p){ return loadedPlugins.indexOf(p) < 0; });
    var saved = !!(save && save.success);
    var projectLoaded = !!(load && load.success);
    return {
      // Full round-trip: ops must succeed AND every plugin created before save
      // must be instantiated after reload. Track count alone is not stable enough
      // on uapmd because stale/empty tracks can appear around reset/load.
      ok: saved && projectLoaded && missing.length === 0,
      tracksAdded: plugins.length,
      saved: saved,
      loaded: projectLoaded,
      tracksBeforeSave: tracksBeforeSave,
      tracksAfterLoad: tracksAfterLoad,
      pluginsLoaded: loadedPlugins,
      missing: missing,
      roundTrip: missing.length === 0,
      saveError: save && save.error,
      loadError: load && load.error
    };
  })()`;
}

function uapmdScanScript() {
  return `(function(){
    try { uapmd.audio.setEngineEnabled(false); } catch (e) {}
    try { uapmd.scanTool.performScanning(); } catch (e) {
      return { ok: false, phase: 'scan', error: String(e) };
    }
    return { ok: true, phase: 'scan' };
  })()`;
}

function clearAllTracksFunctionSource() {
  return `function clearAllTracks() {
      for (var guard = 0; guard < 20; guard++) {
        var tracks = uapmd.sequencer.getTrackInfos() || [];
        if (tracks.length === 0) return true;
        for (var i = tracks.length - 1; i >= 0; i--) {
          var idx = (typeof tracks[i].trackIndex === 'number') ? tracks[i].trackIndex : i;
          try { uapmd.sequencer.removeTrack(idx); } catch (e) {}
        }
        try { uapmd.sequencer.clearTracks(); } catch (e) {}
      }
      return (uapmd.sequencer.getTrackInfos() || []).length === 0;
    }`;
}

/**
 * JS evaluated on-device: create -> prepare -> activate, then exercise the four extension reads:
 * parameter list, preset list, get-state, and set-state(get-state) round-trip. Disposes afterward.
 */
function inspectScript(pluginId, frameCount, sampleRate) {
  const pid = JSON.stringify(pluginId);
  return `(function(){
    var inst = aap.instancing.create(${pid});
    inst.prepare(${frameCount}, ${sampleRate}).activate();

    var parameters = inst.getParameters();
    var parameterCount = inst.getParameterCount();

    var presetCount = inst.getPresetCount();
    var presets = [];
    for (var i = 0; i < presetCount; i++)
      presets.push({ index: i, name: inst.getPresetName(i) });

    var state = inst.getState();
    var roundTrip = null;
    if (state && state.length > 0) {
      inst.setState(state);
      roundTrip = (inst.getState() === state);
    }

    inst.deactivate();
    inst.destroy();
    return {
      ok: true,
      pluginId: ${pid},
      parameterCount: parameterCount,
      parameters: parameters,
      presetCount: presetCount,
      presets: presets,
      state: { length: state ? state.length : 0, roundTrip: roundTrip }
    };
  })()`;
}

/** Parse a result payload that may be JSON or a JSON-encoded JSON string (transport double-encodes). */
function unwrap(data) {
  let v = JSON.parse(data);
  if (typeof v === 'string') v = JSON.parse(v);
  return v;
}

/**
 * Run one connectivity script, with retries for the first-bind race: the initial create() triggers
 * a plugin-service bind that can outlast `am broadcast`'s result window, yielding an empty result
 * even though the bind completes in the background. A retry (the engine serializes, so it runs once
 * the bind is done) then succeeds. A definitive `ERROR:` is NOT retried.
 *
 * By default, pass requires BOTH transport result=0 AND the script returning our {ok:true}
 * sentinel; the native facade reports failures as a returned "ERROR: ..." string with
 * transport result=0. Some uapmd cases intentionally return {ok:false, ...details}
 * for semantic failures; pass acceptSemanticFailure so the caller can format those details.
 */
async function connectOnce(serial, surface, hostPackage, code, attempts = 4, opts = {}) {
  let lastError = '';
  for (let i = 1; i <= attempts; i++) {
    let resultCode;
    let data;
    try {
      ({ resultCode, data } = await runJs(serial, surface, hostPackage, code, opts));
    } catch (e) {
      lastError = describeRunJsError(e);
      if (i < attempts) {
        console.warn(`${lastError}. Relaunching ${hostPackage} before retry ${i + 1}/${attempts}.`);
        await forceStopPackage(serial, hostPackage);
        await launchHost(serial, surface, hostPackage);
        continue;
      }
      return { ok: false, error: lastError };
    }
    if (resultCode === 0 && parsedOk(data)) return { ok: true, data };
    if (opts.acceptSemanticFailure && resultCode === 0 && parsedResultObject(data))
      return { ok: true, data };
    if (surface.isNotRunning?.(resultCode, data)) {
      if (i < attempts) {
        lastError = `automation runtime is not attached (broadcast result=${resultCode}: ${data || '(no data)'}). ` +
          `Relaunching ${hostPackage} before retry ${i + 1}/${attempts}.`;
        console.warn(lastError);
        await launchHost(serial, surface, hostPackage);
        continue;
      }
      return {
        ok: false,
        error: `automation runtime is not attached after ${attempts} attempt(s). ` +
          `The ${hostPackage} activity is not alive when JS automation is sent. ` +
          `Last receiver response: result=${resultCode}, data=${data || '(empty)'}`,
      };
    }
    if (data && data.startsWith('ERROR')) return { ok: false, error: data }; // definitive
    lastError = resultCode === 0
      ? (data || '(empty result / broadcast timed out — service still binding?)')
      : `broadcast result=${resultCode}, data=${data || '(empty)'}`;
    if (i < attempts) await delay(4000); // bind likely in progress; let it finish, then retry
  }
  return { ok: false, error: lastError };
}

function describeRunJsError(e) {
  const msg = String(e.stderr || e.stdout || e.message || e);
  if (e.killed || e.signal === 'SIGKILL' || /timed out/i.test(msg))
    return `adb broadcast timed out after ${e.timeoutMs ?? BROADCAST_TIMEOUT_MS}ms; target app likely ANR'd or did not finish JS automation`;
  return `adb broadcast failed: ${msg.split('\n')[0]}`;
}

/** JS evaluated on-device: create -> prepare -> activate -> process -> dispose. */
function connectivityScript(pluginId, frameCount, sampleRate, blocks) {
  const pid = JSON.stringify(pluginId);
  return `(function(){
    var inst = aap.instancing.create(${pid});
    inst.prepare(${frameCount}, ${sampleRate}).activate();
    for (var i = 0; i < ${blocks}; i++) inst.process(${frameCount});
    inst.deactivate();
    inst.destroy();
    return { ok: true, pluginId: ${pid}, blocks: ${blocks} };
  })()`;
}

/** Send one RUN_JS broadcast and parse its result. Code is passed base64 to dodge shell escaping. */
async function runJs(serial, surface, hostPackage, code, opts = {}) {
  const b64 = Buffer.from(code, 'utf8').toString('base64');
  const timeout = opts.broadcastTimeoutMs ?? BROADCAST_TIMEOUT_MS;
  const { stdout } = await adb(serial, [
    'shell', 'am', 'broadcast',
    '-a', surface.action,
    '-n', surface.receiver(hostPackage),
    '--es', 'code_base64', b64,
  ], { timeout, killSignal: 'SIGKILL' });
  return parseBroadcast(stdout);
}

async function runJsJob(serial, surface, hostPackage, code, opts = {}) {
  if (!surface.asyncAction || !surface.getJobAction)
    return { ok: false, error: 'surface does not support async JS jobs' };

  const b64 = Buffer.from(code, 'utf8').toString('base64');
  let start = null;
  for (let i = 1; i <= 4; i++) {
    try {
      start = await broadcast(serial, surface, hostPackage, surface.asyncAction, [
        '--es', 'code_base64', b64,
      ]);
    } catch (e) {
      const error = describeRunJsError(e);
      if (i < 4) {
        console.warn(`${error}. Relaunching ${hostPackage} before job start retry ${i + 1}/4.`);
        await launchHost(serial, surface, hostPackage);
        await delay(5000);
        continue;
      }
      return { ok: false, error: `failed to start async JS job: ${error}` };
    }
    if (start.resultCode === 0 && start.data && !start.data.startsWith('ERROR')) break;
    if (surface.isNotRunning?.(start.resultCode, start.data) && i < 4) {
      console.warn(`async automation runtime is not attached (broadcast result=${start.resultCode}: ${start.data || '(no data)'}). ` +
        `Relaunching ${hostPackage} before job start retry ${i + 1}/4.`);
      await launchHost(serial, surface, hostPackage);
      await delay(5000);
      continue;
    }
    return { ok: false, error: `failed to start async JS job: result=${start.resultCode}, data=${start.data || '(empty)'}` };
  }

  const jobId = start.data;
  const deadline = Date.now() + (opts.timeoutMs ?? 180_000);
  let last = null;
  try {
    while (Date.now() < deadline) {
      await delay(opts.pollMs ?? 2000);
      let poll;
      try {
        poll = await broadcast(serial, surface, hostPackage, surface.getJobAction, [
          '--es', 'job_id', jobId,
        ]);
      } catch (e) {
        last = describeRunJsError(e);
        continue;
      }
      if (poll.resultCode !== 0) {
        last = `poll result=${poll.resultCode}, data=${poll.data || '(empty)'}`;
        if (automationNativeBridgeMissing(poll.data)) {
          const details = await automationTargetDetails(serial, hostPackage);
          return {
            ok: false,
            error: `host native automation bridge is unavailable while polling ${jobId}; ` +
              `the app likely crashed or restarted during JS automation. ` +
              `Last receiver response: ${last}${details ? ` (${details})` : ''}`,
          };
        }
        continue;
      }
      const job = parseJobResult(poll.data);
      last = job;
      if (job?.state !== 'completed') continue;
      const result = job.result;
      if (typeof result === 'string' && result.startsWith('ERROR'))
        return { ok: false, error: result };
      if (!parsedResultObject(result))
        return { ok: false, error: `async JS job returned unparseable result: ${result ?? '(empty)'}` };
      return { ok: true, data: result };
    }
    return { ok: false, error: `async JS job ${jobId} timed out after ${opts.timeoutMs ?? 180_000}ms; last=${JSON.stringify(last)}` };
  } finally {
    if (surface.clearJobAction) {
      await broadcast(serial, surface, hostPackage, surface.clearJobAction, [
        '--es', 'job_id', jobId,
      ]).catch(() => {});
    }
  }
}

async function broadcast(serial, surface, hostPackage, action, extras) {
  const { stdout } = await adb(serial, [
    'shell', 'am', 'broadcast',
    '-a', action,
    '-n', surface.receiver(hostPackage),
    ...extras,
  ], { timeout: BROADCAST_TIMEOUT_MS, killSignal: 'SIGKILL' });
  return parseBroadcast(stdout);
}

function parseJobResult(data) {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

function automationNativeBridgeMissing(data) {
  return /UnsatisfiedLinkError: No implementation found for .*MainActivity\.native/i.test(data ?? '');
}

/** Parse `Broadcast completed: result=<code>, data="<data>"`. */
function parseBroadcast(stdout) {
  const m = /result=(-?\d+)(?:, data="([\s\S]*?)")?\s*$/m.exec(stdout);
  if (!m) throw new Error(`Unparseable broadcast output:\n${stdout}`);
  const data = m[2] != null ? m[2] : '';
  return { resultCode: Number(m[1]), data };
}

/**
 * Launch the host app's activity (which wires up the on-device runtime), then
 * wait until the surface reports ready (aap: native client attached; uapmd: the
 * receiver stops returning "not running").
 */
async function launchHost(serial, surface, hostPackage) {
  await suppressImmersiveModeConfirmation(serial);
  await startActivity(serial, hostPackage);
  await dismissImmersiveModeConfirmation(serial);
  let lastStart = Date.now();
  const deadline = Date.now() + (surface.launchTimeoutMs ?? 60_000);
  let last = '';
  let readyCount = 0;
  const needed = surface.stableReadyCount ?? 1;
  while (Date.now() < deadline) {
    try {
      const { resultCode, data } = await runJs(serial, surface, hostPackage, surface.readyProbe);
      last = data;
      if (surface.isReady(resultCode, data)) {
        if (await hasImmersiveModeConfirmation(serial)) {
          readyCount = 0;
          await dismissImmersiveModeConfirmation(serial);
          await delay(1000);
          continue;
        }
        readyCount++;
        if (readyCount >= needed) return;
        await delay(surface.stableReadyDelayMs ?? 500);
        continue;
      }
      readyCount = 0;
    } catch { /* app still starting */ }
    if (Date.now() - lastStart > 15_000) {
      await startActivity(serial, hostPackage).catch(() => {});
      await dismissImmersiveModeConfirmation(serial);
      lastStart = Date.now();
    }
    await delay(1500);
  }
  const details = await automationTargetDetails(serial, hostPackage);
  throw new Error(`Host app ${hostPackage} did not become ready in time ` +
    `(last probe: ${last || '(empty)'}${details ? `; ${details}` : ''}).`);
}

async function suppressImmersiveModeConfirmation(serial) {
  await adb(serial, ['shell', 'settings', 'put', 'secure', 'immersive_mode_confirmations', 'confirmed'])
    .catch(() => {});
}

async function dismissImmersiveModeConfirmation(serial) {
  for (let i = 0; i < 4; i++) {
    if (!(await hasImmersiveModeConfirmation(serial))) return;
    await adb(serial, ['shell', 'input', 'keyevent', 'KEYCODE_ENTER']).catch(() => {});
    await delay(500);
  }
}

async function hasImmersiveModeConfirmation(serial) {
  try {
    const { stdout } = await adb(serial, [
      'shell',
      "dumpsys activity activities | grep -E 'mFocusedWindow|mCurrentFocus' | head -5",
    ]);
    return /ImmersiveModeConfirmation/i.test(stdout);
  } catch {
    return false;
  }
}

/** Start the host's launchable activity (resolve it explicitly; more reliable than monkey). */
async function startActivity(serial, hostPackage) {
  try {
    const { stdout } = await adb(serial, [
      'shell', 'cmd', 'package', 'resolve-activity', '--brief',
      '-c', 'android.intent.category.LAUNCHER', hostPackage,
    ]);
    const comp = stdout.trim().split('\n').pop().trim(); // "pkg/.Activity"
    if (comp.includes('/')) {
      await adb(serial, ['shell', 'am', 'start', '-W', '-n', comp]);
      return;
    }
  } catch { /* fall back to monkey below */ }
  try {
    await adb(serial, ['shell', 'monkey', '-p', hostPackage, '-c', 'android.intent.category.LAUNCHER', '1']);
  } catch (e) {
    console.warn(`launch warning (continuing): ${String(e.message ?? e).split('\n')[0]}`);
  }
}

async function stopApps(serial, c, hostPackage) {
  const packages = unique([hostPackage, ...(c.pluginPackages ?? []), ...(c.stopPackages ?? [])]
    .filter((p) => typeof p === 'string' && p.length > 0));
  for (const pkg of packages) {
    try {
      await forceStopPackage(serial, pkg);
      console.log(`force-stop ${pkg}`);
    } catch (e) {
      console.warn(`force-stop warning for ${pkg}: ${String(e.message ?? e).split('\n')[0]}`);
    }
  }
}

async function forceStopPackage(serial, pkg) {
  await adb(serial, ['shell', 'am', 'force-stop', pkg]);
}

async function automationTargetDetails(serial, hostPackage) {
  const parts = [];
  try {
    const { stdout } = await adb(serial, ['shell', `pidof ${hostPackage} || true`]);
    parts.push(`pid=${stdout.trim() || 'none'}`);
  } catch { /* best-effort diagnostics */ }
  try {
    const { stdout } = await adb(serial, [
      'shell',
      "dumpsys activity activities | grep -E 'mResumedActivity|topResumedActivity|mFocusedWindow' | head -5",
    ]);
    const activity = stdout.trim().replace(/\s+/g, ' ');
    if (activity) parts.push(`activity=${activity.slice(0, 240)}`);
  } catch { /* best-effort diagnostics */ }
  return parts.join('; ');
}

/** Parse a result payload (possibly double-encoded) and report a boolean member. */
function flag(data, key) {
  try {
    let v = JSON.parse(data);
    if (typeof v === 'string') v = JSON.parse(v);
    return !!(v && v[key]);
  } catch {
    return false;
  }
}

/** True only if the returned data is our {ok:true} sentinel JSON. */
function parsedOk(data) {
  try {
    let v = JSON.parse(data);
    if (typeof v === 'string') v = JSON.parse(v); // tolerate JSON-encoded-string results
    return v && v.ok === true;
  } catch {
    return false; // e.g. "ERROR: ..." strings from the native facade
  }
}

function parsedResultObject(data) {
  try {
    let v = JSON.parse(data);
    if (typeof v === 'string') v = JSON.parse(v);
    return v && typeof v === 'object' && !Array.isArray(v);
  } catch {
    return false;
  }
}

function adb(serial, args, opts = {}) {
  if (args && !Array.isArray(args)) {
    opts = args;
    args = [];
  }
  const adbArgs = serial ? ['-s', serial, ...args] : args;
  if (opts.timeout) return runWithManualTimeout('adb', adbArgs, opts);
  return run('adb', adbArgs, opts);
}

function runWithManualTimeout(file, args, opts) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, {}, (error, stdout, stderr) => {
      clearTimeout(timer);
      if (timedOut) {
        const e = new Error(`Command timed out after ${opts.timeout}ms: ${file} ${args.join(' ')}`);
        e.killed = true;
        e.signal = opts.killSignal ?? 'SIGTERM';
        e.timeoutMs = opts.timeout;
        e.stdout = stdout;
        e.stderr = stderr;
        reject(e);
        return;
      }
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(opts.killSignal ?? 'SIGTERM'); } catch {}
    }, opts.timeout);
  });
}
function unique(values) {
  return [...new Set(values)];
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
