#!/usr/bin/env bash
# Uninstall one or more Android packages from a connected device or emulator.
# Mirrors what the CI workflow_dispatch `uninstall_packages` input does on GitHub Actions.
#
# Usage:
#   scripts/uninstall-packages.sh [SERIAL] PACKAGE [PACKAGE ...]
#
#   SERIAL  — optional adb device serial (-s flag). Omit if only one device is connected.
#
# Examples:
#   # Uninstall stale aaphostsample so the next test run installs the current build:
#   scripts/uninstall-packages.sh org.androidaudioplugin.aaphostsample
#
#   # Target a specific emulator:
#   scripts/uninstall-packages.sh emulator-5554 org.androidaudioplugin.aaphostsample

set -euo pipefail

if [[ $# -eq 0 ]]; then
  echo "Usage: $0 [SERIAL] PACKAGE [PACKAGE ...]" >&2
  exit 1
fi

ADB_ARGS=()

# If the first argument looks like an adb serial (contains ':' or 'emulator-'), treat it as one.
if [[ "$1" == *:* || "$1" == emulator-* ]]; then
  ADB_ARGS=(-s "$1")
  shift
fi

if [[ $# -eq 0 ]]; then
  echo "No package names given." >&2
  exit 1
fi

for pkg in "$@"; do
  echo "uninstall $pkg"
  adb "${ADB_ARGS[@]}" uninstall "$pkg" || echo "  (not installed or uninstall failed — continuing)"
done
