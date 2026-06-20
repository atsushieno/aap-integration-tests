# aap-integration-tests — Architecture (DRAFT)

> **Status: DRAFT for review.** Nothing here is implemented yet. Sections marked
> **[OPEN]** are proposals awaiting decision; **[ASSUMPTION]** marks a default I
> picked that should be confirmed or overridden. No code or scaffolding will be
> added to this repository until this document is approved.

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
  ├─ device provider  ──►  an adb-connectable target  (GMD at build time on CI)
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
- **On-device execution (two options, §9):** plain **instrumented tests** calling
  the AAP API directly (default, self-contained), or the **JS controller** via
  `adb shell am broadcast` — available because plugins ship compose-app, but
  **not mandatory**.

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
5. Run the test on-device (§9): either an instrumented test (default), or — if the
   case uses path (B) — drive the JS controller via `adb shell am broadcast`
   (RUN_JS / RUN_JS_ASYNC) and read results from the broadcast result data.
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
vocabulary (below). Neither makes the other mandatory:

- **(A) Instrumented tests (default, self-contained).** An `androidTest` APK we
  build (our test-hosting code, §6) drives the AAP host API directly against the
  installed plugin services. No JS, no broadcast — plain Android instrumentation.
- **(B) JS controller (optional convenience).** Drive an embedded JS facade via
  `adb shell am broadcast`. This is available "for free" because **every relevant
  plugin ships with compose-app**, which embeds the reusable
  `androidaudioplugin-js-controller` module — so wherever a plugin is installed,
  the JS entrypoint already exists, with no extra host app to build.

The JS path is described below for completeness; it is **not** required.

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

**Connectivity smoke (first runnable case).** The simplest test needs no
verification: `create → prepare → activate → process × N → deactivate → destroy`.
`tests/cases/connectivity-mda.json` does exactly this for **MDA DX10** (instrument)
and **MDA Overdrive** (effect) via path (B); a pass just means the round-trip
works. This is what runs end-to-end before the renderer/golden machinery exists.

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
- **Device on GitHub Actions: GMD, set up at build time** (§8 — pending the
  known-risk validation that GMD provisions on hosted runners).
- **Working dir persisted via Actions cache** (downloads, `repo@commit` cache,
  goldens) — keyed so it is reproducible/traceable (§5 principle 5, §7).
- **PAT** with artifact-read scope is available for downloads (§7).
- **Result tracking:** JUnit XML (rendered in the Checks tab) plus uploaded
  artifacts (rendered WAVs, logcat) so failures are inspectable/audible. Nice to
  have, not mandatory.

## 12. Open questions (consolidated)

*(none blocking — see Resolved below)*

Remaining design detail to settle during implementation, not a blocker:
- **Per-case execution choice** — default everything to instrumented tests
  (path A), and reserve the JS controller (path B) for cases where scripting is
  genuinely more convenient. Confirm this default at build-out time.

*Resolved:*
- **This repo is the sole builder + runner** (§§4,11) — no other repo runs these
  tests, no cross-repo dispatch, catalogs live here only.
- On-device execution (§9) — **two paths**: instrumented tests (default) or the
  JS controller (optional). JS is **not mandatory**; plugins ship compose-app so
  the JS entrypoint exists wherever a plugin is installed, with no host app to build.
- Catalog schema (§5) — simple flat list of `{repo, commit, artifacts, files?}`.
- No build-from-source (§§4,6,11) — modules and plugins are downloaded by commit;
  only our own test-hosting code is built.
- CI auth (§7) — a PAT with artifact-read scope is provided.
- No binaries in git (§§5,7,10) — temp `.work/` dir persisted via Actions cache.
- Device on Actions (§8) — GMD set up at build time (with a known risk to validate).

## 13. First milestone (proposed, post-approval)

1. Stand up the runner skeleton + catalog parser + plugin acquisition
   (download-by-commit, working dir, cache) — validated by downloading a real
   plugin APK (e.g. an `aap-lv2-mda` artifact) and `adb install`ing it onto a
   local device. The installed plugin's compose-app already carries the JS
   controller; no host app to build.
2. Drive one instancing + one render case end-to-end with an **instrumented test**
   (path A) plus our offline renderer; optionally smoke-test the JS path (B).
3. Add golden capture/approval + tolerant comparison.
4. Only then: wire GMD-at-build-time into CI and validate it provisions on hosted
   runners (the §8 known risk).
