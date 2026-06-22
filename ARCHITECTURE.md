# aap-integration-tests — Architecture

> **Status: early and unstable. Nothing here has reliably worked end-to-end.**
> The code below exists and individual cases have been made to pass *once*, on a
> single connected device, but only after chasing a chain of real bugs in
> aap-core, aap-juce, and uapmd. Treat every "implemented" mark as "the code path
> exists," **not** "it works dependably." This document describes the design and
> flags both what is built and how fragile it currently is. The original draft
> predated the code; it has been reconciled with what was actually built — and with
> how poorly it holds together so far.

## Stability caveat (read this first)

This suite has **not** demonstrated a stable, repeatable green run. Concretely:

- **Every passing case so far required fixing framework/plugin bugs first**, not
  just running the harness. Examples surfaced *by* this suite: a JUCE
  message-thread / `Looper.prepare()` crash on preset/state/parameter access (an
  aap-juce JUCE patch that silently wasn't applied); uninitialized
  `aap_preset_t` buffers producing garbage preset names in aap-core; a uapmd
  main-thread deadlock on plugin instantiation and project save/load. All of
  these fixes are committed but **those AI fixes are not reliable enough and need further polish**.
- **The uapmd cases (`uapmd-project`, `uapmd-load-project`) have never passed.**
  A deadlock was diagnosed and a fix written in uapmd source, but it has not yet
  been rebuilt/re-tested.
- **CI has never been validated.** The workflow exists but has only ever been
  exercised ad hoc against a *connected* device. The hosted-emulator path
  (KVM + `reactivecircus/android-emulator-runner`, or our own GMD) is unproven,
  and it depends on prerequisites that can silently break a run (a cross-repo PAT
  secret; catalog commit pins whose CI artifacts expire after ~90 days).
- **No audio is actually verified.** The offline renderer and golden-WAV
  comparison were never built; `verify.js` is unused scaffolding. Current cases
  assert only operation outcomes (instancing succeeds, params/presets/state read
  back, track counts round-trip).
- Results are **device/plugin/timing sensitive** and have shown ordering and
  async-timing fragility (e.g. `clearTracks` leaving stale state; async
  instantiation completing after the assertion reads).

In short: this is a scaffold that has *caught* real bugs, which is its current
value — not a dependable regression gate yet.

## Implementation status (at a glance)

"Code path exists" ≠ "works reliably." See the stability caveat above.

| Area | Code path | Reliability |
|------|-----------|-------------|
| Host runner (`src/cli.js`, `src/run.js`) — catalog → acquire → device → install → run | exists | works on a connected device |
| Catalog + download-by-commit + `.work/` cache (`acquire.js`, `catalog.js`, `paths.js`) | exists | works; fragile to artifact expiry/PAT |
| Install (`install.js`): skip-if-installed, `--reinstall`, `-t -g`, signature-mismatch reinstall | exists | works |
| Device providers (`src/device/`): `auto`, `local`, `gmd`, `firebase` | exists | `local`/`auto` used; `gmd` unproven on CI; `firebase` a stub |
| On-device path **(B)** JS controller over `adb am broadcast` — all current cases use this | exists | works for aap cases; uapmd surface deadlocks (fix pending) |
| Case types: `connectivity`, `inspect`, `preset` | exist | pass *now*, after framework fixes |
| Case types: `uapmd-project`, `uapmd-load-project` | exist | **never passed** (uapmd deadlock; fix unverified) |
| CI: `integration-tests.yml` (emulator + default suite), `unit-tests.yml` | exist | **never validated on a hosted runner** |
| On-device path **(A)** instrumented tests | — | planned, not built |
| Offline renderer (`aap.render.*`) + golden WAV verification (`verify.js`) | scaffold only | **no case uses it** |

The remaining design narrative below stays close to the original intent. Where the
build diverged or a piece is not yet implemented (or not yet trustworthy), it is
called out inline.

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

- **Host-managed runner:** all orchestration lives on the host. Language is
  flexible; **[ASSUMPTION]** Node/JS, since it parses catalogs, talks to the
  GitHub API, and drives the device.
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

Open points for this section:
- Whether catalogs are shared only within this repo, or across repos.
- Naming: uapmd already uses "catalog" for the scanned **plugin registry**
  (`PluginCatalogEntry`). Our **setup catalog** is a different concept; keep the
  names distinct to avoid permanent confusion.

## 6. Host test runner

Responsibilities, in order:

1. Load the named catalog.
2. Build our test-hosting code if needed (the host app embedding
   `androidaudioplugin-js-controller`); download the cataloged module/plugin APKs
   (§7). Do not build the framework or plugins.
3. Acquire plugin APKs (§7) and `adb install` them. Install mode is a run-time
   option: **skip if already installed** (default; checked via `adb`) or
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
- Derive package name / `versionCode` from each APK (`aapt`/`badging`) for the
  install-skip check.

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
  a separate execution mode, not a device provider.)* **[RISK]** aap-core's
  `build.yml` has GMD tests *disabled* because the emulator snapshot failed on
  hosted runners — this lifecycle must be validated there.
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
  this exists yet; it remains the original "default" only on paper.

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
| `connectivity` (`connectivity-mda`) | aap | `create → prepare → activate → process×N → deactivate → destroy` round-trips | passes now |
| `inspect` (`inspect-mda`) | aap | param/preset counts read; `getState`/`setState` round-trips | passes now |
| `preset` (`wavetable-preset`) | aap | preset enumeration + selection across sampled indices; **logcat-scanned for an async service crash** (the JUCE/Looper bug this caught) | passes now (after the aap-juce + aap-core fixes) |
| `uapmd-project` (`uapmd-project-mda`) | uapmd | new project → add tracks + plugins → save → reload → track count round-trips | **never passed** (uapmd deadlock) |
| `uapmd-load-project` (`project4-load`) | uapmd | load a `.uapmdz` and verify every referenced plugin instantiated | **never passed** (uapmd deadlock) |

A "pass" here is an **operation-outcome** assertion, not audio verification — the
renderer/golden machinery (below) does not exist yet. Note the `preset` case is
deliberately defensive: the crash it targets is *asynchronous* to the host call,
so the case clears logcat, runs, then scans the plugin service's process for a
native abort — a host-side "OK" alone is not a pass.

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
- **Device on GitHub Actions: as built, `integration-tests.yml` uses
  `reactivecircus/android-emulator-runner`** (API 35, `google_apis`, x86_64, KVM
  enabled) and drives the runner with `--device auto`, which reuses that
  emulator. API 35 is deliberate: uapmd's Android app has minSdk 31, so the
  previous API 30 setup could not install the app. This differs from the original
  "our own GMD at build time" plan; our `gmd` provider is the *local* fallback
  and is **unvalidated on hosted runners**. **This CI path has never been
  confirmed green** — see the stability caveat.
- **The default suite is wired into CI.** `integration-tests.yml` runs
  `npm test -- --device auto`, so CI attempts the same case matrix as a local
  one-command run. This is intentionally factual, not aspirational: if uapmd
  cases still fail or plugins are dropped, the workflow should report that
  failure rather than hiding it behind a connectivity-only subset.
- **APK artifact cache persisted via Actions cache** (`.work/cache`) — keyed by
  catalog files with broad restore keys so the workflow can survive GitHub
  artifact expiry when a previous run has already cached the APKs. Downloaded
  staging (`.work/downloaded`) is intentionally rebuilt each run from cache/local
  inputs.
- **PAT** with artifact-read scope is required for downloads (§7), supplied as the
  `AAP_ARTIFACTS_PAT` secret / `GITHUB_TOKEN` / `--token`. A missing or
  insufficiently-scoped PAT silently fails acquisition.
- **Result tracking:** the runner currently prints human-readable PASS/FAIL and
  sets a non-zero exit on failure. The workflow captures `logcat` and `dumpsys
  meminfo` as `integration-diagnostics` on every run. JUnit XML and rendered WAV
  artifacts remain planned.

## 12. Open questions (consolidated)

The real blockers are in the stability caveat (top) and §13. Design points still
open:
- **Execution path** — in practice **path (B) JS controller is the only one built**
  and it has been sufficient. Path (A) instrumented tests were the original
  "default" but were never needed/built; revisit only if (B) proves insufficient.
- **uapmd reliability** — whether the uapmd surface can be made dependable enough
  to gate on, or stays an opt-in/non-blocking signal (see §3, and the deadlock
  noted in the stability caveat).

*Resolved:*
- **This repo is the sole builder + runner** (§§4,11) — no other repo runs these
  tests, no cross-repo dispatch, catalogs live here only.
- On-device execution (§9) — built path is the **JS controller (B)**; instrumented
  tests (A) were planned as default but never built. Plugins ship compose-app so
  the JS entrypoint exists wherever a plugin is installed, with no host app to build.
- Catalog schema (§5) — simple flat list of `{repo, commit, artifacts, files?}`.
- No build-from-source (§§4,6,11) — modules and plugins are downloaded by commit;
  only our own test-hosting code is built.
- CI auth (§7) — a PAT with artifact-read scope is provided.
- No binaries in git (§§5,7,10) — temp `.work/` dir persisted via Actions cache.
- Device on Actions (§8) — **as built, the emulator-runner action** (not our own
  GMD); the GMD provider is the local fallback and remains unvalidated on CI.

## 13. Milestones — done vs. outstanding

**Done (built; works on a connected device, modulo the stability caveat):**
1. Runner skeleton + catalog parser + download-by-commit acquisition + `.work/`
   cache + `adb install`, validated against real `aap-lv2-mda` / `aaphostsample`
   artifacts. The installed plugins' compose-app carries the JS controller; no
   host app to build.
2. Five path-(B) case types (§9) with operation-outcome assertions. The `aap`
   cases (`connectivity`, `inspect`, `preset`) pass after fixing the framework
   bugs they surfaced.

**Outstanding (in rough priority order):**
1. **Make the uapmd cases pass** — land + verify the uapmd app-thread deadlock fix
   (instancing/save/load), then confirm `uapmd-project` and `project4-load` green.
2. **Make CI trustworthy** — actually run the workflow on a hosted runner and
   confirm the emulator path works with the full default suite.
3. **Real audio verification** — build the offline `aap.render.*` renderer (§9) and
   the golden capture/approval + tolerant comparison (§10); only then is this more
   than a smoke/operation gate.
4. **Path (A) instrumented tests** (§9) — optional, if the JS path proves
   insufficient.
5. **Stabilize** — chase the async/ordering fragilities (e.g. `clearTracks` stale
   state) so runs are repeatable, not one-shot.
