#!/bin/bash
# Seed a clean demo inbox for screenshots/video. Wraps seed-demo-db.mjs and runs
# it under Electron-as-Node, because node_modules/better-sqlite3 is compiled for
# Electron's ABI (electron-rebuild), not plain Node's.
#
# QUIT the desktop app first so it isn't holding the DB. Then:
#   sh scripts/seed-demo.sh
set -e
cd "$(dirname "$0")/.."

ELECTRON="node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
[[ -x "$ELECTRON" ]] || { echo "✗ Electron binary not found at $ELECTRON — run 'pnpm install' first"; exit 1; }

ELECTRON_RUN_AS_NODE=1 "$ELECTRON" scripts/seed-demo-db.mjs "$@"
