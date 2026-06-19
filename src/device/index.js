// Device-provider seam (ARCHITECTURE.md §8). The only contract: produce an
// adb-connectable target and tear it down. The rest of the runner is agnostic to
// which provider supplied the device.

/**
 * @typedef {Object} Device
 * @property {string|undefined} serial  adb serial (undefined = the only device)
 * @property {() => Promise<void>} dispose
 */

/**
 * @param {'auto'|'gmd'|'local'|'firebase'} kind
 *   'auto' applies the acquisition ordering (existing target -> Firebase if we
 *   are running there -> GMD), see ./auto.js.
 */
export async function acquireDevice(kind, opts = {}) {
  switch (kind) {
    case 'auto':     return (await import('./auto.js')).acquire(opts);
    case 'local':    return (await import('./local.js')).acquire(opts);
    case 'gmd':      return (await import('./gmd.js')).acquire(opts);
    case 'firebase': return (await import('./firebase.js')).acquire(opts);
    default:         throw new Error(`Unknown device provider: ${kind}`);
  }
}
