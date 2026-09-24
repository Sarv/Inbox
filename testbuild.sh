#!/usr/bin/env bash
#
# testbuild.sh -- verify the macOS signing + notarization credentials LOCALLY,
# exactly the way .github/workflows/release.yml will use them, BEFORE you paste
# anything into GitHub secrets.
#
# Why this exists
# ---------------
# CI failed with:
#     security: SecKeychainUnlock: The user name or passphrase you entered is
#     not correct.
#
# That message comes from `security unlock-keychain`, which electron-builder
# runs on the throwaway keychain it builds out of CSC_LINK / CSC_KEY_PASSWORD.
# Locally you never see it, because scripts/build-dmg.sh reads the .p12
# password out of your login Keychain and it is always right. So the only way
# to find out whether the values you are ABOUT to upload are good is to run the
# same `security` calls against the same base64 blob. That is all this does.
#
# The plausible causes it distinguishes, in the order it checks them:
#   1. CSC_LINK is not valid base64        -> electron-builder writes a garbage
#                                             .p12, every later step misreports.
#   2. CSC_LINK has newlines / whitespace  -> `base64 -i` wraps at 76 cols on
#                                             some tool versions; a wrapped
#                                             secret decodes to a truncated p12.
#   3. CSC_KEY_PASSWORD has a trailing     -> the GitHub secret editor keeps a
#      newline, space, or smart quote         trailing newline if you hit Enter
#                                             before Save. The password then
#                                             "looks" right and never matches.
#   4. Password genuinely wrong            -> openssl refuses to open the p12.
#   5. p12 has no private key, or no       -> imports fine, then codesign can
#      intermediate CA cert                   not build a chain.
#   6. Certificate expired / revoked       -> find-identity lists nothing.
#   7. Key not pre-authorized for codesign -> signing hangs on a GUI prompt and
#      (missing set-key-partition-list)       dies with errSecInternalComponent.
#   8. Notarization creds wrong / Apple ID -> notarytool rejects them; the build
#      not on the team named by TEAM_ID       signs and then fails at the end.
#
# Nothing is written to the repo, nothing is uploaded, and the throwaway
# keychain is destroyed on exit (including on failure or Ctrl-C).
#
# It never prompts
# ----------------
# No password prompt, no GUI dialog, no confirmation -- it runs start to finish
# unattended, so it behaves the way it would on a CI runner:
#   * the .p12 password comes from --env-file or from the login-Keychain item
#     scripts/build-dmg.sh already stores; if neither has it the script FAILS
#     with instructions rather than asking you for it.
#   * signing happens in a throwaway keychain whose key is pre-authorized with
#     set-key-partition-list, so codesign never raises the "wants to access key"
#     dialog (without it you get ~30 dialogs, then errSecInternalComponent).
#   * the only thing that can still put a dialog on screen is macOS asking to
#     unlock your LOGIN keychain, and only if it is currently locked -- unlock
#     it first, or put the password in the env file, and nothing appears.
#
# Usage
# -----
#   ./testbuild.sh --p12 ~/Downloads/sarv-developerID-application.p12
#   ./testbuild.sh --env-file .env.signing        # test the exact secret values
#   ./testbuild.sh --p12 <path> --build           # + a real signed electron build
#   ./testbuild.sh --env-file .env.signing --build --notarize
#   ./testbuild.sh --p12 <path> --emit-secrets    # print the gh secret commands
#
# Inputs (env vars are named after the GitHub secrets on purpose)
# ---------------------------------------------------------------
#   APPLE_CERTIFICATE_P12         base64 of the Developer ID Application .p12
#                                 (or pass --p12 <file> and it is derived)
#   APPLE_CERTIFICATE_PASSWORD    the .p12 export password
#   APPLE_ID                      Apple ID that owns the Developer account
#   APPLE_APP_SPECIFIC_PASSWORD   appleid.apple.com -> App-Specific Passwords
#   APPLE_TEAM_ID                 Apple Developer -> Membership, e.g. LV54AA5562
#
# Fallbacks, so you can usually just run `./testbuild.sh`:
#   --p12 defaults to  $SARV_P12_PATH  or  ~/Downloads/sarv-developerID-application.p12
#   the .p12 password falls back to the login-Keychain item that
#   scripts/build-dmg.sh already stores (service: $P12_KC_SERVICE,
#   default sarv-terminal-p12)
#
# Exit code is 0 only when every check the run attempted passed.

set -uo pipefail

# ---------------------------------------------------------------- output ----
# ASCII labels only. No emoji or variation-selector glyphs anywhere in this
# file: terminals disagree on their cell width and garble pasted lines.
BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'
YEL=$'\033[33m'; RST=$'\033[0m'
[[ -t 1 ]] || { BOLD=""; DIM=""; RED=""; GRN=""; YEL=""; RST=""; }

FAILURES=0
WARNINGS=0
STEP_NO=0

step()  { STEP_NO=$((STEP_NO + 1)); printf '\n%s[%d] %s%s\n' "$BOLD" "$STEP_NO" "$1" "$RST"; }
ok()    { printf '    %sOK:%s   %s\n'   "$GRN" "$RST" "$1"; }
warn()  { printf '    %sWARN:%s %s\n'   "$YEL" "$RST" "$1"; WARNINGS=$((WARNINGS + 1)); }
fail()  { printf '    %sFAIL:%s %s\n'   "$RED" "$RST" "$1"; FAILURES=$((FAILURES + 1)); }
info()  { printf '    %s%s%s\n'         "$DIM" "$1" "$RST"; }
die()   { printf '\n%sFAIL:%s %s\n' "$RED" "$RST" "$1"; exit 1; }

# ----------------------------------------------------------------- args -----
P12_PATH=""
ENV_FILE=""
DO_BUILD="no"
DO_NOTARIZE="no"
EMIT_SECRETS="no"
ARCH="arm64"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --p12)           P12_PATH="${2:-}"; shift 2 ;;
    --env-file)      ENV_FILE="${2:-}"; shift 2 ;;
    --build)         DO_BUILD="yes"; shift ;;
    --notarize)      DO_NOTARIZE="yes"; DO_BUILD="yes"; shift ;;
    --arch)          ARCH="${2:-}"; shift 2 ;;
    --emit-secrets)  EMIT_SECRETS="yes"; shift ;;
    -h|--help)       sed -n '2,70p' "$0"; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
done

[[ "$(uname -s)" == "Darwin" ]] || die "macOS only -- codesign/notarytool do not exist elsewhere."
command -v security >/dev/null || die "'security' not found."
command -v openssl  >/dev/null || die "'openssl' not found."

# An --env-file lets you paste the EXACT strings you are about to save as
# GitHub secrets (KEY=value per line) and test those, not your local setup.
if [[ -n "$ENV_FILE" ]]; then
  [[ -f "$ENV_FILE" ]] || die "env file not found: $ENV_FILE"
  set -a; . "$ENV_FILE"; set +a
  info "loaded $ENV_FILE"
fi

: "${APPLE_CERTIFICATE_P12:=}"
: "${APPLE_CERTIFICATE_PASSWORD:=}"
: "${APPLE_ID:=}"
: "${APPLE_APP_SPECIFIC_PASSWORD:=}"
: "${APPLE_TEAM_ID:=}"
: "${P12_KC_SERVICE:=sarv-terminal-p12}"   # same login-Keychain item release.sh uses
: "${NOTARY_PROFILE:=sarv-notary}"          # notarytool profile name from SarvTerminal
# Non-secret. Confirmed from the local Developer ID identity and docs/RELEASING.md:
#   "Developer ID Application: SARV WEBS PRIVATE LIMITED (LV54AA5562)"
: "${APPLE_TEAM_ID:=LV54AA5562}"

printf '%smacOS release-credential check%s  %s(%s)%s\n' \
  "$BOLD" "$RST" "$DIM" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$RST"

# --------------------------------------------------------------- workdir ----
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/testbuild.XXXXXXXX")"
BUILD_KC="$WORK_DIR/testbuild.keychain-db"
KC_ADDED="no"
ORIG_KEYCHAINS="$(security list-keychains -d user | sed -e 's/^[[:space:]]*//' -e 's/"//g')"

cleanup() {
  local code=$?
  if [[ "$KC_ADDED" == "yes" ]]; then
    # Restore the original search list before deleting, or the shell inherits a
    # list pointing at a keychain that no longer exists.
    # shellcheck disable=SC2086
    security list-keychains -d user -s $ORIG_KEYCHAINS >/dev/null 2>&1 || true
    security delete-keychain "$BUILD_KC" >/dev/null 2>&1 || true
  fi
  rm -rf "$WORK_DIR"
  exit $code
}
trap cleanup EXIT INT TERM

# ================================================================ STEP 1 ====
step "Certificate blob (what becomes the CSC_LINK / APPLE_CERTIFICATE_P12 secret)"

P12_FILE="$WORK_DIR/cert.p12"

if [[ -n "$APPLE_CERTIFICATE_P12" ]]; then
  info "source: APPLE_CERTIFICATE_P12 (base64, ${#APPLE_CERTIFICATE_P12} chars)"

  # Cause 2: a wrapped or padded secret. GitHub stores the value verbatim, and
  # electron-builder feeds it straight to a base64 decoder.
  if printf '%s' "$APPLE_CERTIFICATE_P12" | LC_ALL=C grep -q '[[:space:]]'; then
    warn "the base64 contains whitespace/newlines -- some decoders truncate there."
    info "regenerate with:  base64 -i <file>.p12 | tr -d '\\n'"
  else
    ok "single line, no embedded whitespace"
  fi

  if printf '%s' "$APPLE_CERTIFICATE_P12" | base64 --decode > "$P12_FILE" 2>/dev/null \
       && [[ -s "$P12_FILE" ]]; then
    ok "decodes to $(wc -c < "$P12_FILE" | tr -d ' ') bytes"
  else
    fail "not valid base64 -- CSC_LINK would decode to a garbage .p12 in CI."
    die "fix the secret value, then re-run."
  fi
else
  : "${P12_PATH:=${SARV_P12_PATH:-$HOME/Downloads/sarv-developerID-application.p12}}"
  [[ -f "$P12_PATH" ]] || die ".p12 not found at $P12_PATH (pass --p12 <path>)"
  info "source: $P12_PATH"
  cp "$P12_PATH" "$P12_FILE"
  APPLE_CERTIFICATE_P12="$(base64 -i "$P12_FILE" | tr -d '\n')"
  ok "read $(wc -c < "$P12_FILE" | tr -d ' ') bytes, base64 is ${#APPLE_CERTIFICATE_P12} chars"
fi

# .p12 files are DER; the first byte of a SEQUENCE is 0x30. A wrong-looking
# magic here means the blob is a PEM, a zip, or a truncated download.
if [[ "$(xxd -p -l 1 "$P12_FILE")" != "30" ]]; then
  fail "decoded bytes are not a DER PKCS#12 (bad magic) -- wrong file exported?"
fi

# ================================================================ STEP 2 ====
step "Certificate password (what becomes CSC_KEY_PASSWORD / APPLE_CERTIFICATE_PASSWORD)"

if [[ -z "$APPLE_CERTIFICATE_PASSWORD" ]]; then
  # Reuse the login-Keychain item scripts/build-dmg.sh already maintains rather
  # than asking for the password a second time.
  APPLE_CERTIFICATE_PASSWORD="$(security find-generic-password -a "$USER" -s "$P12_KC_SERVICE" -w 2>/dev/null || true)"
  if [[ -n "$APPLE_CERTIFICATE_PASSWORD" ]]; then
    info "source: login Keychain item '$P12_KC_SERVICE' (same one build-dmg.sh uses)"
  else
    # Deliberately NOT prompting -- see the no-prompt guarantee in the header.
    fail "no .p12 password available and this script never prompts."
    info "either set APPLE_CERTIFICATE_PASSWORD in your --env-file, or store it once:"
    info "  security add-generic-password -a \"\$USER\" -s $P12_KC_SERVICE -w '<password>' -U"
    die "no .p12 password supplied."
  fi
else
  info "source: APPLE_CERTIFICATE_PASSWORD"
fi
[[ -n "$APPLE_CERTIFICATE_PASSWORD" ]] || die "no .p12 password supplied."

# Cause 3: the single most common reason a "correct" password is rejected in CI
# but works locally.
case "$APPLE_CERTIFICATE_PASSWORD" in
  *[$'\n\r']*) fail "password contains a newline -- CI will send it verbatim and the unlock fails." ;;
  ' '*|*' ')   warn "password has a leading/trailing space. Intentional? CI will keep it." ;;
esac
if printf '%s' "$APPLE_CERTIFICATE_PASSWORD" | LC_ALL=C grep -q '[^[:print:]]'; then
  fail "password contains a non-printable character."
fi
if printf '%s' "$APPLE_CERTIFICATE_PASSWORD" | LC_ALL=C grep -q $'[\xe2\x80\x98\x99\x9c\x9d]'; then
  warn "password appears to contain a smart quote -- copied from a doc/Notes app?"
fi
info "length: ${#APPLE_CERTIFICATE_PASSWORD} chars"

# Cause 4: does the password actually open the archive? openssl answers this
# without touching any keychain, so a failure here is unambiguous.
if openssl pkcs12 -in "$P12_FILE" -passin "pass:$APPLE_CERTIFICATE_PASSWORD" -noout -legacy 2>/dev/null \
   || openssl pkcs12 -in "$P12_FILE" -passin "pass:$APPLE_CERTIFICATE_PASSWORD" -noout 2>/dev/null; then
  ok "password opens the .p12 (openssl accepted it)"
else
  fail "password does NOT open the .p12 -- 'MAC verification failed'."
  info "this is the credential to fix; every later step would fail for this reason."
  die "wrong .p12 password."
fi

# ================================================================ STEP 3 ====
step "Certificate contents"

# -legacy is needed on OpenSSL 3 for the RC2-encrypted p12 that Keychain Access
# exports; fall back for LibreSSL / OpenSSL 1.x which do not know the flag.
dump_p12() {
  openssl pkcs12 -in "$P12_FILE" -passin "pass:$APPLE_CERTIFICATE_PASSWORD" -nodes -legacy 2>/dev/null \
    || openssl pkcs12 -in "$P12_FILE" -passin "pass:$APPLE_CERTIFICATE_PASSWORD" -nodes 2>/dev/null
}
PEM_DUMP="$WORK_DIR/dump.pem"
dump_p12 > "$PEM_DUMP"

CERT_COUNT=$(grep -c 'BEGIN CERTIFICATE' "$PEM_DUMP" || true)
KEY_COUNT=$(grep -cE 'BEGIN (ENCRYPTED )?PRIVATE KEY|BEGIN RSA PRIVATE KEY' "$PEM_DUMP" || true)

# Cause 5a: an export of the certificate alone signs nothing.
if [[ "$KEY_COUNT" -ge 1 ]]; then
  ok "private key present"
else
  fail "no private key in the .p12 -- re-export from Keychain Access selecting"
  info "the KEY and the certificate together (expand the cert, select both rows)."
fi

# Cause 5b: without the 'Developer ID Certification Authority' intermediate,
# codesign signs but cannot build a chain, and notarization rejects the result.
if [[ "$CERT_COUNT" -ge 2 ]]; then
  ok "$CERT_COUNT certificates (leaf + intermediate chain)"
else
  warn "only $CERT_COUNT certificate -- the Developer ID intermediate CA is missing."
  info "usually still fine on a Mac that has it installed, but CI runners may not."
fi

LEAF="$WORK_DIR/leaf.pem"
awk '/BEGIN CERTIFICATE/{n++} n==1{print} /END CERTIFICATE/{if(n==1) exit}' "$PEM_DUMP" > "$LEAF"

SUBJECT=$(openssl x509 -in "$LEAF" -noout -subject 2>/dev/null | sed 's/^subject= *//')
NOT_AFTER=$(openssl x509 -in "$LEAF" -noout -enddate 2>/dev/null | sed 's/^notAfter=//')
CERT_CN=$(printf '%s' "$SUBJECT" | sed -nE 's/.*CN *= *([^,\/]*).*/\1/p')
CERT_OU=$(printf '%s' "$SUBJECT" | sed -nE 's/.*OU *= *([^,\/]*).*/\1/p')

info "CN: ${CERT_CN:-<none>}"
info "expires: ${NOT_AFTER:-<unknown>}"

case "$CERT_CN" in
  "Developer ID Application:"*)
    ok "type: Developer ID Application (correct for distribution outside the App Store)" ;;
  "Apple Development:"*|"Mac Developer:"*)
    fail "this is a DEVELOPMENT certificate. It cannot be notarized and Gatekeeper"
    info "will block the DMG. Create a 'Developer ID Application' cert instead." ;;
  "3rd Party Mac Developer"*|"Apple Distribution:"*)
    fail "this is a Mac App Store certificate, not Developer ID." ;;
  *)
    warn "unrecognised certificate type: ${CERT_CN:-<none>}" ;;
esac

# Cause 6: an expired cert imports cleanly and then lists as no valid identity.
if openssl x509 -in "$LEAF" -noout -checkend 0 >/dev/null 2>&1; then
  if ! openssl x509 -in "$LEAF" -noout -checkend 2592000 >/dev/null 2>&1; then
    warn "expires in under 30 days -- renew before the next release."
  else
    ok "not expired"
  fi
else
  fail "certificate is EXPIRED ($NOT_AFTER)."
fi

# ================================================================ STEP 4 ====
step "Team ID"

if [[ -z "$APPLE_TEAM_ID" ]]; then
  if [[ -n "$CERT_OU" ]]; then
    APPLE_TEAM_ID="$CERT_OU"
    warn "APPLE_TEAM_ID not set; using the OU from the certificate: $APPLE_TEAM_ID"
  else
    fail "APPLE_TEAM_ID not set and no OU in the certificate."
  fi
elif [[ -n "$CERT_OU" && "$CERT_OU" != "$APPLE_TEAM_ID" ]]; then
  # Cause 8: signing succeeds, notarization then rejects the submission.
  fail "APPLE_TEAM_ID ($APPLE_TEAM_ID) != the certificate's team ($CERT_OU)."
  info "notarytool would accept the upload and then reject the package."
else
  ok "$APPLE_TEAM_ID matches the certificate"
fi

# ================================================================ STEP 5 ====
step "Keychain round-trip -- the step CI failed on (SecKeychainUnlock)"

# electron-builder does exactly this with a random keychain password. Running it
# here with the real secret values is the whole point of the script: if CI's
# unlock is failing for a reason other than the password, it fails here too.
KC_PW="$(openssl rand -base64 24 | tr -d '\n=/+')"

# A stale keychain of the same name keeps its ORIGINAL password, and the unlock
# that follows then fails with precisely the message CI printed.
security delete-keychain "$BUILD_KC" >/dev/null 2>&1 || true

if out=$(security create-keychain -p "$KC_PW" "$BUILD_KC" 2>&1); then
  KC_ADDED="yes"
  ok "security create-keychain"
else
  fail "security create-keychain: $out"
  die "cannot create a throwaway keychain; nothing else can be tested."
fi

# THE call that produced the CI error.
if out=$(security unlock-keychain -p "$KC_PW" "$BUILD_KC" 2>&1); then
  ok "security unlock-keychain"
else
  fail "security unlock-keychain: $out"
  info "same failure as CI, reproduced locally -- the keychain layer itself is"
  info "broken here, so the fix is not the certificate. Check for a leftover"
  info "keychain of the same name in ~/Library/Keychains (or on the runner)."
fi

# Long auto-lock timeout: a keychain that relocks mid-build reproduces the same
# SecKeychainUnlock error halfway through signing, which reads like a flake.
security set-keychain-settings -lut 21600 "$BUILD_KC" >/dev/null 2>&1 \
  && ok "auto-lock disabled for the build window (6h)" \
  || warn "could not set keychain settings"

# Cause 4 again, this time through Security.framework rather than openssl --
# they disagree on a handful of legacy encryption schemes.
if out=$(security import "$P12_FILE" -k "$BUILD_KC" -P "$APPLE_CERTIFICATE_PASSWORD" \
           -T /usr/bin/codesign -T /usr/bin/productsign 2>&1); then
  ok "security import (certificate + key into the keychain)"
else
  fail "security import: $out"
  info "'MAC verification failed' here = wrong APPLE_CERTIFICATE_PASSWORD."
fi

# Cause 7: without this, signing pops a GUI prompt per binary (~30 in an
# Electron app) and dies as errSecInternalComponent on a headless runner.
if out=$(security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$KC_PW" "$BUILD_KC" 2>&1 >/dev/null); then
  ok "security set-key-partition-list (codesign pre-authorized, no GUI prompt)"
else
  fail "security set-key-partition-list: $out"
fi

# shellcheck disable=SC2086
security list-keychains -d user -s "$BUILD_KC" $ORIG_KEYCHAINS >/dev/null

IDENTITIES=$(security find-identity -v -p codesigning "$BUILD_KC" 2>/dev/null || true)
SIGN_ID=$(printf '%s' "$IDENTITIES" | grep -m1 "Developer ID Application" | sed -E 's/.*"(.*)"/\1/')
if [[ -n "$SIGN_ID" ]]; then
  ok "valid codesigning identity: $SIGN_ID"
else
  fail "no valid 'Developer ID Application' identity after import."
  info "an expired, revoked, or key-less certificate looks exactly like this."
  [[ -n "$IDENTITIES" ]] && info "find-identity said: $(printf '%s' "$IDENTITIES" | tail -1)"
fi

# ================================================================ STEP 6 ====
step "Signing smoke test (a throwaway binary, hardened runtime + timestamp)"

if [[ -n "$SIGN_ID" ]]; then
  TEST_BIN="$WORK_DIR/testbin"
  # A freshly compiled binary, not a copy of a system one: macOS platform
  # binaries carry an Apple signature that re-signing treats specially, which
  # makes the result unrepresentative of signing our own Electron helpers.
  if command -v cc >/dev/null 2>&1 \
     && printf 'int main(void){return 0;}\n' | cc -x c -o "$TEST_BIN" - 2>/dev/null; then
    info "probe: freshly compiled binary"
  else
    cp /bin/ls "$TEST_BIN"
    info "probe: copy of /bin/ls (no compiler available)"
  fi

  # --options runtime and --timestamp are what the real build uses. --timestamp
  # also proves the machine can reach Apple's timestamp authority, which a
  # locked-down network blocks and which notarization then rejects.
  if out=$(codesign --force --options runtime --timestamp \
             --keychain "$BUILD_KC" --sign "$SIGN_ID" "$TEST_BIN" 2>&1); then
    ok "codesign succeeded unattended (no GUI prompt, no errSecInternalComponent)"
    if codesign --verify --strict --verbose=2 "$TEST_BIN" >/dev/null 2>&1; then
      ok "signature verifies"
      # -dvv, not -dv: Authority and Timestamp only print at verbosity 2.
      DUMP=$(codesign -dvv "$TEST_BIN" 2>&1)
      AUTH=$(printf '%s' "$DUMP" | grep -m1 '^Authority')
      info "${AUTH:-Authority: unavailable}"
      if printf '%s' "$DUMP" | grep -q '^Timestamp='; then
        ok "secure timestamp present (required for notarization)"
      else
        fail "no secure timestamp -- Apple would reject the notarization."
        info "usually a blocked route to timestamp.apple.com."
      fi
    else
      fail "signature does not verify -- the chain is probably incomplete."
    fi
  else
    fail "codesign: $out"
    printf '%s' "$out" | tail -3 | sed 's/^/        /'
    info "errSecInternalComponent here means the key was not pre-authorized;"
    info "that is what set-key-partition-list in step 5 is for."
  fi
else
  warn "skipped -- no signing identity."
fi

# ================================================================ STEP 7 ====
step "Notarization credentials (APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID)"

if ! xcrun --find notarytool >/dev/null 2>&1; then
  warn "notarytool not found -- install the Xcode command line tools."
elif [[ -z "$APPLE_ID" || -z "$APPLE_APP_SPECIFIC_PASSWORD" ]]; then
  # Fallback: ../../../SarvTerminal/scripts/release.sh never handles the raw
  # Apple ID -- it notarizes through a notarytool Keychain profile created once
  # with `xcrun notarytool store-credentials`. If that profile exists we can at
  # least prove Apple accepts SOME credentials for this team, even though CI
  # still needs the raw values as secrets (a runner has no Keychain profile).
  if xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" >/dev/null 2>&1; then
    ok "notarytool Keychain profile '$NOTARY_PROFILE' works (used by release.sh)"
    warn "but APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD are still unset here."
    info "CI cannot use a Keychain profile -- it needs both as raw secrets."
    info "put them in .env.signing and re-run to verify them."
  else
    warn "APPLE_ID or APPLE_APP_SPECIFIC_PASSWORD not set -- skipping."
    info "without them the release job signs the app but cannot notarize it,"
    info "and Gatekeeper blocks the DMG on every machine but yours."
  fi
else
  case "$APPLE_APP_SPECIFIC_PASSWORD" in
    *[$'\n\r']*) fail "app-specific password contains a newline." ;;
  esac
  # An app-specific password is always xxxx-xxxx-xxxx-xxxx. A regular Apple ID
  # password here is the second most common notarization failure.
  if [[ ! "$APPLE_APP_SPECIFIC_PASSWORD" =~ ^[a-z]{4}-[a-z]{4}-[a-z]{4}-[a-z]{4}$ ]]; then
    warn "not in the xxxx-xxxx-xxxx-xxxx shape of an app-specific password."
    info "generate one at appleid.apple.com -> Sign-In and Security."
  else
    ok "app-specific password has the expected shape"
  fi
  # `history` authenticates against Apple without submitting anything.
  info "asking Apple to authenticate (no submission is made)..."
  if out=$(xcrun notarytool history --apple-id "$APPLE_ID" \
             --password "$APPLE_APP_SPECIFIC_PASSWORD" \
             --team-id "$APPLE_TEAM_ID" 2>&1); then
    ok "Apple accepted the notarization credentials"
  else
    fail "notarytool rejected the credentials"
    printf '%s' "$out" | tail -4 | sed 's/^/        /'
    info "causes: wrong Apple ID, a normal password instead of an app-specific"
    info "one, or an Apple ID that is not a member of team $APPLE_TEAM_ID."
  fi
fi

# ================================================================ STEP 8 ====
if [[ "$DO_BUILD" == "yes" ]]; then
  step "Real electron-builder run (the same env the CI Package step sets)"
  if [[ -z "$SIGN_ID" ]]; then
    warn "skipped -- no signing identity, the build would be unsigned."
  else
    REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    case "$ARCH" in
      arm64) BUILDER_ARCH=(--arm64) ;;
      x64)   BUILDER_ARCH=(--x64) ;;
      both)  BUILDER_ARCH=(--arm64 --x64) ;;
      *) die "--arch must be arm64, x64, or both" ;;
    esac
    EXTRA=()
    [[ "$DO_NOTARIZE" == "yes" ]] && EXTRA+=(-c.mac.notarize=true)

    info "this takes several minutes and needs the libraries built already"
    info "(pnpm --filter ... build) -- see docs/RELEASING.md."
    (
      cd "$REPO_ROOT/apps/desktop" || exit 1
      # Byte-for-byte the variables release.yml exports, so a pass here means
      # the CI step has everything it needs.
      CSC_LINK="$APPLE_CERTIFICATE_P12" \
      CSC_KEY_PASSWORD="$APPLE_CERTIFICATE_PASSWORD" \
      APPLE_ID="$APPLE_ID" \
      APPLE_APP_SPECIFIC_PASSWORD="$APPLE_APP_SPECIFIC_PASSWORD" \
      APPLE_TEAM_ID="$APPLE_TEAM_ID" \
      pnpm exec electron-builder --mac "${BUILDER_ARCH[@]}" "${EXTRA[@]}" --publish never
    )
    if [[ $? -eq 0 ]]; then
      ok "electron-builder finished"
      APP=$(find "$REPO_ROOT/apps/desktop/release" -maxdepth 3 -name '*.app' 2>/dev/null | head -1)
      if [[ -n "$APP" ]]; then
        # The same assertions the "Verify macOS signature and entitlements"
        # step makes in CI -- an entitlement-less hardened build crashes V8.
        codesign --verify --deep --strict --verbose=2 "$APP" >/dev/null 2>&1 \
          && ok "app signature verifies" || fail "app signature does not verify"
        codesign --display --entitlements :- "$APP" 2>/dev/null | grep -q 'allow-jit' \
          && ok "entitlements present (allow-jit)" \
          || fail "signed app carries no entitlements -- it would crash on launch"
        if [[ "$DO_NOTARIZE" == "yes" ]]; then
          spctl --assess --type execute --verbose "$APP" 2>&1 | grep -q accepted \
            && ok "Gatekeeper accepts the app" \
            || fail "Gatekeeper rejects the app (not notarized or not stapled)"
        fi
      else
        fail "no .app produced under apps/desktop/release"
      fi
    else
      fail "electron-builder failed -- see the output above"
    fi
  fi
fi

# ================================================================ STEP 9 ====
if [[ "$EMIT_SECRETS" == "yes" ]]; then
  step "Commands to load these values into GitHub (run them yourself)"
  REPO_SLUG=$(git remote get-url origin 2>/dev/null \
    | sed -E 's#^.*github\.com[:/]##; s#\.git$##')
  : "${REPO_SLUG:=Sarv/Inbox}"
  P12_SRC="${P12_PATH:-<path>.p12}"
  cat <<HOWTO
    Values are piped from files/stdin so they never land in your shell history.

      base64 -i $P12_SRC | tr -d '\\n' | gh secret set APPLE_CERTIFICATE_P12 --repo $REPO_SLUG
      printf %s '<p12 password>'   | gh secret set APPLE_CERTIFICATE_PASSWORD  --repo $REPO_SLUG
      printf %s '$APPLE_ID'        | gh secret set APPLE_ID                    --repo $REPO_SLUG
      printf %s '<xxxx-xxxx-xxxx-xxxx>' | gh secret set APPLE_APP_SPECIFIC_PASSWORD --repo $REPO_SLUG
      printf %s '$APPLE_TEAM_ID'   | gh secret set APPLE_TEAM_ID               --repo $REPO_SLUG

    printf %s rather than echo, and Ctrl-D rather than Enter if you type them
    interactively: a trailing newline is stored verbatim by GitHub and is
    exactly what makes a correct password fail in CI.
HOWTO
fi

# ================================================================ RESULT ====
printf '\n%s----------------------------------------------------------%s\n' "$DIM" "$RST"
if [[ "$FAILURES" -eq 0 && "$WARNINGS" -eq 0 ]]; then
  printf '%sPASS%s  every check passed -- these values are safe to upload.\n' "$GRN" "$RST"
elif [[ "$FAILURES" -eq 0 ]]; then
  printf '%sPASS%s  with %d warning(s) -- read them before uploading.\n' "$GRN" "$RST" "$WARNINGS"
else
  printf '%sFAIL%s  %d check(s) failed, %d warning(s). Do NOT upload yet.\n' "$RED" "$RST" "$FAILURES" "$WARNINGS"
fi
printf 'Throwaway keychain removed; nothing was written to the repo.\n'

[[ "$FAILURES" -eq 0 ]]
