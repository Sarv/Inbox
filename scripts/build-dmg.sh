#!/bin/bash
# Build a signed macOS DMG from the CURRENT working tree.
#
# Unlike scripts/release.sh this does NOT bump the version, commit, or push —
# it only produces an installable DMG for testing or manual distribution.
#
# Signing uses a DEDICATED, EPHEMERAL keychain created from your .p12, the same
# approach as SarvTerminal's release.sh. This is what avoids the repeated
# "codesign wants to access key ..." prompts: a Developer ID key sitting in the
# LOGIN keychain has no partition-list entry for /usr/bin/codesign, so macOS
# prompts once per signed binary (~30 of them in an Electron app) and fails with
# errSecInternalComponent when nobody answers. Importing the .p12 with
# `-T /usr/bin/codesign` + `set-key-partition-list` pre-authorizes the key, so
# the whole build signs unattended.
#
# Usage:
#   ./scripts/build-dmg.sh                  # arm64, signed, not notarized
#   ./scripts/build-dmg.sh --arch x64       # Intel
#   ./scripts/build-dmg.sh --arch both      # arm64 + x64
#   ./scripts/build-dmg.sh --notarize       # also submit to Apple + staple
#   ./scripts/build-dmg.sh --out ~/Downloads  # where the finished DMG lands
#
# The finished DMG is named "Sarv Inbox-<version>-<arch>-<UTC timestamp>.dmg".
# The stamp is UTC (per the repo's store-UTC rule) in compact ISO-8601 basic
# form -- 20260907T110000Z -- because ":" is a path separator in Finder and
# would render the name wrong.
#
# Environment (all optional — defaults match the Sarv setup):
#   SARV_P12_PATH    Developer ID Application .p12   (default ~/Downloads/sarv-developerID-application.p12)
#   P12_KC_SERVICE   login-Keychain generic-password item holding the .p12 password (default sarv-terminal-p12)
#   NOTARY_PROFILE   notarytool keychain profile     (default sarv-notary)

set -euo pipefail
cd "$(dirname "$0")/.."
REPO_ROOT="$PWD"

ARCH="arm64"
NOTARIZE="no"
OUT_DIR=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --arch) ARCH="${2:-}"; shift 2 ;;
    --notarize) NOTARIZE="yes"; shift ;;
    --out) OUT_DIR="${2:-}"; shift 2 ;;
    *) echo "✗ unknown option: $1"; exit 1 ;;
  esac
done
case "$ARCH" in
  arm64) BUILDER_ARCH=(--arm64) ;;
  x64)   BUILDER_ARCH=(--x64) ;;
  both)  BUILDER_ARCH=(--arm64 --x64) ;;
  *) echo "✗ --arch must be arm64, x64, or both"; exit 1 ;;
esac

VERSION=$(node -p "require('./apps/desktop/package.json').version")

# ── Credentials — Keychain only, nothing written to disk ─────────────────
: "${SARV_P12_PATH:=$HOME/Downloads/sarv-developerID-application.p12}"
: "${P12_KC_SERVICE:=sarv-terminal-p12}"
: "${NOTARY_PROFILE:=sarv-notary}"

[[ -f "$SARV_P12_PATH" ]] || { echo "✗ .p12 not found at $SARV_P12_PATH (set SARV_P12_PATH)"; exit 1; }

# .p12 password from the login Keychain; prompt + store once if absent.
P12_PASSWORD=$(security find-generic-password -a "$USER" -s "$P12_KC_SERVICE" -w 2>/dev/null || true)
if [[ -z "$P12_PASSWORD" ]]; then
  read -rsp "Password for the .p12 ($SARV_P12_PATH): " P12_PASSWORD; echo
  [[ -z "$P12_PASSWORD" ]] && { echo "✗ .p12 password required"; exit 1; }
  security add-generic-password -a "$USER" -s "$P12_KC_SERVICE" -w "$P12_PASSWORD" -U >/dev/null 2>&1 \
    && echo "✓ Saved .p12 password to your login Keychain (service: $P12_KC_SERVICE)"
fi

# ── Ephemeral signing keychain (no prompts) ──────────────────────────────
BUILD_KC="$HOME/Library/Keychains/sarvinbox-build.keychain-db"
BUILD_KC_PW="sarvinbox-build"
ORIG_KEYCHAINS=$(security list-keychains -d user | sed -e 's/^[[:space:]]*//' -e 's/"//g')
cleanup() {
  # Restore the original search list and remove the throwaway keychain.
  security list-keychains -d user -s $ORIG_KEYCHAINS >/dev/null 2>&1 || true
  security delete-keychain "$BUILD_KC" 2>/dev/null || true
}
trap cleanup EXIT

security delete-keychain "$BUILD_KC" 2>/dev/null || true
security create-keychain -p "$BUILD_KC_PW" "$BUILD_KC"
security set-keychain-settings -lut 21600 "$BUILD_KC"     # don't auto-lock mid-build
security unlock-keychain -p "$BUILD_KC_PW" "$BUILD_KC"
security import "$SARV_P12_PATH" -k "$BUILD_KC" -P "$P12_PASSWORD" \
  -T /usr/bin/codesign -T /usr/bin/productsign
# THE line that stops the prompts: grant codesign non-interactive key access.
security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$BUILD_KC_PW" "$BUILD_KC" >/dev/null
# Put the build keychain FIRST so codesign resolves the identity from it.
security list-keychains -d user -s "$BUILD_KC" $ORIG_KEYCHAINS >/dev/null

SIGN_ID=$(security find-identity -v -p codesigning "$BUILD_KC" | grep -m1 "Developer ID Application" | sed -E 's/.*"(.*)"/\1/')
[[ -z "$SIGN_ID" ]] && { echo "✗ No Developer ID Application identity in the .p12"; exit 1; }
echo "✓ Signing identity (ephemeral keychain): $SIGN_ID"

# electron-builder signs against this keychain/identity instead of the login one.
# CSC_NAME must be the common name WITHOUT the "Developer ID Application: "
# prefix — electron-builder adds the certificate type itself and errors out if
# the prefix is present.
export CSC_KEYCHAIN="$BUILD_KC"
export CSC_NAME="${SIGN_ID#Developer ID Application: }"

# ── Build ────────────────────────────────────────────────────────────────
echo ""
echo "=== Building workspace packages ==="
pnpm --filter @sarvinbox/core build
pnpm --filter @sarvinbox/storage-node build

cd apps/desktop

echo ""
echo "=== Building renderer + main (Vite) ==="
npx tsc
npx vite build

echo ""
echo "=== Rebuilding native deps for Electron ==="
npx electron-rebuild -f -w better-sqlite3

# Build into /tmp: macOS Sequoia attaches file-provider xattrs to paths under
# iCloud/synced folders, and those break codesign with a resource-fork error.
BUILD_DIR="/tmp/sarvinbox-dmg-$VERSION"
rm -rf "$BUILD_DIR"; mkdir -p "$BUILD_DIR"

echo ""
echo "=== Packaging + signing DMG ($ARCH) ==="
npx electron-builder --mac dmg "${BUILDER_ARCH[@]}" --config.directories.output="$BUILD_DIR"

# ── Verify + collect ─────────────────────────────────────────────────────
APP="$BUILD_DIR/mac-arm64/Sarv Inbox.app"
[[ -d "$APP" ]] || APP=$(find "$BUILD_DIR" -maxdepth 2 -name "Sarv Inbox.app" -print -quit)
if [[ -n "$APP" && -d "$APP" ]]; then
  codesign --verify --deep --strict --verbose=2 "$APP"
  echo "OK: $(codesign -dv "$APP" 2>&1 | grep '^Authority' | head -1)"
fi

DIST_DIR="${OUT_DIR:-$REPO_ROOT/release}"
# Expand a leading ~ so `--out ~/Downloads` works when quoted by the caller.
DIST_DIR="${DIST_DIR/#\~/$HOME}"
mkdir -p "$DIST_DIR"

# One stamp for the whole run, so a multi-arch build produces a matching set.
BUILD_STAMP=$(date -u +%Y%m%dT%H%M%SZ)

SHIPPED=()
while IFS= read -r dmg; do
  # "Sarv Inbox-1.1.1-arm64.dmg" -> "Sarv Inbox-1.1.1-arm64-20260907T110000Z.dmg"
  stamped="$(basename "$dmg" .dmg)-$BUILD_STAMP.dmg"
  cp -f "$dmg" "$DIST_DIR/$stamped"
  SHIPPED+=("$DIST_DIR/$stamped")
  echo "✓ DMG: $DIST_DIR/$stamped"
done < <(find "$BUILD_DIR" -maxdepth 1 -name "*.dmg")

[[ ${#SHIPPED[@]} -gt 0 ]] || { echo "✗ electron-builder produced no DMG"; exit 1; }

# ── Notarization (opt-in) ────────────────────────────────────────────────
# Notarize the copy that actually ships: `stapler` writes the ticket INTO the
# file, so stapling the /tmp original would leave the delivered DMG unstapled
# and Gatekeeper would still have to phone home (and would reject it offline).
if [[ "$NOTARIZE" == "yes" ]]; then
  for dmg in "${SHIPPED[@]}"; do
    echo ""
    echo "=== Notarizing $(basename "$dmg") ==="
    xcrun notarytool submit "$dmg" --keychain-profile "$NOTARY_PROFILE" --wait
    xcrun stapler staple "$dmg"
    # Verify what Gatekeeper will actually judge. Do NOT run spctl on the .dmg
    # itself: electron-builder does not code-sign the disk image, so spctl
    # reports "no usable signature" even on a perfectly notarized build. The
    # meaningful checks are the stapled ticket on the DMG and an assessment of
    # the .app inside it, which must say "source=Notarized Developer ID".
    xcrun stapler validate "$dmg" >/dev/null && echo "  OK: notarization ticket stapled"
    MOUNT_POINT=$(hdiutil attach "$dmg" -nobrowse -readonly | grep -o '/Volumes/.*' | head -1)
    if [[ -n "$MOUNT_POINT" ]]; then
      spctl -a -vvv "$MOUNT_POINT/Sarv Inbox.app" 2>&1 | head -3 || true
      hdiutil detach "$MOUNT_POINT" -quiet || true
    fi
    echo "✓ Notarized + stapled: $dmg"
  done
fi

echo ""
echo "Done — version $VERSION (build $BUILD_STAMP)"
