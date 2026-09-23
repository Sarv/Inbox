# Releasing Sarv Inbox

Cutting a release is one command. Everything else — building macOS, Linux and
Windows, signing, notarizing, publishing — happens in GitHub Actions.

```bash
./scripts/release.sh minor      # or patch / major / an explicit 1.5.0
```

That bumps the version, writes the changelog from your commits, commits, tags,
and pushes. Pushing the tag starts
[`.github/workflows/release.yml`](../.github/workflows/release.yml), which
publishes a **draft** release with every artifact attached. You review it and
click publish.

---

## Why the build is not local

The app has two compiled native addons — `better-sqlite3` and `lzma-native` —
and **a native addon can only be built on the platform it will run on.** There
is no flag that changes this.

The previous release script ran `electron-builder --win` and `--linux` on a Mac
after rebuilding the addons for macOS. Those artifacts shipped a darwin `.node`
and would have crashed on launch for every Linux and Windows user. Both lines
ended in `|| echo`, so the failure printed a warning and the script carried on
to publish. Do not reintroduce that pattern.

macOS is the single exception to the per-platform rule: Xcode ships both the
arm64 and x64 SDKs, so one macOS runner legitimately produces both Mac arches.

## What a release produces

| Runner | Artifacts |
| --- | --- |
| `macos-latest` | `.dmg` and `.zip`, arm64 + x64, signed and notarized |
| `ubuntu-latest` | `.deb`, `.rpm`, `.AppImage`, `.tar.gz` — x64 |
| `ubuntu-24.04-arm` | the same four — arm64 |
| `windows-latest` | NSIS installer `.exe` and a portable `.exe` — x64 |

`.deb` covers Debian, Ubuntu, Mint and Pop!\_OS; `.rpm` covers Fedora, RHEL and
openSUSE; the AppImage runs on anything else without installing.

> **Linux arm64 needs the free arm runners, which require the repository to be
> public.** While the repo is private that matrix entry fails; either make the
> repo public first (see [GITHUB-SETUP.md](./GITHUB-SETUP.md)) or drop the
> `linux-arm64` entry until you do.

## One-time setup

### 1. Repository secrets

**Settings → Secrets and variables → Actions → New repository secret.**

#### macOS signing and notarization

Without these the macOS build still runs but produces an **unsigned** app that
Gatekeeper blocks. The workflow warns loudly in the log rather than failing, so
check the log on your first run.

| Secret | How to get it |
| --- | --- |
| `APPLE_CERTIFICATE_P12` | base64 of your Developer ID Application `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | the password you set when exporting the `.p12` |
| `APPLE_ID` | the Apple ID that owns the Developer account |
| `APPLE_APP_SPECIFIC_PASSWORD` | generate at <https://appleid.apple.com> → Sign-In and Security → App-Specific Passwords |
| `APPLE_TEAM_ID` | Apple Developer → Membership (e.g. `LV54AA5562`) |

To produce the base64 value — note `pbcopy`, so the certificate never lands in
a file or your shell history:

```bash
base64 -i ~/Downloads/sarv-developerID-application.p12 | pbcopy
```

Paste that as the secret value. `CSC_LINK` accepts base64 directly, so the
certificate is never written to the runner's disk.

#### Application secrets

`vite.config.ts` inlines these into the shipped bundle at build time. **Without
them the published app has no Gmail sign-in and no crash reporting** — it builds
and runs fine, so this failure is invisible until a user tries to sign in.

| Secret | Effect if missing |
| --- | --- |
| `SARVINBOX_GOOGLE_CLIENT_ID` | Gmail OAuth unavailable |
| `SARVINBOX_GOOGLE_CLIENT_SECRET` | Gmail OAuth unavailable |
| `SARVINBOX_SENTRY_DSN` | no crash reports from released builds |
| `SENTRY_ORG`, `SENTRY_PROJECT`, `SENTRY_AUTH_TOKEN` | stack traces stay minified (optional) |

> The Google client secret is inlined into a bundle that anyone can unpack. That
> is expected for an installed desktop app — Google's own documentation treats
> the installed-app client secret as non-confidential — but it does mean it is
> effectively public once you ship. Use a client dedicated to the desktop app,
> never one shared with a web property.

### 1b. Your local `.env` vs. repository secrets

Your `.env` is **not** what CI builds from — it is gitignored and never leaves
your machine. Only these of its keys have to be re-entered as repository
secrets; the rest are deliberately not needed:

| Local `.env` key | Add as a secret? | Why |
| --- | --- | --- |
| `SARVINBOX_GOOGLE_CLIENT_ID` | Yes | inlined into the bundle; no Gmail sign-in without it |
| `SARVINBOX_GOOGLE_CLIENT_SECRET` | Yes | same |
| `SARVINBOX_SENTRY_DSN` | Yes | no crash reports without it |
| `SENTRY_ORG`, `SENTRY_PROJECT`, `SENTRY_AUTH_TOKEN` | Optional | only for symbolicated stack traces |
| `SARVINBOX_SARV_CLIENT_ID` | No | `oauth-service.ts` falls back to `SARV_PRODUCTION_CLIENT_ID`, which is what a distributed build must use |
| `SARVINBOX_SARV_*_BASE_URL` | No | dev-only overrides; production defaults are compiled in |
| `SARV_LOG_LEVEL` | No | a local debugging knob |

Set them without putting a value in your shell history — `gh` reads the value
from stdin or prompts for it:

```bash
gh secret set SARVINBOX_GOOGLE_CLIENT_ID --repo Sarv/Inbox        # prompts
base64 -i ~/Downloads/sarv-developerID-application.p12 \
  | gh secret set APPLE_CERTIFICATE_P12 --repo Sarv/Inbox
gh secret list --repo Sarv/Inbox
```

Uploading the whole `.env` is not dangerous — `release.yml` passes only the six
secrets it names onto the build, so anything else is stored but never reaches a
workflow. It is still worth being deliberate: every stored secret is one more
thing a compromised workflow could print, and a dev-only value sitting in the
list invites someone later to wire it into the build, which would point a
released app at a development endpoint.

### 1c. What the secrets are protected by

- Secrets are encrypted at rest and **write-only** — nobody, including you, can
  read one back through the UI or API. Values are masked in logs.
- **Pull requests from forks get no secrets at all.** That is why the repo can
  be public: a drive-by PR cannot reach the signing certificate. Never add a
  `pull_request_target` workflow, which is precisely the hole that removes this
  protection.
- **Anyone with write access can read a secret** by pushing a workflow that
  prints it. Write access IS secret access, so keep the writer list small and
  require review on `.github/workflows/**`; see
  [GITHUB-SETUP.md](./GITHUB-SETUP.md).
- The release runs on a `v*` tag push, so restrict who can create those tags
  (the tag ruleset in GITHUB-SETUP.md). For a second gate, move the Apple
  secrets into a `release` **Environment** with required reviewers: the job then
  waits for an approval before it can even see them.
- Turn on **Settings → Code security**: secret scanning and push protection are
  free on public repos and block a credential from being committed in the first
  place.

What each secret is worth if it leaks, and what to do:

| Secret | Exposure | If leaked |
| --- | --- | --- |
| `APPLE_CERTIFICATE_P12` + password | Lets anyone sign software as you | Revoke the certificate in Apple Developer immediately |
| `APPLE_APP_SPECIFIC_PASSWORD` | Notarization only, tied to your Apple ID | Revoke at appleid.apple.com |
| `SENTRY_AUTH_TOKEN` | Can write releases/sourcemaps to the Sentry org | Rotate; scope it to this project only |
| `SARVINBOX_GOOGLE_CLIENT_SECRET` | **Already public** once shipped — it is inlined into the app | Nothing to do, by design; just never reuse a web client here |
| `SARVINBOX_SENTRY_DSN` | Public by design (client-side) | Nothing |

### 2. Allow the release to push

`scripts/release.sh` pushes the version-bump commit to `main`, which branch
protection will block. Pick one:

- **Give maintainers bypass** (simplest). In the `main` ruleset, add your
  maintainers team to **Bypass list**. Everyone else still needs a reviewed PR.
- **Or route it through a PR** (stricter, and the better default):
  `./scripts/release.sh minor --pr` pushes a `release/vX.Y.Z` branch and opens a
  PR, holding the tag locally. After the PR is approved and merged,
  `git push origin vX.Y.Z` starts the build.

Branch protection does not cover tags, so the tag push works either way — but a
`v*` tag ruleset does, and [GITHUB-SETUP.md](./GITHUB-SETUP.md) sets one up so
that only maintainers can start a release. Configure both there; this page
assumes it is done.

### 3. Check Actions permissions

**Settings → Actions → General → Workflow permissions** → *Read repository
contents and packages permissions*. The workflow grants `contents: write` to the
publish job only, so the default can stay read-only.

## Cutting a release

```bash
git checkout main && git pull
./scripts/release.sh minor
```

The script refuses to run if the tree is dirty, if you are not on `main`, if
`main` is behind origin, or if the tag already exists — each of those is a
failure that is expensive to undo once a tag is pushed.

It shows you the generated changelog entry and waits. **Edit `CHANGELOG.md` at
that prompt** — generated bullets are commit subjects, which describe the change
to a reviewer, not to someone deciding whether to upgrade. The edit lands in the
release commit.

Then watch the run:

```bash
gh run watch --repo Sarv/Inbox
```

When it finishes, the release is a **draft**. Download one artifact per platform,
check it launches, then publish from
<https://github.com/Sarv/Inbox/releases>.

Publishing is not just a listing: it is what hands the update to every installed
copy, which will download and apply it on its own within the hour. See
"Auto-update" below before you click it.

> The repository has no `v*` tag yet, so the **first** release generates notes
> spanning the entire history — hundreds of bullets. Trim it hard at the prompt;
> `CHANGELOG.md` already documents 1.1.0 by hand, and that entry is the model to
> follow.

## Auto-update: what publishing actually does

The shipped app checks GitHub Releases for this repository every hour and 30
seconds after launch, downloads a newer version in the background, and applies
it on the next ordinary quit. **File → Check for Updates...** (Help on Windows
and Linux) runs the same check on demand and offers *Install and Relaunch*.

Three things make that work, and each is a way to break it:

1. **The `publish` block in `apps/desktop/package.json`.** It is what makes
   electron-builder write `latest.yml`, `latest-mac.yml` and `latest-linux.yml`
   beside the artifacts, and what gets baked into the app as `app-update.yml`.
   Remove it and the build still succeeds — it just produces an app that never
   finds an update. The metadata files are already in the workflow's upload glob;
   they are generated even though the build runs `--publish never`, because
   `never` only suppresses the *upload*.
2. **The release must be PUBLISHED, not a draft.** electron-updater cannot see
   draft releases. That is the safety gate: the workflow always creates a draft,
   and nothing reaches a single user until you click publish. Conversely, the
   moment you click publish, every installed copy will pick it up within the
   hour — there is no staged rollout.
3. **macOS updates require the build to be signed.** Squirrel.Mac validates the
   signature of the downloaded `.zip` against the running app, so an unsigned
   release installs for nobody. If `APPLE_CERTIFICATE_P12` was missing, the
   macOS build warns rather than failing (see above) — publishing that release
   ships a Mac app that can never update itself again.

### What each platform gets

| Artifact | Auto-updates |
| --- | --- |
| macOS `.dmg` / `.zip` | Yes — the `.zip` is the update payload; the `.dmg` is only for first install |
| Windows NSIS `.exe` | Yes |
| Linux `.AppImage` | Yes |
| Linux `.deb` / `.rpm` / `.tar.gz` | **No** — owned by the package manager |

The app detects the last case and disables checking entirely rather than trying
an in-place swap on a root-owned install. Unpackaged dev builds are disabled the
same way — there is no `app-update.yml` in a `pnpm dev` tree.

### If a user says updates never arrive

Check, in this order: the release is published rather than draft; `latest.yml`
(or `latest-mac.yml`/`latest-linux.yml`) is attached to it; the version in that
file is higher than theirs; and their build is not a `.deb`/`.rpm`. The app logs
every check to `app.log` with the `[Update]` prefix, including the reason a check
was refused.

## Rebuilding without a new version

If a build fails for an environmental reason (a runner outage, a notarization
timeout), re-run it against the existing tag instead of burning a version:

**Actions → Release → Run workflow**, and enter the tag.

## Local builds

For a signed DMG from the current tree without touching versions or git:

```bash
./scripts/build-dmg.sh --arch both --notarize
```

That is for testing and hand-distribution only. It cannot produce Linux or
Windows artifacts, for the reason at the top of this page.

## Troubleshooting

**`if-no-files-found: error` on the upload step** — electron-builder produced
nothing. Read the packaging step's log; on Linux it is usually a missing
`fpm`/`rpm` toolchain, on macOS a certificate that failed to import.

**"FAIL: signed app carries no entitlements"** — the build signed with
`hardenedRuntime` but lost `build/entitlements.mac.plist`. Confirm that file is
still tracked in git: `.gitignore` ignores `apps/desktop/build/*` and only
un-ignores specific files, and this one has been lost to that rule before. A
build without those entitlements crashes V8 on launch.

**Notarization rejected** — almost always an app-specific password that has been
revoked, or an Apple ID that is not on the team named by `APPLE_TEAM_ID`.

**Linux arm64 job cannot find a runner** — the repository is still private; see
the note under "What a release produces".
