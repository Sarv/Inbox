#!/bin/bash
# Rebuild and start Sarv Inbox desktop app (clean → build deps → dev)
#
# Usage:
#   sh scripts/dev.sh                     → dev mode on current branch
#   sh scripts/dev.sh prod                → prod mode on current branch
#   sh scripts/dev.sh --branch feature/x  → dev mode, switch to branch first
#   sh scripts/dev.sh prod --branch main  → prod mode on main branch
#
# The --branch flag checks out the given branch (local or remote tracking),
# runs pnpm install to sync deps, then proceeds with the normal build.

set -e
cd "$(dirname "$0")/.."

# ── Parse arguments ──────────────────────────────────────────────────
MODE="dev"
BRANCH=""

while [ $# -gt 0 ]; do
    case "$1" in
        --branch|-b)
            BRANCH="$2"
            shift 2
            ;;
        prod|dev)
            MODE="$1"
            shift
            ;;
        *)
            echo "Unknown argument: $1"
            echo "Usage: sh scripts/dev.sh [dev|prod] [--branch <branch>]"
            exit 1
            ;;
    esac
done

# ── Switch branch if requested ───────────────────────────────────────
if [ -n "$BRANCH" ]; then
    CURRENT=$(git rev-parse --abbrev-ref HEAD)
    if [ "$CURRENT" = "$BRANCH" ]; then
        echo "=== Already on branch '$BRANCH' ==="
    else
        # Abort if there are uncommitted changes that could be lost
        if ! git diff --quiet || ! git diff --cached --quiet; then
            echo "ERROR: You have uncommitted changes. Commit or stash them before switching branches."
            exit 1
        fi

        echo "=== Switching to branch '$BRANCH' ==="
        # Try local branch first, fall back to remote tracking branch
        if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
            git checkout "$BRANCH"
        else
            git fetch origin "$BRANCH" && git checkout -b "$BRANCH" "origin/$BRANCH"
        fi
    fi

    echo "=== Installing dependencies for branch '$BRANCH' ==="
    pnpm install
fi

if [ "$MODE" = "prod" ]; then
    echo "=== Sarv URLs: production (oauth.sarv.com / ai.sarv.com / jpr1-ai-edge.sarv.com) ==="
    # Match a shipped build's log verbosity (release default is 'info'); the dev
    # default 'debug' floods the log with the IMAP command/pool trace. An
    # explicit SARV_LOG_LEVEL at the shell still wins.
    export SARV_LOG_LEVEL="${SARV_LOG_LEVEL:-info}"
    echo "   Log level: $SARV_LOG_LEVEL (override with SARV_LOG_LEVEL=debug|trace)"
else
    echo "=== Sarv URLs: dev (localhost) — pass 'prod' to use production ==="
    # Three separate dev services, on three ports:
    #   :8880  — OAuth server (/api/oauth/*)
    #   :80    — model catalog API (/api/v1/agent-models/*)
    #   :9091  — edge gateway (/edge/v1/llm/*)
    export SARVINBOX_SARV_OAUTH_BASE_URL="${SARVINBOX_SARV_OAUTH_BASE_URL:-http://localhost:8880}"
    export SARVINBOX_SARV_API_BASE_URL="${SARVINBOX_SARV_API_BASE_URL:-http://localhost}"
    export SARVINBOX_SARV_EDGE_BASE_URL="${SARVINBOX_SARV_EDGE_BASE_URL:-http://localhost:9091}"
    # Dev OAuth has a separate public client registered against localhost
    # redirects. Without this, the build falls back to the production
    # client_id baked into oauth-service.ts and the dev server returns
    # "Invalid client credentials" because that production id isn't in
    # its DB. Override at the shell to point at a different dev app.
    export SARVINBOX_SARV_CLIENT_ID="${SARVINBOX_SARV_CLIENT_ID:-client_FbIyNdV1U6GjWQgDsy6eTw}"
    echo "   OAuth: $SARVINBOX_SARV_OAUTH_BASE_URL"
    echo "   API  : $SARVINBOX_SARV_API_BASE_URL"
    echo "   Edge : $SARVINBOX_SARV_EDGE_BASE_URL"
    echo "   Client: $SARVINBOX_SARV_CLIENT_ID"
fi

echo "=== Killing existing processes ==="
pkill -f "electron.*sarvinbox" 2>/dev/null || true
pkill -f "vite.*desktop" 2>/dev/null || true
sleep 1

echo "=== Cleaning stale JS files ==="
pnpm --filter @sarvinbox/desktop run clean

echo "=== Rebuilding better-sqlite3 for Electron ==="
# pnpm may keep better-sqlite3 under the desktop workspace rather than the repo
# root. Probe the known locations directly instead of `find`-ing node_modules:
# on an iCloud-synced checkout every stat under node_modules can block on
# materialising an evicted file, so even a depth-2 walk takes minutes.
BETTER_SQLITE3_DIR=""
for candidate in node_modules/better-sqlite3 apps/desktop/node_modules/better-sqlite3; do
    if [ -d "$candidate" ]; then
        BETTER_SQLITE3_DIR="$candidate"
        break
    fi
done
if [ -z "$BETTER_SQLITE3_DIR" ]; then
    echo "ERROR: could not find better-sqlite3 in node_modules. Run 'pnpm install' first." >&2
    exit 1
fi

# Remove iCloud duplicate dirs ("foo 2") that break electron-rebuild. Scoped to
# the trees the rebuild actually touches — NOT a depth-3 walk of all of
# node_modules: when the checkout lives in iCloud Drive (~/Documents), evicted
# "dataless" files deep in node_modules make that walk block for minutes while
# iCloud materialises them, which looked like the script hanging after "clean".
find "$BETTER_SQLITE3_DIR" packages apps/desktop/electron apps/desktop/src -maxdepth 3 -name '* 2' -type d -exec rm -rf {} + 2>/dev/null || true
# Derive the target from the installed Electron so this never goes stale when
# Electron is upgraded (a hardcoded target rebuilds for the WRONG ABI and the app
# then fails to load the native module — "NODE_MODULE_VERSION mismatch").
ELECTRON_TARGET="$(node -p "require('electron/package.json').version")"
ELECTRON_ARCH="$(node -p "process.arch")"
# `node-gyp rebuild` can silently reuse a stale build/config.gypi (e.g. one left by
# a plain-Node build during `pnpm install`), producing a Node-ABI binary despite
# --runtime=electron. Nuke the build dir so configure regenerates against Electron.
( cd "$BETTER_SQLITE3_DIR" && rm -rf build && npx node-gyp rebuild --runtime=electron --target="$ELECTRON_TARGET" --arch="$ELECTRON_ARCH" --dist-url=https://electronjs.org/headers --release 2>&1 | tail -1 )

echo "=== Building core package ==="
pnpm --filter @sarvinbox/core build

echo "=== Building storage-node package ==="
pnpm --filter @sarvinbox/storage-node build

echo "=== Starting desktop app ==="
cd apps/desktop
npx vite
