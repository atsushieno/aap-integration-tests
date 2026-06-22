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
    receiver: () => 'dev.atsushieno.uapmd/dev.atsushieno.uapmd.AutomationReceiver',
    readyProbe: '(1)',
    isReady: (rc) => rc === 0,
    isNotRunning: (rc, data) => rc === 2 || /uapmd-app is not running/i.test(data ?? ''),
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
  await stopApps(serial, c, hostPackage);
  await launchHost(serial, surface, hostPackage);

  const r = await connectOnce(serial, surface, hostPackage, uapmdProjectScript(c), 4,
    { acceptSemanticFailure: true });
  if (!r.ok) {
    console.log(`FAIL uapmd-project — ${r.error}`);
    return [{ test: 'uapmd-project', ok: false, error: r.error }];
  }
  const v = unwrap(r.data);
  console.log(`${v.ok ? 'PASS' : 'FAIL'} uapmd-project — ` +
    `tracksAdded:${v.tracksAdded} saved:${v.saved} loaded:${v.loaded} ` +
    `roundTrip:${v.roundTrip} (${v.tracksBeforeSave}->${v.tracksAfterLoad})` +
    (v.ok ? '' : ` (save:${v.saveError ?? '-'} load:${v.loadError ?? '-'})`));
  return [{ test: 'uapmd-project', ...v }];
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
  // Loading many plugins (incl. heavy JUCE ones) is slow; allow extra retry attempts.
  const r = await connectOnce(serial, surface, hostPackage, uapmdLoadProjectScript(devicePath, expected), 6,
    { acceptSemanticFailure: true });
  if (!r.ok) {
    const details = await automationTargetDetails(serial, hostPackage);
    const error = `${r.error}${details ? ` (${details})` : ''}`;
    console.log(`FAIL uapmd-load-project — ${error}`);
    return [{ test: 'uapmd-load-project', ok: false, error }];
  }
  const v = unwrap(r.data);
  console.log(`${v.ok ? 'PASS' : 'FAIL'} uapmd-load-project — loaded ${v.loadedCount}/${expected.length}` +
    (v.ok ? '' : formatProjectLoadFailure(v)));
  return [{ test: 'uapmd-load-project', ...v }];
}

function formatProjectLoadFailure(v) {
  const missing = formatPluginRefs(v.missing);
  const failed = formatPluginRefs(v.failed);
  const unexpected = formatPluginRefs(v.unexpected);
  return ` — missing:[${missing}] failed:[${failed}] unexpected:[${unexpected}] loadErr:${v.loadError ?? '-'}`;
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
    // Disable the live audio engine during the heavy load so the realtime render
    // thread does not compete for CPU (a busy engine can make a many-plugin load
    // slow enough to hit the app-thread timeout, or OOM/destabilize the device).
    try { uapmd.audio.setEngineEnabled(false); } catch (e) {}
    try { uapmd.scanTool.performScanning(); } catch (e) {}
    uapmd.sequencer.clearTracks();
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

/** JS evaluated in uapmd-app: new project -> add tracks + plugins -> save -> clear -> load -> verify. */
function uapmdProjectScript(c) {
  const hostPackage = c.hostPackage ?? 'dev.atsushieno.uapmd';
  const format = JSON.stringify(c.pluginFormat ?? 'AAP');
  const plugins = JSON.stringify(c.plugins ?? []);
  // Use the app's private internal dir, which it owns and can create under. Scoped
  // storage forbids the app raw-mkdir'ing its /storage/.../Android/data/<pkg> dir.
  const savePath = JSON.stringify(
    c.savePath ?? `/data/data/${hostPackage}/files/itest-project.uapmd`);
  return `(function(){
    try { uapmd.scanTool.performScanning(); } catch (e) {}   // make AAP plugins known to the catalog
    uapmd.sequencer.clearTracks();                            // start from an empty project
    var plugins = ${plugins};
    var tracksAdded = 0;
    for (var i = 0; i < plugins.length; i++) {
      uapmd.sequencer.addTrack();
      tracksAdded++;
      uapmd.instancing.create(${format}, plugins[i], i);     // add plugin onto the new track
    }
    var count = function(t){ return Array.isArray(t) ? t.length : t; };
    var tracksBeforeSave = count(uapmd.sequencer.getTrackInfos());
    var save = uapmd.project.save(${savePath});
    uapmd.sequencer.clearTracks();                            // wipe before reload
    var load = uapmd.project.load(${savePath});
    var tracksAfterLoad = count(uapmd.sequencer.getTrackInfos());
    var saved = !!(save && save.success);
    var loaded = !!(load && load.success);
    return {
      // Full round-trip: ops must succeed AND the reloaded project must restore the
      // same track count that was saved (otherwise save/load lost content).
      ok: saved && loaded && tracksAfterLoad === tracksBeforeSave,
      tracksAdded: tracksAdded,
      saved: saved,
      loaded: loaded,
      tracksBeforeSave: tracksBeforeSave,
      tracksAfterLoad: tracksAfterLoad,
      roundTrip: tracksAfterLoad === tracksBeforeSave,
      saveError: save && save.error,
      loadError: load && load.error
    };
  })()`;
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
    const { resultCode, data } = await runJs(serial, surface, hostPackage, code);
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
async function runJs(serial, surface, hostPackage, code) {
  const b64 = Buffer.from(code, 'utf8').toString('base64');
  const { stdout } = await adb(serial, [
    'shell', 'am', 'broadcast',
    '-a', surface.action,
    '-n', surface.receiver(hostPackage),
    '--es', 'code_base64', b64,
  ]);
  return parseBroadcast(stdout);
}

/** Parse `Broadcast completed: result=<code>, data="<data>"`. */
function parseBroadcast(stdout) {
  const m = /result=(-?\d+)(?:, data="([\s\S]*?)")?\s*$/m.exec(stdout);
  if (!m) throw new Error(`Unparseable broadcast output:\n${stdout}`);
  const data = m[2] != null ? m[2].replace(/\\"/g, '"') : '';
  return { resultCode: Number(m[1]), data };
}

/**
 * Launch the host app's activity (which wires up the on-device runtime), then
 * wait until the surface reports ready (aap: native client attached; uapmd: the
 * receiver stops returning "not running").
 */
async function launchHost(serial, surface, hostPackage) {
  await startActivity(serial, hostPackage);
  const deadline = Date.now() + 60_000;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const { resultCode, data } = await runJs(serial, surface, hostPackage, surface.readyProbe);
      last = data;
      if (surface.isReady(resultCode, data)) return;
    } catch { /* app still starting */ }
    await delay(1500);
  }
  throw new Error(`Host app ${hostPackage} did not become ready in time (last probe: ${last}).`);
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
      await adb(serial, ['shell', 'am', 'force-stop', pkg]);
      console.log(`force-stop ${pkg}`);
    } catch (e) {
      console.warn(`force-stop warning for ${pkg}: ${String(e.message ?? e).split('\n')[0]}`);
    }
  }
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

function adb(serial, args) {
  return run('adb', serial ? ['-s', serial, ...args] : args);
}
function unique(values) {
  return [...new Set(values)];
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
