// Firebase Test Lab provider (ARCHITECTURE.md §8). Ordering policy (./auto.js):
// when running on Firebase, use a ready device setup if one is available, else
// create a setup and use it.
//
// DRAFT stub — Firebase's model is still TBD. FTL does not hand back a live adb
// serial the way a local emulator does: `gcloud firebase test android run`
// packages the test APK + plugin APKs and runs them on a provisioned device,
// returning results/artifacts via a results bucket. So this provider likely does
// NOT fit the "serial + dispose" shape and may instead drive a whole run. To be
// resolved when we actually exercise FTL.

export async function acquire(opts = {}) {
  // Intended ordering once the model is known:
  //   1. if a device setup is ready (named device spec configured/available) -> use it
  //   2. else create a setup (define the --device model/version) -> use it
  const device = opts.firebaseDevice || process.env.AAP_ITEST_FB_DEVICE;
  throw new Error(
    'device/firebase.acquire is a draft stub. ' +
      (device
        ? `Configured device "${device}" not wired up yet.`
        : 'No --firebaseDevice / AAP_ITEST_FB_DEVICE set, and FTL bring-up is unimplemented.')
  );
}
