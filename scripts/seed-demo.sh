#!/bin/bash
# Seed a clean demo inbox for screenshots/video. Wraps seed-demo-db.mjs and runs
# it under Electron-as-Node, because node_modules/better-sqlite3 is compiled for
# Electron's ABI (electron-rebuild), not plain Node's.
#
# QUIT the desktop app first so it isn't holding the DB. Then:
#   sh scripts/seed-demo.sh
set -e
cd "$(dirname "$0")/.."

# The Electron binary sits at a different path on each OS, and the postinstall
# step renames the macOS one to brand the dock tile ("Sarv Inbox Dev"), so the
# stock name is not guaranteed either. `electron`'s own path.txt records whatever
# the current name is — read that first and fall back to the per-platform
# defaults. Hardcoding the macOS path, as this script used to, made it fail on
# Windows and Linux with a misleading "run pnpm install" message.
ELECTRON_DIR="node_modules/electron"
PATH_TXT="$ELECTRON_DIR/path.txt"

ELECTRON=""
if [ -f "$PATH_TXT" ]; then
    ELECTRON="$ELECTRON_DIR/dist/$(cat "$PATH_TXT")"
fi

if [ ! -x "$ELECTRON" ]; then
    for candidate in \
        "$ELECTRON_DIR/dist/Electron.app/Contents/MacOS/Electron" \
        "$ELECTRON_DIR/dist/electron.exe" \
        "$ELECTRON_DIR/dist/electron"; do
        if [ -x "$candidate" ]; then
            ELECTRON="$candidate"
            break
        fi
    done
fi

if [ ! -x "$ELECTRON" ]; then
    echo "✗ Electron binary not found under $ELECTRON_DIR/dist — run 'pnpm install' first" >&2
    exit 1
fi

ELECTRON_RUN_AS_NODE=1 "$ELECTRON" scripts/seed-demo-db.mjs "$@"
