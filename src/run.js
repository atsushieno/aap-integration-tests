// Test execution — connectivity smoke via the JS controller (path B,
// ARCHITECTURE.md §9). No verification: instantiate each plugin, let it process
// a few audio blocks, dispose. A pass just means the round-trip works.
//
// Path B is used because it needs nothing built: the plugin app ships compose-app,
// which embeds androidaudioplugin-js-controller, so the broadcast entry point and
// the aap.* facade already exist on-device.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

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
  },
};

/**
 * @param {string|undefined} serial
 * @param {{ hostPackage:string, plugins:string[], frameCount?:number,
 *           sampleRate?:number, blocks?:number }} c
 * @returns {Promise<{plugin:string, ok:boolean, data?:string, error?:string}[]>}
 */
export async function runConnectivity(serial, c) {
  const frameCount = c.frameCount ?? 1024;
  const sampleRate = c.sampleRate ?? 48000;
  const blocks = c.blocks ?? 10;

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
 * Inspection smoke (path B): for each plugin, retrieve the parameter list, the preset list,
 * read opaque state, and round-trip set-state. No golden comparison — a pass means every one
 * of those AAP extension calls returned a well-formed result and set-state(get-state) was a no-op.
 *
 * @param {string|undefined} serial
 * @param {{ hostPackage:string, plugins:string[], frameCount?:number, sampleRate?:number }} c
 * @returns {Promise<object[]>} per-plugin {plugin, ok, ...inspection} or {plugin, ok:false, error}
 */
export async function runInspect(serial, c) {
  const frameCount = c.frameCount ?? 1024;
  const sampleRate = c.sampleRate ?? 48000;

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
 * @param {{ hostPackage?:string, plugins?:string[], pluginFormat?:string, savePath?:string }} c
 */
export async function runUapmdProject(serial, c) {
  const surface = SURFACES.uapmd;
  const hostPackage = c.hostPackage ?? 'dev.atsushieno.uapmd';
  await launchHost(serial, surface, hostPackage);

  const r = await connectOnce(serial, surface, hostPackage, uapmdProjectScript(c));
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
 * Pass requires BOTH transport result=0 AND the script returning our {ok:true} sentinel; the native
 * facade reports failures as a returned "ERROR: ..." string with transport result=0.
 */
async function connectOnce(serial, surface, hostPackage, code, attempts = 4) {
  let lastError = '';
  for (let i = 1; i <= attempts; i++) {
    const { resultCode, data } = await runJs(serial, surface, hostPackage, code);
    if (resultCode === 0 && parsedOk(data)) return { ok: true, data };
    if (data && data.startsWith('ERROR')) return { ok: false, error: data }; // definitive
    lastError = data || '(empty result / broadcast timed out — service still binding?)';
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
      await adb(serial, ['shell', 'am', 'start', '-n', comp]);
      return;
    }
  } catch { /* fall back to monkey below */ }
  try {
    await adb(serial, ['shell', 'monkey', '-p', hostPackage, '-c', 'android.intent.category.LAUNCHER', '1']);
  } catch (e) {
    console.warn(`launch warning (continuing): ${String(e.message ?? e).split('\n')[0]}`);
  }
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

function adb(serial, args) {
  return run('adb', serial ? ['-s', serial, ...args] : args);
}
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
