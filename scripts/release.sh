#!/bin/bash
# Release script: bump version → commit → push → build macOS → save to /releases
#
# Usage:
#   ./scripts/release.sh          # patch bump (0.2.0 → 0.2.1)
#   ./scripts/release.sh minor    # minor bump (0.2.0 → 0.3.0)
#   ./scripts/release.sh major    # major bump (0.2.0 → 1.0.0)
#
# Required environment — the script exits immediately with a message if any
# of these is unset or empty (macOS only: uses `security` and `xcrun`):
#   SARV_P12_PATH    path to your "Developer ID Application" certificate (.p12)
#   P12_KC_SERVICE   name of the login-Keychain generic-password item that holds
#                    the .p12 password (prompted for and saved on first run)
#   NOTARY_PROFILE   notarytool keychain profile to notarize with; create once:
#                      xcrun notarytool store-credentials "$NOTARY_PROFILE" \
#                        --apple-id <apple-id> --team-id <team-id> --password <app-specific-pw>
# Optional:
#   APPLE_TEAM_ID    Apple Developer Team ID (default LV54AA5562 — not secret,
#                    only echoed in the setup hint)

set -e
cd "$(dirname "$0")/.."

BUMP_TYPE="${1:-patch}"

if [[ "$BUMP_TYPE" != "patch" && "$BUMP_TYPE" != "minor" && "$BUMP_TYPE" != "major" ]]; then
  echo "Usage: $0 [patch|minor|major]"
  exit 1
fi

# ── Signing + notarization credentials ────────────────────────────────────
# All three come from the environment (see the header). Nothing is written to
# disk in plaintext: electron-builder signs from the .p12 (CSC_LINK) and
# notarization reads the Keychain profile only.
#   • .p12 file            $SARV_P12_PATH
#   • .p12 password        login Keychain, generic-password service $P12_KC_SERVICE
#   • notarytool profile   $NOTARY_PROFILE
: "${APPLE_TEAM_ID:=LV54AA5562}"      # not secret; only used in the setup hint

# Fail fast with a clear message when a required env var is unset or empty.
require_env() {
  local name="$1" what="$2"
  [[ -n "${!name:-}" ]] || { echo "✗ $name is not set — $what (see the header of $0)" >&2; exit 1; }
}
require_env SARV_P12_PATH  "path to your Developer ID Application .p12"
require_env P12_KC_SERVICE "login-Keychain service name that holds the .p12 password"
require_env NOTARY_PROFILE "notarytool keychain profile name"

[[ -f "$SARV_P12_PATH" ]] || { echo "✗ .p12 not found at $SARV_P12_PATH (check SARV_P12_PATH)"; exit 1; }

# .p12 password from the login Keychain — prompt + store once if it's missing.
CSC_KEY_PASSWORD=$(security find-generic-password -a "$USER" -s "$P12_KC_SERVICE" -w 2>/dev/null || true)
if [[ -z "$CSC_KEY_PASSWORD" ]]; then
  read -rsp "Password for the .p12 ($SARV_P12_PATH): " CSC_KEY_PASSWORD; echo
  [[ -z "$CSC_KEY_PASSWORD" ]] && { echo "✗ .p12 password required"; exit 1; }
  security add-generic-password -a "$USER" -s "$P12_KC_SERVICE" -w "$CSC_KEY_PASSWORD" -U >/dev/null 2>&1 \
    && echo "✓ Saved .p12 password to your login Keychain (service: $P12_KC_SERVICE)"
fi

# electron-builder signs the .app straight from this .p12 (it creates its own
# throwaway keychain, so no login-keychain prompts).
export CSC_LINK="$SARV_P12_PATH"
export CSC_KEY_PASSWORD

echo "✓ Signing ready — .p12: $SARV_P12_PATH · notary profile: $NOTARY_PROFILE · team: $APPLE_TEAM_ID"
echo "  (first time only, create the notary profile once:"
echo "     xcrun notarytool store-credentials $NOTARY_PROFILE --apple-id <apple-id> --team-id $APPLE_TEAM_ID --password <app-specific-pw>)"

# ── Read current version ──
ROOT_VERSION=$(node -p "require('./package.json').version")
DESKTOP_VERSION=$(node -p "require('./apps/desktop/package.json').version")
echo "Current versions: root=$ROOT_VERSION desktop=$DESKTOP_VERSION"

# ── Bump version ──
IFS='.' read -r MAJOR MINOR PATCH <<< "$DESKTOP_VERSION"
case "$BUMP_TYPE" in
  major) MAJOR=$((MAJOR + 1)); MINOR=0; PATCH=0 ;;
  minor) MINOR=$((MINOR + 1)); PATCH=0 ;;
  patch) PATCH=$((PATCH + 1)) ;;
esac
NEW_VERSION="$MAJOR.$MINOR.$PATCH"
echo "Bumping to: $NEW_VERSION"

# ── Update version in package.json files ──
node -e "
const fs = require('fs');
for (const f of ['./package.json', './apps/desktop/package.json']) {
  const pkg = JSON.parse(fs.readFileSync(f, 'utf8'));
  pkg.version = '$NEW_VERSION';
  fs.writeFileSync(f, JSON.stringify(pkg, null, 2) + '\n');
  console.log('Updated ' + f + ' → $NEW_VERSION');
}
"

# ── Commit and push ──
echo ""
echo "=== Committing version bump ==="
git add package.json apps/desktop/package.json
git commit -m "bump version to $NEW_VERSION"
echo ""
echo "=== Pushing to remote ==="
git push

# ── Clean and build dependencies ──
echo ""
echo "=== Cleaning ==="
cd apps/desktop
pnpm run clean
cd ../..

# Remove iCloud duplicate dirs that break builds
find node_modules packages -maxdepth 3 -name '* 2' -type d -exec rm -rf {} + 2>/dev/null || true

echo "=== Building core ==="
pnpm --filter @sarvinbox/core build

echo "=== Building storage-node ==="
pnpm --filter @sarvinbox/storage-node build

# ── Prep native deps for electron-builder ──
cd apps/desktop

# ── Build renderer (Vite) ──
echo ""
echo "=== Building renderer ==="
npx vite build

# ── Build for all platforms ──
# Build to /tmp to avoid macOS Sequoia file-provider xattrs that break codesign
BUILD_DIR="/tmp/sarvinbox-release-$NEW_VERSION"
rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR"

# Rebuild native deps before each platform to prevent cross-contamination
rebuild_native_deps() {
  echo "  → Rebuilding native deps for $1..."
  npx electron-rebuild -f -w better-sqlite3
}

echo ""
echo "=== Building + signing macOS (arm64 + x64) ==="
rebuild_native_deps "macOS"
# electron-builder signs from CSC_LINK/CSC_KEY_PASSWORD. It does NOT notarize
# (mac.notarize is false in package.json) — we notarize below with the
# $NOTARY_PROFILE Keychain profile so no Apple ID / password touches disk.
npx electron-builder --mac --config.directories.output="$BUILD_DIR/mac" 2>&1 || echo "⚠ macOS build failed"

# ── Notarize + staple each DMG with the Keychain profile ─────────────────
echo ""
echo "=== Notarizing macOS DMGs with profile '$NOTARY_PROFILE' (a few min each) ==="
while IFS= read -r dmg; do
  [[ -f "$dmg" ]] || continue
  echo "  → notarizing $(basename "$dmg")"
  if xcrun notarytool submit "$dmg" --keychain-profile "$NOTARY_PROFILE" --wait; then
    xcrun stapler staple "$dmg" && echo "  ✓ stapled $(basename "$dmg")"
  else
    echo "  ⚠ notarization failed for $(basename "$dmg") — is the '$NOTARY_PROFILE' profile set up?"
  fi
done < <(find "$BUILD_DIR/mac" -name '*.dmg' 2>/dev/null)

echo ""
echo "=== Building Windows ==="
rebuild_native_deps "Windows"
npx electron-builder --win --config.directories.output="$BUILD_DIR/win" 2>&1 || echo "⚠ Windows build failed (may need wine or Windows)"

echo ""
echo "=== Building Linux ==="
rebuild_native_deps "Linux"
npx electron-builder --linux --config.directories.output="$BUILD_DIR/linux" 2>&1 || echo "⚠ Linux build failed (may need to run on Linux)"

cd ../..

# ── Copy artifacts to project releases dir and Desktop ──
RELEASE_DIR="releases/$NEW_VERSION"
mkdir -p "$RELEASE_DIR"
find "$BUILD_DIR" \( -name '*.dmg' -o -name '*.zip' \) -exec cp {} "$RELEASE_DIR/" \; 2>/dev/null || true

# ── Summary ──
echo ""
echo "════════════════════════════════════════"
echo "  Release $NEW_VERSION complete!"
echo "════════════════════════════════════════"
echo ""
echo "Artifacts in releases/$NEW_VERSION/:"
ls -lh "$RELEASE_DIR"/ 2>/dev/null || echo "  (none found)"
echo ""
