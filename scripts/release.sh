#!/bin/bash
# Cut a release: bump the version, write the changelog, commit, tag, push.
#
# This script does NOT build anything. Pushing the tag is what starts the
# build: .github/workflows/release.yml then builds macOS, Linux and Windows on
# their own runners and publishes the GitHub release with every artifact.
#
# That split is not a preference — it is a correctness requirement. The app has
# two compiled native addons (better-sqlite3, lzma-native) and a native addon
# can only be built ON the platform it runs on. The previous version of this
# script ran `electron-builder --win` and `--linux` on macOS after rebuilding
# the addons for macOS, so those artifacts shipped a darwin .node and would
# have crashed on launch. Both lines ended in `|| echo`, so the failure was
# invisible. Do not reintroduce them.
#
# Usage:
#   ./scripts/release.sh                 # patch bump (1.1.1 -> 1.1.2)
#   ./scripts/release.sh minor           # 1.1.1 -> 1.2.0
#   ./scripts/release.sh major           # 1.1.1 -> 2.0.0
#   ./scripts/release.sh 1.5.0           # an explicit version
#
#   ./scripts/release.sh minor --pr      # open a PR instead of pushing to main,
#                                        # for when branch protection forbids a
#                                        # direct push (see docs/RELEASING.md)
#   NO_PUSH=1 ./scripts/release.sh minor # commit + tag locally, push by hand
#
# Requires: a clean working tree, gh (only for --pr).

set -euo pipefail
cd "$(dirname "$0")/.."

RELEASE_BRANCH="${RELEASE_BRANCH:-main}"
GITHUB_REPO="${GITHUB_REPO:-Sarv/Inbox}"

BUMP="patch"
USE_PR="no"
for arg in "$@"; do
  case "$arg" in
    patch | minor | major) BUMP="$arg" ;;
    [0-9]*.[0-9]*.[0-9]*) BUMP="$arg" ;;
    --pr) USE_PR="yes" ;;
    *) echo "ERROR: unknown argument '$arg'" >&2; exit 1 ;;
  esac
done

# ── Preflight ───────────────────────────────────────────────────────────
# Each of these has a failure mode that only shows up after the tag is pushed,
# when it is expensive to undo — so they are all checked before anything moves.

if [[ -n "$(git status --porcelain)" ]]; then
  echo "ERROR: working tree is not clean. Commit or stash first — the release" >&2
  echo "       commit must contain ONLY the version bump and the changelog." >&2
  exit 1
fi

CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$CURRENT_BRANCH" != "$RELEASE_BRANCH" ]]; then
  echo "ERROR: on branch '$CURRENT_BRANCH', expected '$RELEASE_BRANCH'." >&2
  echo "       Set RELEASE_BRANCH=$CURRENT_BRANCH to override." >&2
  exit 1
fi

git fetch --quiet origin "$RELEASE_BRANCH" --tags
if [[ -n "$(git rev-list "HEAD..origin/$RELEASE_BRANCH" 2>/dev/null)" ]]; then
  echo "ERROR: $RELEASE_BRANCH is behind origin. Pull first, or the release will" >&2
  echo "       be cut from a tree that is missing commits." >&2
  exit 1
fi

CURRENT_VERSION=$(node -p "require('./apps/desktop/package.json').version")
case "$BUMP" in
  patch | minor | major)
    NEW_VERSION=$(node -e "
      import('./scripts/lib/changelog.mjs').then(({ bumpVersion }) =>
        process.stdout.write(bumpVersion('$CURRENT_VERSION', '$BUMP')))
    ") ;;
  *) NEW_VERSION="$BUMP" ;;
esac

if git rev-parse -q --verify "refs/tags/v$NEW_VERSION" >/dev/null; then
  echo "ERROR: tag v$NEW_VERSION already exists. Pick a different version." >&2
  exit 1
fi

echo "Releasing $CURRENT_VERSION -> $NEW_VERSION"

# ── Version bump ────────────────────────────────────────────────────────
# Root and desktop are kept in lockstep: electron-builder reads the desktop
# version for the artifact filenames, and vite.config.ts reads it for the
# Sentry release name, so a mismatch makes crash reports unattributable.
node -e "
const fs = require('fs');
for (const file of ['./package.json', './apps/desktop/package.json']) {
  const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
  pkg.version = '$NEW_VERSION';
  fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
  console.log('  ' + file + ' -> $NEW_VERSION');
}
"

# ── Changelog ───────────────────────────────────────────────────────────
# Generated fresh from the commits since the last v* tag. Exits non-zero
# rather than writing an empty section.
GITHUB_REPO="$GITHUB_REPO" node scripts/changelog.mjs write "$NEW_VERSION"

echo ""
echo "Review the entry above — it is the starting point, not the final wording."
echo "Anything you had written under [Unreleased] has been moved into it."
echo "Edit CHANGELOG.md now if you want; the edit lands in the release commit."
if [[ -t 0 ]]; then
  read -rp "Press Enter to commit + tag v$NEW_VERSION (Ctrl-C to abort): " _
fi

# ── Commit + tag ────────────────────────────────────────────────────────
git add package.json apps/desktop/package.json CHANGELOG.md
git commit -q -m "chore(release): $NEW_VERSION"
git tag -a "v$NEW_VERSION" -m "Sarv Inbox $NEW_VERSION"
echo "OK: release commit + tag v$NEW_VERSION created"

if [[ "${NO_PUSH:-}" == "1" ]]; then
  echo ""
  echo "NO_PUSH=1 — nothing pushed. To publish:"
  echo "  git push origin $RELEASE_BRANCH && git push origin v$NEW_VERSION"
  exit 0
fi

# ── Publish ─────────────────────────────────────────────────────────────
# The TAG is what triggers the build, and tags are not subject to branch
# protection — so the tag push works either way. Only the branch push needs a
# bypass, which is what --pr avoids.
if [[ "$USE_PR" == "yes" ]]; then
  PR_BRANCH="release/v$NEW_VERSION"
  git branch "$PR_BRANCH"
  git reset --hard HEAD~1              # leave the protected branch untouched
  git push origin "$PR_BRANCH"
  gh pr create --repo "$GITHUB_REPO" --base "$RELEASE_BRANCH" --head "$PR_BRANCH" \
    --title "chore(release): $NEW_VERSION" \
    --body "Version bump and changelog for $NEW_VERSION.

Merge this, then push the tag to start the build:
\`\`\`
git checkout $RELEASE_BRANCH && git pull
git push origin v$NEW_VERSION
\`\`\`"
  echo ""
  echo "OK: opened a release PR on $PR_BRANCH. The tag v$NEW_VERSION is held"
  echo "    LOCALLY — push it only after the PR is merged:"
  echo "      git push origin v$NEW_VERSION"
  exit 0
fi

echo "Pushing $RELEASE_BRANCH + tag v$NEW_VERSION"
if ! git push origin "$RELEASE_BRANCH"; then
  echo "" >&2
  echo "ERROR: push to $RELEASE_BRANCH was rejected — branch protection is on and" >&2
  echo "       you are not allowed to bypass it. The commit and tag still exist" >&2
  echo "       locally. Either:" >&2
  echo "         • re-run with --pr to route the bump through a pull request, after" >&2
  echo "           'git reset --hard HEAD~1 && git tag -d v$NEW_VERSION'" >&2
  echo "         • or grant your account bypass (see docs/RELEASING.md)" >&2
  exit 1
fi
git push origin "v$NEW_VERSION"

echo ""
echo "========================================"
echo "  Tag v$NEW_VERSION pushed."
echo "  The build is running now:"
echo "  https://github.com/$GITHUB_REPO/actions/workflows/release.yml"
echo ""
echo "  It builds macOS, Linux and Windows, then publishes the release"
echo "  as a DRAFT. Review the artifacts and publish it when ready:"
echo "  https://github.com/$GITHUB_REPO/releases"
echo "========================================"
