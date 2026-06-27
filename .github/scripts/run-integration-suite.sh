#!/usr/bin/env bash

set +e

mkdir -p .work/ci
adb logcat -c || true

# Uninstall stale packages from the cached AVD before the test run.
# Set via the workflow_dispatch `uninstall_packages` input (space-separated).
# Useful when a host or plugin APK is stale in the AVD userdata image.
if [[ -n "${UNINSTALL_PACKAGES:-}" ]]; then
  for pkg in $UNINSTALL_PACKAGES; do
    echo "pre-run uninstall: $pkg"
    adb uninstall "$pkg" || true
  done
fi

# Clear uapmd app data so autosaved project state from a previous run doesn't
# bleed into tests that assume a fresh uapmd session (e.g. uapmd-byod-preset-values).
adb shell pm clear dev.atsushieno.uapmd || true

npm test -- --device auto
status=$?

adb logcat -d > .work/ci/logcat.txt || true
adb shell dumpsys meminfo > .work/ci/meminfo.txt || true

exit "$status"
