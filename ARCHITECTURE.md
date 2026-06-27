# aap-integration-tests — Architecture

> **Status: CI is green.** The suite runs on GitHub Actions (hosted emulator,
> API 35, KVM), downloads all APKs by commit, installs them, and produces
> repeatable results. 9/9 cases pass on a clean run. The remaining gaps are audio
> verification (no golden WAVs yet) and path-(A) instrumented tests (never needed).

## Implementation status (as of v0.11.0)

| Area | Code path | Reliability |
|------|-----------|-------------|
| Host runner (`src/cli.js`, `src/run.js`) — catalog → acquire → device → install → run | exists | works; used in CI every run |
| Catalog + download-by-commit + `.work/` cache (`acquire.js`, `catalog.js`, `paths.js`) | exists | reliable; hard-errors on expired artifacts |
| APK inspection at acquire-time (`acquire.js:inspectApks`) — verifies `aap-api.js` symbols in host APK before install | exists | catches stale aap-core pins early |
| Install (`install.js`): SHA-256 checksum vs device, reinstall on mismatch, signature-mismatch reinstall | exists | reliable; checksum stored on device survives AVD cache |
| Device providers (`src/device/`): `auto`, `local`, `gmd`, `firebase` | exists | `local`/`auto` used in CI; `gmd` unproven; `firebase` a stub |
| On-device path **(B)** JS controller over `adb am broadcast` — all current cases | exists | works reliably |
| Case types: `connectivity`, `inspect`, `preset`, `plugin-smoke`, `byod-preset-output` | exist | pass |
| Case types: `uapmd-project`, `uapmd-load-project`, `uapmd-aap-ui-routing`, `uapmd-byod-preset-values` | exist | pass |
| CI: `integration-tests.yml` (hosted emulator + full default suite) | exists | validated; green |
| On-device path **(A)** instrumented tests | — | planned, not built, not needed so far |
| Offline renderer (`aap.render.*`) + golden WAV verification (`verify.js`) | scaffold only | no case uses it yet |

## 1. Purpose

Provide a cross-repository testing foundation for the AAP ecosystem: verify that
**real-world AAP plugins** (built in other repositories) can be instantiated and
operated through the **AAP framework API**, and that audio processing produces
expected output — across versions of aap-core and the surrounding modules.

This cannot be done inside aap-core alone, because the meaningful test subjects
are plugins that live in other repositories.

## 2. Scope and non-goals

**In scope**
- Installing existing AAP plugin APKs produced by *other repositories'* CI.
- Driving AAP framework operations on a device/emulator that replicate user-app
  operations (instancing, parameters, presets, state, MIDI/UMP, processing).
- Offline audio rendering and verification against approved reference output.

**Non-goals**
- This is **not** a sequencer/DAW test suite. AAP is a *plugin framework*; the
  operation vocabulary is the AAP API, not a timeline/transport model.
- This is **not** a uapmd-only solution. See §3.

## 3. Guiding principles

1. **The subject under test is the AAP framework** (aap-core, and as needed
   aap-lv2 / aap-ara), exercised against real plugins. A failure must point
   unambiguously at the framework or a plugin — never at the test vehicle.
2. **Our own offline renderer is the backbone, not a fallback.** It is built
   directly on the AAP API (`process()` loop, §9) and depends on *nothing* else —
   no uapmd, no manager graph, no Oboe, no sequencer.
3. **uapmd is opt-in and replaceable.** It may be reused only for genuinely hard
   topologies (DAG fan-out/merge, timeline scheduling) where reimplementing would
   be wasteful — and even there, when uapmd "does not feel safe," we fall back to
   our own renderer. uapmd is never the sole path and never the measure of record.
4. **AAP modules and plugins are downloaded prebuilt by commit — never built
   from source in the test flow.** This includes our own modules (aap-core,
   aap-lv2, aap-ara). Build time must stay minimal. The *only* thing we build is
   our own **test-hosting code** (the host app embedding
   `androidaudioplugin-js-controller`, and test glue) — and only when needed.
   Do not expect everything to come from downloads, but do not build the
   framework or plugins.
5. **No binaries in git** (not even via git-lfs) — neither plugin/module APKs nor
   golden WAVs. They live in a temporary working directory that is **persisted
   and traceable via the GitHub Actions cache**, fetched/regenerated on demand.
6. **No human-authored artifact hashes/metadata.** A human supplies only what is
   meaningful to a human (a repository and a commit). Everything else is derived.

## 4. High-level architecture

This repository is **the** test builder and runner. The whole flow lives here; no
other repo runs these tests.

```
aap-integration-tests  (THE builder + runner; host-managed)
  ├─ catalog parse + environment setup
  │     ├─ build our test-hosting code if needed (instrumented test APK / glue)
  │     └─ download module+plugin APKs (by commit → working dir → adb install)
  │            (plugin APKs ship compose-app → JS controller present)
  ├─ device provider  ──►  an adb-connectable target  (emulator-runner action on CI)
  └─ test driver, either:
        (A) instrumented test  ── runs on device ──┐  AAP API directly
        (B) adb am broadcast (RUN_JS) ─► JS aap.* ─┤  (optional)
                                                    └─ our offline renderer (process() loop)
                                                          │
                                       rendered WAV ── adb pull ──► verification
                                                                     (golden / spectrum)
```

- **Host-managed runner:** all orchestration lives on the host in Node/JS, since
  it parses catalogs, talks to the GitHub API, and drives the device.
- **Device is an abstraction:** the only hard requirement is *an adb target*.
- **On-device execution (§9):** the built path is the **JS controller** via
  `adb shell am broadcast` — available because plugins ship compose-app. Plain
  **instrumented tests** were the original "default" design but are not built.

## 5. Setup catalog

A **setup catalog** is a named, shareable description of an environment to test
against. **Every test references a catalog by name.** It is the unit of
environment setup — there is no global pin file. "Not pinned" means there is no
*repository-global* pin; version selection happens *per-catalog* via the commit
hash on each entry.

A catalog is **simply a list of download entries**. Each entry is a dictionary:

- `repo` — `owner/name` of the source repository.
- `commit` — the commit hash whose CI build produced the artifacts.
- `artifacts` — names of the GitHub Actions artifacts to download.
- `files` — *optional* mapping from source file name (inside the artifact) to
  destination file name. **Default: extract all files.**

```jsonc
// catalogs/<name>.json
[
  {
    "repo": "atsushieno/aap-lv2-mda",
    "commit": "abc123…",
    "artifacts": ["aap-lv2-mda-apk"]
    // no "files" → extract everything in the artifact
  },
  {
    "repo": "atsushieno/aap-lv2-sfizz",
    "commit": "def456…",
    "artifacts": ["aap-lv2-sfizz-apk"],
    "files": { "app-debug.apk": "aap-lv2-sfizz.apk" }   // optional rename/select
  }
]
```

The same uniform shape covers **everything fetched by commit from CI** — our own
modules (aap-core, aap-lv2, aap-ara) *and* plugins. There is no "modules vs.
plugins" distinction in the catalog, and **none of it is built from source**
(principle 4). The sole exception is our own **test-hosting code** (§6), which is
built, not cataloged.

## 6. Host test runner

Responsibilities, in order:

1. Load the named catalog.
2. Build our test-hosting code if needed (the host app embedding
   `androidaudioplugin-js-controller`); download the cataloged module/plugin APKs
   (§7). Do not build the framework or plugins.
3. Acquire plugin APKs (§7) and `adb install` them. Install mode: **skip if the
   device already has the same APK** (checked via SHA-256 stored on device) or
   **force-reinstall** every package (`--reinstall`).
4. Acquire a device via the device provider (§8).
5. Run the test on-device (§9): drive the JS controller via `adb shell am
   broadcast` (RUN_JS / RUN_JS_ASYNC) and read results from the broadcast result
   data. (Path (A) instrumented tests were planned as the default but are not
   built — see §9.)
6. Pull outputs and run verification (§10).
7. Report results (machine-readable; suitable for CI surfacing — JUnit XML +
   artifacts).

## 7. Plugin acquisition (download-by-commit)

The human-authored surface is minimal — repo → commit. Everything else is derived.

**Resolution order** for each plugin (first that exists wins):
1. `plugins/local/<pkg>.apk` — developer's locally-built override (gitignored).
2. cache keyed by `repo@commit` — durable, survives upstream artifact expiry.
3. download from that commit's GitHub Actions artifact → populate cache.

**Download path** (Node + GitHub API), per catalog entry:
- `GET /repos/{owner}/{repo}/actions/runs?head_sha={commit}&status=success`
  → its `/artifacts` → select the artifacts named in the entry → download zip(s).
- Extract per the entry's `files` mapping (rename/select), or **all files** by
  default.
- Derive package name from each APK (`aapt`/`badging`) for the install check.

**APK inspection at acquire-time:** after resolving the host APK (`aaphostsample.apk`),
`acquire.js` opens it as a ZIP and verifies that `assets/aap-api.js` exposes all
required JS API symbols (`addEventUmpInput`, `createGui`, `showGui`, `hideGui`,
`destroyGui`). A missing symbol means the APK was built against an old or
accidentally-reverted aap-core — the failure is caught here with an actionable
message rather than surfacing as a cryptic "does not expose X()" at test time.
Plugin APKs also bundle `aap-api.js` (they depend on `androidaudioplugin-js-controller`)
but are not checked — only the host APK's copy is ever loaded at runtime.

**Why commit-pinning:** upstream plugin builds break at any time and are often
not the first thing fixed. Pinning each test's catalog to a known-good commit
keeps the suite stable; "update" is an explicit, controlled catalog edit, never
an implicit "latest."

**Auth: a PAT with artifact-read scope is provided in CI.** Actions artifacts
require it (releases would not); since GitHub Actions setup comes with a PAT, the
downloader targets Actions artifacts directly.

**Artifact expiry tension:** GitHub Actions artifacts are retained ≤90 days, and
an expired artifact cannot be re-downloaded. The `repo@commit` cache is therefore
the **durable store** — first fetch must happen while the artifact still exists,
after which the cache serves it indefinitely. A pinned commit that is *not cached
and whose artifact has expired* is a hard error ("bump the pin, or re-run upstream
CI for that commit") — never a silent fallback to a different build.

Directory layout — a temporary working dir, **never committed**, persisted across
runs via the **GitHub Actions cache** (principle 5):
```
.work/                # gitignored; restored/saved as an Actions cache
  local/              # developer override APKs
  downloaded/         # resolved current APKs for install
  cache/              # repo@commit -> apk (durable store)
  goldens/            # approved reference output (see §10)
```

## 8. Device provider

A thin seam whose only contract is "produce an adb-connectable target, and tear
it down."

**Acquisition ordering (`auto`, the default):**
1. **Use an existing usable adb target** if one is connected (instant dev loop;
   we did not launch it, so we do not tear it down).
2. **Else, if running on Firebase**, use a ready device setup or create one.
   (Firebase's exact model is still TBD — likely does not fit "serial + dispose";
   see below.)
3. **Else, GMD**: if no setup exists, create one, then launch it and hand its adb
   serial to the runner; dispose kills it.

Step 1 is what keeps this cheap for anyone who connects their own device: they
are served immediately and never reach the memory-heavy GMD launch. Step 3 is the
fallback for everyone who does **not** bring their own device, so it stays
available — not gated away.

Implementations:

- **GMD — the chosen path on GitHub Actions**, set up at build time. We manage
  the AVD/emulator lifecycle ourselves (create-if-missing → boot → wait → expose
  serial → kill on dispose), because the runner is adb-target-centric. *(Strict
  Gradle-owned GMD, where Gradle runs the test task against the device, would be
  a separate execution mode, not a device provider.)* **As built, CI uses the
  `reactivecircus/android-emulator-runner` action** (API 35, `google_apis`,
  x86_64, KVM); our own `gmd` provider is the local fallback and is unvalidated
  on hosted runners.
- **Local** — an already-running emulator or physical device (dev loop / step 1).
- **Firebase Test Lab** — an explicitly named device via `gcloud`; kept for real
  arm64 coverage, not the primary Actions path. Note FTL runs the packaged test
  on a provisioned device and returns results via a bucket rather than a live adb
  serial, so its provider shape is still open.

ABI note: all AAP plugins ship at least `x86_64` and `arm64-v8a`, so an x86_64
emulator can host them — the runner choice is not blocked by ABI.

## 9. On-device execution and operation vocabulary

On-device operations can be driven **two ways**, against the same AAP operation
vocabulary (below). The design intended (A) as the default, but **only (B) is
actually built** — every current case runs through it:

- **(B) JS controller — the implemented path (all current cases).** Drive an
  embedded JS facade via `adb shell am broadcast`. This is available "for free"
  because **every relevant plugin ships with compose-app**, which embeds the
  reusable `androidaudioplugin-js-controller` module — so wherever a plugin is
  installed, the JS entrypoint already exists, with no extra host app to build.
  (The uapmd cases use the parallel `uapmd.*` surface; see below.)
- **(A) Instrumented tests — planned, not built.** The intent was an `androidTest`
  APK (our test-hosting code, §6) driving the AAP host API directly. Nothing of
  this exists yet; it has not been needed.

### (B) JS controller details

Implemented in aap-core as the reusable `androidaudioplugin-js-controller` module
(same protocol shape as uapmd-app's `AutomationReceiver`). It is **not** a
JSON-RPC socket over `adb forward`.

**Transport: `adb shell am broadcast`** to an exported `BroadcastReceiver`
(`AapAutomationReceiver`). The host fires a broadcast carrying a JS string and
reads the result back from the broadcast's result data:

```sh
adb shell am broadcast \
  -a org.androidaudioplugin.js.RUN_JS \
  -n <host.app.package>/org.androidaudioplugin.js.AapAutomationReceiver \
  --es code 'JSON.stringify(aap.ping())'
```

- Actions: `RUN_JS` (sync), `RUN_JS_ASYNC` → job id, `GET_JS_JOB`,
  `CLEAR_JS_JOB`. Code via `--es code` or base64 `code_base64`. Result via
  `setResultData`/`setResultCode`.
- Long scripts that may stall on binder use the async job actions.

**On-device runtime: an embedded JS engine** (`AapAutomationRuntime` + native
`AapJsControllerRuntime`, choc/QuickJS built into the module's native lib — no
WebView, no Chrome), single-threaded. It loads an `aap-api.js` facade exposing
the AAP host vocabulary as `globalThis.aap.*`. **A path-(B) test is therefore a
JS script** evaluated on-device, not an RPC method sequence.

**Provider wiring (per host app):** the receiver is contributed by the module's
manifest (manifest-merge), so depending on the module is enough to expose the
entry points. The app only wires, after its native plugin client is connected:
`AapAutomationRuntime.bootstrap(context)`,
`attachNativeClient(nativePluginClient.native)`, and optionally
`setPluginCatalog(json)`.

**MCP** is not on-device and not required; if wanted it is an *optional host-side*
adapter that translates to these broadcasts/JS.

**Security:** the receiver is exported and runs arbitrary JS against the host's
plugin client — **debug/testing builds only**; release builds should gate or
remove it.

### Operation vocabulary (both paths)

The AAP framework API, from `NativeRemotePluginInstance` and host helpers —
deliberately bounded, no sequencer concepts. Path (A) calls these directly; path
(B) exposes them as `aap.*`:

- **Discovery** — enumerate installed plugin services / plugin information.
- **Lifecycle** — `create(pluginId)` → `prepare` → `activate` → `process` →
  `deactivate` → `destroy`.
- **Ports/buses** — `getPortCount`/`getPort`, `setPortBuffer`/`getPortBuffer`.
- **Parameters** — `getParameterCount`/`getParameter`/`getParameterValue`/
  `getParameterStateRevision`; values set via UMP.
- **Presets** — `getPresetCount`/`setCurrentPresetIndex`/`getPresetName`.
- **State** — `getStateSize`/`getState`/`setState`.
- **MIDI/UMP** — `addEventUmpInput`.
- **GUI** — create/show/hide/resize/destroy (where relevant).
- **Extensions** — `sendExtensionRequest`, `getMidiMappingPolicy`.

The implemented path-(B) facade (`aap-api.js`) currently exposes:
`aap.ping()`, `aap.runtimeInfo()`, `aap.discovery.getPlugins()`,
`aap.instancing.create(pluginId)` → a `PluginInstance` with
`prepare/activate/process/deactivate/destroy`, `getParameterCount/getParameters/
getParameterValue`, preset get/set, and `getState/setState`. Offline
`aap.render.*` is intentionally absent for now (added later on top of this).

**Implemented case types** (all path (B); dispatched by `type` in `src/run.js`):

| Type (`tests/cases/*.json`) | Surface | What it asserts | Status |
|---|---|---|---|
| `connectivity` | aap | `create → prepare → activate → process×N → deactivate → destroy` round-trips | passes |
| `inspect` | aap | param/preset counts read; `getState`/`setState` round-trips | passes |
| `preset` | aap | preset enumeration + selection across sampled indices; logcat-scanned for async service crash | passes |
| `plugin-smoke` | aap | params, presets, MIDI blocks, GUI lifecycle (`createGui/showGui/hideGui`) against many plugins | passes |
| `byod-preset-output` | aap | BYOD plugin preset selection; verifies parameter propagation and audio RMS change | passes |
| `uapmd-aap-ui-routing` | uapmd | UI routing request accepted; plugin instances created at expected track indices | passes |
| `uapmd-byod-preset-values` | uapmd | BYOD preset #9 parameter VALUES propagate correctly through realtime process() path | passes |
| `uapmd-project` | uapmd | new project → add tracks + plugins → save → reload → track count round-trips | passes |
| `uapmd-load-project` | uapmd | load a `.uapmdz` and verify every referenced plugin instantiated | passes |

A "pass" is an **operation-outcome** assertion, not audio verification — the
renderer/golden machinery (below) does not exist yet.

### Our own offline renderer

The backbone capability, built purely on the vocabulary above:

```
prepare → activate
loop over blocks:
    setPortBuffer(inputs)        // audio input from a file; no live capture
    addEventUmpInput(events)     // notes / parameter changes scheduled by sample position
    process(frameCount)
    getPortBuffer(outputs)       // accumulate
deactivate
→ write WAV
```

- **Single instance** and **linear chains** are both driven this way: the output
  port buffer of instance N is fed to the input port buffer of instance N+1.
  "Multiple plugins" does **not** imply uapmd.
- Deterministic: no real-time clock, no Oboe — reproducible per ABI.

### uapmd reuse boundary

| Tier | Topology | Renderer |
|------|----------|----------|
| Ours (default, trustworthy) | single instance, linear chain | our `process()` loop |
| uapmd (opt-in, replaceable) | DAG fan-out/merge, timeline scheduling, project/track model | uapmd, *only when trusted*; else ours |

### uapmd as a second control surface

uapmd-app exposes the **same broadcast protocol** as our js-controller, but with
its own action/receiver (`dev.atsushieno.uapmd.RUN_JS` →
`dev.atsushieno.uapmd/.AutomationReceiver`) and a richer `uapmd.*` facade
(project save/load, `sequencer.addTrack/clearTracks`, `instancing.create(format,
pluginId, trackIndex)`, timeline, render). The runner models these as two
**surfaces** (`aap`, `uapmd`) over one broadcast transport; a uapmd test is a
`uapmd.*` script. This exercises the **uapmd sequencer/project stack on top of
AAP** — e.g. new project → add tracks + plugins → save → reload → verify — while
the trustworthy aap-only path stays the measure of record for the framework
itself. The uapmd-app APK is downloaded by commit like any other artifact
(`uapmd-android-apk`), built by uapmd's `android.yml` against a chosen aap-core.

## 10. Verification and golden output

> **Status: only operation-outcome assertions are implemented.** The golden-WAV
> workflow and tolerant audio comparison below are **not built** — `verify.js`
> exists but no case calls it, and no rendered audio is produced. Everything in
> this section past the "Instancing / Parameters / presets / state" bullets is a
> plan, not current behavior.

A test is a sequence of operations plus assertions on their outcomes:

- **Instancing** — `create`/`prepare`/`activate` succeed; per-node status reported.
- **Parameters / presets / state** — values read back; preset application takes
  effect; state round-trips.
- **Rendered audio** — compared against an approved reference.

**Golden workflow:**
1. First run for a case produces output with no golden → emitted as an artifact,
   marked **pending human approval**. A human judges whether it is normative.
2. Once approved, it becomes the golden for subsequent runs.

**Comparison must be tolerant** — byte-equality will not work (FP nondeterminism,
denormals, device/ABI differences). Compare with per-sample epsilon + RMS error,
and optionally spectral difference. The AAP API also exposes spectrum data, which
can serve as an *alternative* verification primitive where a full golden WAV is
overkill or too brittle.

- **Nondeterministic plugins** (random seeds, internal clocks) need per-case
  loose tolerance or exclusion, flagged in the test definition.
- Goldens are effectively keyed per `(device profile, ABI)`.

**Golden storage:** golden WAVs are **not** committed (principle 5). They live in
`.work/goldens/`, persisted via the GitHub Actions cache like the rest of the
working dir. **[RISK]** the Actions cache is evictable (LRU; 7-day idle; ~10 GB
repo budget), which is weak durability for *normative* references — so keep
goldens small (short / mono / lower sample-rate where adequate), and treat
approval/promotion as a deliberate step whose result must be recoverable (e.g. an
uploaded run artifact) even if the cache entry is evicted.

## 11. CI and result tracking

- **This repo is the sole builder and runner.** No other repo runs these tests
  and there is no cross-repo dispatch — everything (build, setup, run, verify)
  happens in this repo's CI.
- **AAP modules consumed as downloaded artifacts**, by commit, per the catalog
  (§5/§7) — *not* built from source, no submodules, no `publishToMavenLocal`.
  Only our own test-hosting code is built (§6).
- **Device on GitHub Actions: `integration-tests.yml` uses
  `reactivecircus/android-emulator-runner`** (API 35, `google_apis`, x86_64, KVM
  enabled) and drives the runner with `--device auto`. API 35 is deliberate:
  uapmd's Android app has minSdk 31. Our `gmd` provider is the *local* fallback
  and is unvalidated on hosted runners.
- **The default suite is wired into CI.** `integration-tests.yml` runs
  `npm test -- --device auto`. All 9/9 cases pass on a clean run.

### AVD cache strategy

The AVD cache (`~/.android/avd/*`) is keyed **statically** (`avd-api35-google_apis-x86_64`),
not by catalog hash. This keeps the cache useful: if the catalog changes but the
emulator image itself does not, hitting the cache avoids the slow emulator
creation + boot cycle.

Stale installed APKs are handled at the **install step** rather than by busting
the cache:

- After each `adb install`, the SHA-256 of the installed APK is stored on the
  device at `/data/local/tmp/aap-checksums/<package-name>` inside the AVD
  userdata image, so it persists in the cache.
- Before installing, `install.js` computes the staged APK's SHA-256 and compares
  it to the on-device record. Match → skip. Mismatch or no record → reinstall and
  update the record.

This means a catalog pin bump (new APK downloaded) automatically triggers
reinstall on the next run, without touching the AVD cache key.

**Pre-run app-data clear:** `adb shell pm clear dev.atsushieno.uapmd` runs before
every test suite. uapmd autosaves its project on exit; without this clear, state
left by an earlier test (loaded tracks, plugin instances) persists into the next
run and can cause fresh-session tests to fail with stale track indices.

**Escape hatch:** the `workflow_dispatch` input `uninstall_packages` accepts a
space-separated list of package names to uninstall before the run. Rarely needed
now that checksum-based install handles staleness, but useful when the on-device
checksum itself is incorrect or a package needs a clean reinstall from scratch.

- **APK artifact cache** (`.work/cache`) is keyed by `hashFiles('catalogs/*.json')`
  with broad restore keys, so the workflow survives GitHub artifact expiry when
  a previous run has already cached the APKs.
- **PAT** with artifact-read scope is required for downloads (§7), supplied as the
  `AAP_ARTIFACTS_PAT` secret / `GITHUB_TOKEN` / `--token`.
- **Result tracking:** the runner prints human-readable PASS/FAIL and sets a
  non-zero exit on failure. The workflow captures `logcat` and `dumpsys meminfo`
  as `integration-diagnostics` on every run. JUnit XML and rendered WAV artifacts
  remain planned.

## 12. Open questions (consolidated)

- **Execution path** — path (B) JS controller is the only one built and has been
  sufficient. Path (A) instrumented tests were the original "default" but were
  never needed; revisit only if (B) proves insufficient.
- **uapmd reliability** — uapmd cases now pass, but the surface is more fragile
  than the aap-only path (timing sensitivity, autosave state). Treat uapmd cases
  as a useful signal, not a hard gate.

*Resolved:*
- **This repo is the sole builder + runner** (§§4,11).
- On-device execution (§9) — built path is the **JS controller (B)**.
- Catalog schema (§5) — flat list of `{repo, commit, artifacts, files?}`.
- No build-from-source (§§4,6,11).
- CI auth (§7) — PAT with artifact-read scope.
- No binaries in git (§§5,7,10) — `.work/` dir via Actions cache.
- Device on Actions (§8) — `reactivecircus/android-emulator-runner`; GMD is local fallback.
- AVD cache staleness (§11) — SHA-256 checksum on device; `pm clear` for uapmd state.
- All 9/9 cases passing on CI (§13).

## 13. Milestones — done vs. outstanding

**Done:**
1. Runner skeleton + catalog parser + download-by-commit acquisition + `.work/`
   cache + `adb install`, validated against real artifacts.
2. Nine path-(B) case types (§9) with operation-outcome assertions, all passing:
   `connectivity`, `inspect`, `preset`, `plugin-smoke`, `byod-preset-output`,
   `uapmd-aap-ui-routing`, `uapmd-byod-preset-values`, `uapmd-project`,
   `uapmd-load-project`.
3. CI validated on hosted runner (API 35, KVM); repeatable green runs achieved.
4. APK inspection at acquire-time catches stale `aap-api.js` before device touch.
5. SHA-256 checksum-based install skip — correct staleness detection regardless of
   `versionCode`; checksum survives in AVD userdata across cached runs.
6. `pm clear dev.atsushieno.uapmd` before suite — eliminates autosaved project
   state bleed between tests.

**Outstanding (in rough priority order):**
1. **Real audio verification** — build the offline `aap.render.*` renderer (§9) and
   the golden capture/approval + tolerant comparison (§10); only then is this more
   than a smoke/operation gate.
2. **Path (A) instrumented tests** (§9) — optional, if the JS path proves
   insufficient.
3. **Firebase Test Lab** (§8) — real arm64 coverage; provider shape still open.
