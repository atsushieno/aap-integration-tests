# aap-integration-tests

**The** cross-repository integration test builder and runner for the AAP
ecosystem. No other repo runs these tests.

See [ARCHITECTURE.md](./ARCHITECTURE.md) for the full design and rationale. This
README is just an entry map; the architecture doc is the source of truth.

> **Status: early integration harness.** The CLI and GitHub Actions workflow are
> wired, but green runs still depend on Android device stability and fresh
> cross-repository artifact pins.

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

# Run the integration matrix with one command.
# Downloads catalog APKs, installs them once, then runs every committed CI case.
export GITHUB_TOKEN=<PAT with artifact-read scope>
npm test -- --device auto

# If the APKs are already installed on a connected device/emulator:
npm test -- --device auto --skip-acquire --skip-install

# No device: download APKs and bring up an emulator (GMD).
export GITHUB_TOKEN=<PAT with artifact-read scope>
npm test -- --device gmd
```

Key options: `--token` (PAT; or `$GITHUB_TOKEN`), `--device auto|local|gmd|firebase`,
`--serial`, `--suite ci|all`, `--skip-acquire` / `--skip-install`, `--reinstall`,
`--host-apk`. Requires `adb` (and the Android SDK emulator for `gmd`).

For single-case debugging, keep using `--case`:

```sh
npm test -- --case connectivity-mda --catalog mda-ci --device auto
```

## CI (GitHub Actions)

- **`unit-tests`** — fast host-runner logic tests (`npm run unit`); every push/PR; no
  device or secrets.
- **`integration-tests`** — downloads host + plugin APKs by commit from GitHub
  Actions artifacts, boots an emulator (`reactivecircus/android-emulator-runner`),
  installs, and runs the default integration suite (`npm test -- --device auto`).
  It uses API 35 because uapmd's Android app requires API 31+. Manual + nightly
  + on `main`.

  **Prerequisites before it goes green:**
  1. Secret **`AAP_ARTIFACTS_PAT`** — a PAT with artifact-read access to every
     source repo named by `catalogs/*.json` (default `GITHUB_TOKEN` can't read
     other repos' artifacts).
  2. Catalog pins whose GitHub Actions artifacts still exist, or cached copies in
     `.work/cache`. Otherwise `acquire` fails with a clear artifact error.
  3. Enough emulator capacity for uapmd and the larger plugin set; the workflow
     captures logcat and meminfo as `integration-diagnostics` on every run.

## uapmd-based testing

A second on-device **control surface**: uapmd-app exposes the same broadcast
protocol with a `uapmd.*` facade (project save/load, tracks, instancing). The
`uapmd-project` case type (`tests/cases/uapmd-project-mda.json`) creates a new
project, adds a track + plugin per entry, saves, reloads, and verifies — driving
the uapmd sequencer/project stack on top of AAP.

```sh
node src/cli.js --case uapmd-project-mda --device auto --skip-acquire   # uapmd-app already installed
```

Catalog `catalogs/uapmd-ci.json` downloads the uapmd-app APK + MDA plugin.
**Prerequisite:** uapmd's `android.yml` is `workflow_dispatch`-only and builds
against a chosen aap-core ref — dispatch it against an aap-core commit with the
current js-controller, then pin the `uapmd` commit in `uapmd-ci.json` (placeholder
until then).
