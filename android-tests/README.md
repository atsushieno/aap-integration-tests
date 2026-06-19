# android-tests (placeholder)

The Gradle **instrumented-test** project (path A in ARCHITECTURE.md §9): an
`androidTest` APK we build that drives the AAP host API directly against the
plugin services installed by the runner.

> **Status: not scaffolded yet.** This is the one piece of on-device code we
> build (ARCHITECTURE.md §6); the framework and plugins are downloaded, not built.
>
> Note: the JS controller (path B) needs **no** project here — every relevant
> plugin ships compose-app, which already embeds `androidaudioplugin-js-controller`.
