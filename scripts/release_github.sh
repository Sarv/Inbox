#!/bin/bash
# Release script: bump version → build + sign + notarize macOS → changelog →
# release commit + tag → push → GitHub release with the DMG(s)
#
# Usage:
#   ./scripts/release_github.sh          # patch bump (0.2.0 → 0.2.1)
#   ./scripts/release_github.sh minor    # minor bump (0.2.0 → 0.3.0)
#   ./scripts/release_github.sh major    # major bump (0.2.0 → 1.0.0)
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
#   APPLE_TEAM_ID      Apple Developer Team ID (default LV54AA5562 — not secret,
#                      only echoed in the setup hint)
#   GITHUB_REPO        owner/repo the release is published to (default Sarv/Inbox)
#   NO_PUSH=1          create the release commit + tag but do not push/publish
#   SENTRY_ORG         Sentry org slug; when unset the whole source-map upload
#                      step is skipped
#   SENTRY_PROJECT     Sentry project slug (default sarv-inbox)
#   SENTRY_KC_SERVICE  login-Keychain item holding the Sentry auth token
#                      (default sarvinbox-sentry-token; prompted + saved if missing)

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

# ── Sentry source-map upload (readable production stack traces) ──────────
# The renderer DSN (SARVINBOX_SENTRY_DSN) is baked into the bundle from the
# repo-root .env by Vite at build time — verify it's there so the shipped app
# can actually report. The SENTRY_* vars are BUILD-only and are read straight
# from the environment by @sentry/vite-plugin (see vite.config.ts): with them
# set, minified renderer stacks get symbolicated; without the token, upload is
# skipped and the DMG still builds fine. The token is a SECRET, so — exactly
# like the .p12 password above — it's read from the login Keychain and never
# written to disk or committed.
#
# Opt-in: the whole step is skipped when SENTRY_ORG is unset.
grep -q "^SARVINBOX_SENTRY_DSN=." .env 2>/dev/null \
  || echo "⚠ SARVINBOX_SENTRY_DSN not set in .env — the shipped app won't report to Sentry."
if [[ -z "${SENTRY_ORG:-}" ]]; then
  echo "· Sentry: SENTRY_ORG not set — skipping source-map upload"
else
  : "${SENTRY_PROJECT:=sarv-inbox}"
  : "${SENTRY_KC_SERVICE:=sarvinbox-sentry-token}"
  SENTRY_AUTH_TOKEN=$(security find-generic-password -a "$USER" -s "$SENTRY_KC_SERVICE" -w 2>/dev/null || true)
  if [[ -z "$SENTRY_AUTH_TOKEN" ]]; then
    read -rsp "Sentry auth token (blank to skip source-map upload): " SENTRY_AUTH_TOKEN; echo
    if [[ -n "$SENTRY_AUTH_TOKEN" ]]; then
      security add-generic-password -a "$USER" -s "$SENTRY_KC_SERVICE" -w "$SENTRY_AUTH_TOKEN" -U >/dev/null 2>&1 \
        && echo "✓ Saved Sentry token to your login Keychain (service: $SENTRY_KC_SERVICE)"
    fi
  fi
  export SENTRY_ORG SENTRY_PROJECT
  [[ -n "$SENTRY_AUTH_TOKEN" ]] && export SENTRY_AUTH_TOKEN
  echo "✓ Sentry: org=$SENTRY_ORG project=$SENTRY_PROJECT · source-map upload $([[ -n "$SENTRY_AUTH_TOKEN" ]] && echo enabled || echo skipped)"
fi

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

# NOTE: the version bump is left UNCOMMITTED here on purpose. The release
# commit + tag + push + GitHub release all happen at the END of this script,
# only after the DMG has been built, signed, and notarized — so a failed build
# never leaves a pushed "release" commit or tag with no artifact behind it.

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

# ── Guard: only tag + publish if a signed DMG actually exists ────────────
# The mac build line above is `|| echo` (non-fatal), so a failed build must not
# fall through into a tag/release with no artifact.
shopt -s nullglob
DMGS=("$RELEASE_DIR"/*.dmg)
shopt -u nullglob
if [[ ${#DMGS[@]} -eq 0 ]]; then
  echo "✗ No DMG in $RELEASE_DIR — build/notarize did not produce an artifact."
  echo "  Skipping changelog, tag, and GitHub release. Version bump left uncommitted."
  exit 1
fi

# ── Generate the changelog from commits since the last release tag ───────
# Keep user-facing conventional commits (feat/fix/perf), skip docs, and map
# them to Keep a Changelog headings so the entry matches CHANGELOG.md's style.
# Built FRESH from git each run — never copied from a previous version.
GITHUB_REPO="${GITHUB_REPO:-Sarv/Inbox}"
RELEASE_DATE=$(date -u +%Y-%m-%d)
BASE_TAG=$(git describe --tags --match 'v*' --abbrev=0 2>/dev/null || true)
if [[ -n "$BASE_TAG" ]]; then RANGE="$BASE_TAG..HEAD"; else RANGE="HEAD"; fi
echo ""
echo "=== Generating changelog from commits (${BASE_TAG:-repo start}..HEAD) ==="
[[ -z "$BASE_TAG" ]] && echo "  (no prior v* tag — this first release spans the full history; trim the entry if needed)"

# heading<TAB>description, one line per kept commit (newest first).
PARSED=$(mktemp)
cc_re='^(feat|fix|perf)(\(([^)]+)\))?!?:[[:space:]]+(.+)$'
# tformat: (not format:) so a trailing newline terminates the last/oldest line.
git log $RANGE --no-merges --pretty=tformat:'%H%x09%s' | while IFS=$'\t' read -r hash subj; do
  [[ "$subj" =~ $cc_re ]] || continue
  case "${BASH_REMATCH[3]}" in docs|readme|changelog) continue ;; esac
  # Skip commits whose changes are ONLY docs / markdown.
  files=$(git diff-tree --no-commit-id --name-only -r "$hash")
  only_docs=1
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    [[ "$f" == *.md || "$f" == docs/* ]] || { only_docs=0; break; }
  done <<<"$files"
  [[ -n "$files" && "$only_docs" -eq 1 ]] && continue
  case "${BASH_REMATCH[1]}" in
    feat) heading="Added" ;;
    fix)  heading="Fixed" ;;
    perf) heading="Changed" ;;
  esac
  # Capitalize the first letter of the description for a clean bullet.
  desc="${BASH_REMATCH[4]}"
  printf '%s\t%s%s\n' "$heading" "$(tr '[:lower:]' '[:upper:]' <<<"${desc:0:1}")" "${desc:1}" >> "$PARSED"
done

# Build the section body (Keep a Changelog order: Added, Changed, Fixed).
SECTION=$(mktemp)
if [[ -s "$PARSED" ]]; then
  for heading in Added Changed Fixed; do
    if grep -q "^$heading"$'\t' "$PARSED"; then
      printf '### %s\n' "$heading" >> "$SECTION"
      awk -F'\t' -v h="$heading" '$1==h{print "- " $2}' "$PARSED" >> "$SECTION"
      printf '\n' >> "$SECTION"
    fi
  done
else
  printf '### Changed\n- Maintenance and internal improvements.\n\n' >> "$SECTION"
fi
rm -f "$PARSED"

# Insert a new "## [X.Y.Z] - date" section into CHANGELOG.md (after
# [Unreleased]) and refresh the link refs. Node instead of sed/awk so the edit
# is robust (macOS awk chokes on embedded newlines).
V="$NEW_VERSION" D="$RELEASE_DATE" GH_REPO="$GITHUB_REPO" SECTION="$SECTION" node -e '
  const fs = require("fs");
  const file = "CHANGELOG.md";
  const { V: version, D: date, GH_REPO: repo, SECTION: sectionFile } = process.env;
  const section = fs.readFileSync(sectionFile, "utf8").trimEnd();
  let md = fs.readFileSync(file, "utf8");
  const entry = `## [${version}] - ${date}\n\n${section}\n\n`;
  const ur = md.indexOf("## [Unreleased]");
  if (ur !== -1) {
    const next = md.indexOf("\n## [", ur + 1);
    if (next !== -1) md = md.slice(0, next + 1) + entry + md.slice(next + 1);
    else md = md.trimEnd() + "\n\n" + entry;
  } else {
    md = md.trimEnd() + "\n\n" + entry;
  }
  const base = `https://github.com/${repo}`;
  if (/^\[Unreleased\]:/m.test(md)) {
    md = md.replace(/^\[Unreleased\]:.*$/m, `[Unreleased]: ${base}/compare/v${version}...HEAD`);
  } else {
    md = md.trimEnd() + `\n[Unreleased]: ${base}/compare/v${version}...HEAD\n`;
  }
  const verEsc = version.replace(/\./g, "\\.");
  if (!new RegExp(`^\\[${verEsc}\\]:`, "m").test(md)) {
    md = md.replace(/^(\[Unreleased\]:.*)$/m, `$1\n[${version}]: ${base}/releases/tag/v${version}`);
  }
  fs.writeFileSync(file, md);
  console.log(`✓ CHANGELOG.md updated with [${version}] - ${date}`);
'

# ── Release commit + tag → push → GitHub release with the DMG(s) ─────────
if git rev-parse -q --verify "refs/tags/v$NEW_VERSION" >/dev/null; then
  echo "⚠ Tag v$NEW_VERSION already exists — skipping commit/tag/push/release."
else
  git add package.json apps/desktop/package.json CHANGELOG.md
  git commit -q -m "chore(release): $NEW_VERSION"
  git tag -a "v$NEW_VERSION" -m "Sarv Inbox $NEW_VERSION"
  echo "✓ Created release commit + tag v$NEW_VERSION"

  BRANCH=$(git rev-parse --abbrev-ref HEAD)
  if [[ "${NO_PUSH:-}" == "1" ]]; then
    echo "  (NO_PUSH=1 — not pushing. By hand: git push origin $BRANCH && git push origin v$NEW_VERSION)"
  else
    echo "=== Pushing $BRANCH + tag v$NEW_VERSION to origin ==="
    git push origin "$BRANCH"
    git push origin "v$NEW_VERSION"

    echo "=== Publishing GitHub release v$NEW_VERSION (uploading DMG) ==="
    if command -v gh >/dev/null 2>&1; then
      gh release create "v$NEW_VERSION" "${DMGS[@]}" \
        --repo "$GITHUB_REPO" --title "Sarv Inbox $NEW_VERSION" --notes-file "$SECTION" \
        && echo "✓ Published release v$NEW_VERSION with $(printf '%s ' "${DMGS[@]##*/}")" \
        || echo "⚠ gh release failed — tag is pushed; upload by hand: gh release create v$NEW_VERSION ${DMGS[*]} --repo $GITHUB_REPO"
    else
      echo "⚠ 'gh' CLI not found — tag pushed, but the DMG was NOT uploaded. Install gh, then:"
      echo "    gh release create v$NEW_VERSION ${DMGS[*]} --repo $GITHUB_REPO --title \"Sarv Inbox $NEW_VERSION\""
    fi
  fi
fi
rm -f "$SECTION"

# ── Summary ──
echo ""
echo "════════════════════════════════════════"
echo "  Release $NEW_VERSION complete!"
echo "════════════════════════════════════════"
echo ""
echo "Artifacts in releases/$NEW_VERSION/:"
ls -lh "$RELEASE_DIR"/ 2>/dev/null || echo "  (none found)"
echo ""
