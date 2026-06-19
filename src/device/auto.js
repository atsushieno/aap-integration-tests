// Automatic device acquisition ordering (ARCHITECTURE.md §8):
//
//   1. If a usable adb target already exists, use it.
//   2. Else, if we are running on Firebase, use a ready device setup or create one.
//   3. Else, ensure a GMD setup exists (create if missing) and launch it.
//
// Step 1 is what makes this cheap for anyone who connects their own device — they
// never reach the (memory-heavy) GMD launch. Step 3 is the fallback for everyone
// who does NOT bring their own device; it must remain available, not gated away.

import { find as findLocal } from './local.js';

export async function acquire(opts = {}) {
  // 1. existing usable target — reused, not torn down (we did not launch it).
  const existing = await findLocal(opts);
  if (existing) {
    console.log(`device: reusing existing adb target ${existing.serial}`);
    return existing;
  }

  // 2. Firebase, only when we are actually running there
  if (isFirebase(opts)) {
    console.log('device: no existing target; using Firebase provider');
    return (await import('./firebase.js')).acquire(opts);
  }

  // 3. GMD: create if needed, then launch
  console.log('device: no existing target; bringing up GMD');
  return (await import('./gmd.js')).acquire(opts);
}

/** Heuristic for "are we running on Firebase Test Lab?". */
function isFirebase(opts) {
  if (opts.firebase) return true;
  return process.env.AAP_ITEST_FIREBASE === '1';
}
