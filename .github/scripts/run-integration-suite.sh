#!/usr/bin/env bash

set +e

mkdir -p .work/ci
adb logcat -c || true

npm test -- --device auto
status=$?

adb logcat -d > .work/ci/logcat.txt || true
adb shell dumpsys meminfo > .work/ci/meminfo.txt || true

exit "$status"
