# aap-integration-tests

**The** cross-repository integration test builder and runner for the AAP
ecosystem. No other repo runs these tests.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full design and rationale. This
README is just an entry map; the architecture doc is the source of truth.

> **Status: early scaffold (DRAFT).** Most of `src/` is honest stubs marking
> intended responsibilities. Nothing is wired into CI yet.

## What it does (target)

1. Read a named **setup catalog** (`catalogs/<name>.json`) — a flat list of
   `{ repo, commit, artifacts, files? }` download entries.
2. **Acquire** the cataloged module/plugin APKs from each commit's GitHub Actions
   artifacts (PAT-authenticated), into a working dir, cached by `repo@commit`.
3. **Install** them on an adb-connectable device (skipping when `versionCode`
   matches).
4. **Run** test cases against the AAP framework API — by default as instrumented
   tests; optionally via the embedded JS controller (`adb am broadcast`).
5. **Verify** rendered audio against approved goldens (tolerant compare / spectrum).

## Layout

```
catalogs/            named setup catalogs (committed)
src/
  cli.js             entrypoint wiring the steps
  paths.js           .work/ directory layout
  catalog.js         load + validate a catalog
  acquire.js         resolve commit -> artifact -> download -> cache
  install.js         adb install with versionCode skip
  verify.js          golden / spectrum tolerant comparison
  device/            device-provider seam (gmd | local | firebase)
tests/cases/         test-case definitions
android-tests/       (later) Gradle instrumented-test project
.work/               working dir — NOT committed; Actions-cached
```

## Usage

```sh
npm install

# Against an already-connected device/emulator (skip download+install):
node src/cli.js --case connectivity-mda --device auto --skip-acquire

# No device: download the MDA plugin by commit and bring up an emulator (GMD).
# Plugin CI APKs predate the JS controller, so provide a host app that has it:
export GITHUB_TOKEN=<PAT with artifact-read scope>
node src/cli.js --case connectivity-mda --device gmd \
  --host-apk /path/to/aaphostsample-debug.apk
```

Key options: `--token` (PAT; or `$GITHUB_TOKEN`), `--device auto|local|gmd|firebase`,
`--skip-acquire` / `--skip-install`, `--reinstall`, `--host-apk`. Requires `adb`
(and the Android SDK emulator for `gmd`).

## CI (GitHub Actions)

- **`unit-tests`** — fast host-runner logic tests (`npm test`); every push/PR; no
  device or secrets.
- **`integration-tests`** — downloads host + plugin APKs by commit from GitHub
  Actions artifacts, boots an emulator (`reactivecircus/android-emulator-runner`),
  installs, runs connectivity. Manual + nightly + on `main`.

  **Prerequisites before it goes green:**
  1. Secret **`AAP_ARTIFACTS_PAT`** — a PAT with artifact-read access to the
     source repos (default `GITHUB_TOKEN` can't read other repos' artifacts).
  2. **`catalogs/mda-ci.json`** — pin the `aap-core` entry to a green commit whose
     `aaphostsample` bundles the current js-controller (connect step + threading
     fix). Until then `acquire` fails with a clear "no successful run" error.
