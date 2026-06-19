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
const RECEIVER = 'org.androidaudioplugin.js.AapAutomationReceiver';
const ACTION_RUN_JS = 'org.androidaudioplugin.js.RUN_JS';

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

  await launchHost(serial, c.hostPackage);

  const results = [];
  for (const plugin of c.plugins) {
    const r = await connectOnce(serial, c.hostPackage, connectivityScript(plugin, frameCount, sampleRate, blocks));
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

  await launchHost(serial, c.hostPackage);

  const results = [];
  for (const plugin of c.plugins) {
    const r = await connectOnce(serial, c.hostPackage, inspectScript(plugin, frameCount, sampleRate));
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
async function connectOnce(serial, hostPackage, code, attempts = 4) {
  let lastError = '';
  for (let i = 1; i <= attempts; i++) {
    const { resultCode, data } = await runJs(serial, hostPackage, code);
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
async function runJs(serial, hostPackage, code) {
  const b64 = Buffer.from(code, 'utf8').toString('base64');
  const { stdout } = await adb(serial, [
    'shell', 'am', 'broadcast',
    '-a', ACTION_RUN_JS,
    '-n', `${hostPackage}/${RECEIVER}`,
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
 * Launch the host app so its activity wires the native client + serviceConnector
 * (PluginManagerScope), then wait until the runtime reports an attached client.
 */
async function launchHost(serial, hostPackage) {
  await startActivity(serial, hostPackage);
  const deadline = Date.now() + 60_000;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const { resultCode, data } = await runJs(serial, hostPackage, 'aap.runtimeInfo()');
      last = data;
      if (resultCode === 0 && attachedFlag(data)) return; // client wired -> ready
    } catch { /* app still starting */ }
    await delay(1500);
  }
  throw new Error(`Host app ${hostPackage} did not attach a native client in time (last runtimeInfo: ${last}).`);
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

/** Parse aap.runtimeInfo() data and report whether a native client is attached. */
function attachedFlag(data) {
  try {
    let v = JSON.parse(data);
    if (typeof v === 'string') v = JSON.parse(v);
    return !!(v && v.attached);
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
