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
    const code = connectivityScript(plugin, frameCount, sampleRate, blocks);
    const { resultCode, data } = await runJs(serial, c.hostPackage, code);
    // A pass requires BOTH the transport to succeed AND the script to return our
    // sentinel {ok:true}. The native facade reports failures as a returned string
    // (e.g. "ERROR: ...") with transport result=0, so the transport code alone is
    // not sufficient.
    const ok = resultCode === 0 && parsedOk(data);
    results.push({ plugin, ok, ...(ok ? { data } : { error: data }) });
    console.log(`${ok ? 'PASS' : 'FAIL'} connectivity ${plugin}${ok ? '' : ` — ${data}`}`);
  }
  return results;
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
