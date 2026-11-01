# Windows code signing

How the Windows builds get an Authenticode signature, and the one-time setup
behind it. Researched and checked against the vendors' own documentation on
2026-10-16; prices and portal labels change, so re-check them when you act.

## The decision, in one paragraph

Sarv is registered in India, so Microsoft's own signing service (Azure
Artifact Signing, about $10/month) is not available: it serves only
organisations in the US, Canada, the EU, the UK, Australia, New Zealand, Japan,
South Korea, Singapore, Switzerland, Norway and Israel. We therefore buy an
**OV code-signing certificate from Sectigo** whose private key is created and
kept in **Google Cloud KMS (Cloud HSM)**. GitHub Actions signs the release by
logging in to Google Cloud with its own short-lived identity (Workload Identity
Federation), so **no signing password or key is ever stored in GitHub**. EV is
not worth its price: since 2024 Windows treats EV and OV alike.

| Cost | Amount |
|---|---|
| Sectigo OV, "Install on Existing HSM", via a reseller | about $220/yr on a 3-year order (reissued each year), or about $315 for 1 year |
| Cloud KMS HSM key | about $2.50/month; signing operations cost fractions of a cent |
| Audit logs | effectively $0 at our volume |

What signing does and does not do:

- The installer names Sarv as the publisher instead of "Unknown publisher".
- **Smart App Control** (Windows 11) stops blocking the app: it refuses
  unsigned code outright when Microsoft has no verdict on it.
- **SmartScreen** still warns at first. The warning fades as the certificate
  builds reputation (weeks, hundreds of installs) and may return for a while
  after each yearly renewal.

## What you do, in order

Steps 1–4 happen once. Step 5 repeats every year.

### 1. Ask the reseller before paying

The delivery method cannot be changed after purchase, so get these answered in
writing first (SectigoStore or SSL2Buy chat):

1. Do you accept a **Google Cloud KMS / Cloud HSM** key attestation for a
   retail OV order (HSM type "Google Cloud KMS (Cloud HSM)", also called
   `Marvell_Google`)? In what form: the console's attestation `.zip`, or its
   base64? Any attestation fee?
2. RSA **3072** with PKCS#1 SHA-256: accepted?
3. What exact Subject will be issued? Will the CN be the MCA name verbatim
   (upper case, "PRIVATE LIMITED")? This string ends up in the app's update
   check and must never change later.
4. For an Indian company, which sources do you check (MCA, GST, D-U-N-S), and
   which phone number or email will the callback use?
5. On a 3-year order: the certificate schedule (400 + 400 + 295 days?), and
   can each yearly reissue use **the same key** (same CSR) with a fresh
   attestation?
6. Refund or exchange if the Google attestation is rejected?

### 2. Get the company paperwork straight

The certificate is issued to the company's exact legal name. Validation stalls
most often on a name or phone number that doesn't match an independent source.

- **Certificate of Incorporation / CIN** (MCA) and the **exact legal name**.
- **A phone number listed in an independent directory.** A free **D-U-N-S**
  listing (Dun & Bradstreet) whose name, address and phone match the MCA record
  is the usual fix. A number that appears only on the order form does not
  count.
- **Your passport** for the Video ID step; the name must match the order.
- Fallback if a check fails: a legal-opinion letter from an Indian lawyer or
  chartered accountant (Sectigo publishes the template).

Avoid a virtual-office address on the order.

### 3. Create the signing key in Google Cloud

Use a **new project**, separate from `sarv-inbox-ai` (the Gmail OAuth project),
so that nothing else in it can touch the key. These commands run in **Cloud
Shell** (console.cloud.google.com → the terminal icon); nothing is needed on
your Mac. Replace the `XXXX` placeholders.

```bash
export PROJECT_ID=sarv-inbox-signing          # must be globally unique
export BILLING_ACCOUNT=XXXXXX-XXXXXX-XXXXXX
export LOCATION=asia-south1                   # Mumbai; supports Cloud HSM
export KEY_RING=codesign                      # keep ONLY this key in the ring
export KEY=sarv-inbox-authenticode

gcloud projects create "$PROJECT_ID" --name="Sarv Inbox Signing"
gcloud billing projects link "$PROJECT_ID" --billing-account="$BILLING_ACCOUNT"
gcloud config set project "$PROJECT_ID"
gcloud services enable cloudkms.googleapis.com iam.googleapis.com iamcredentials.googleapis.com \
  sts.googleapis.com cloudresourcemanager.googleapis.com logging.googleapis.com

# If the project sits under an organisation, check nothing here blocks the
# region, the GitHub identity provider or the principalSet binding below:
gcloud org-policies list --project="$PROJECT_ID"

gcloud kms keyrings create "$KEY_RING" --location="$LOCATION"
gcloud kms keys create "$KEY" --keyring="$KEY_RING" --location="$LOCATION" \
  --purpose=asymmetric-signing --default-algorithm=rsa-sign-pkcs1-3072-sha256 \
  --protection-level=hsm --labels=use=authenticode
gcloud kms keys versions describe 1 --key="$KEY" --keyring="$KEY_RING" --location="$LOCATION" \
  --format='value(state,protectionLevel,algorithm)'
# expect: ENABLED  HSM  RSA_SIGN_PKCS1_3072_SHA256
```

Never create a version 2 of this key unless you are deliberately re-keying
with Sectigo: the certificate is bound to version 1.

**Turn on audit logging of every signing operation.** The code-signing rules
(CA/B Forum Code Signing Baseline Requirements §6.2.7.4.1) require a cloud key
to log all access and operations.

```bash
gcloud projects get-iam-policy "$PROJECT_ID" --format=yaml > policy.yaml
# Add this block at the top of policy.yaml, leaving bindings: and etag: as they are:
#   auditConfigs:
#   - service: cloudkms.googleapis.com
#     auditLogConfigs: [{logType: ADMIN_READ}, {logType: DATA_READ}, {logType: DATA_WRITE}]
#   - service: iam.googleapis.com
#     auditLogConfigs: [{logType: ADMIN_READ}]
#   - service: sts.googleapis.com
#     auditLogConfigs: [{logType: ADMIN_READ}]
gcloud projects set-iam-policy "$PROJECT_ID" policy.yaml

# Keep three years of those logs (the default bucket keeps 30 days):
gcloud logging buckets create kms-audit --location=global --retention-days=1095 \
  --description="KMS + GitHub identity audit (code signing)"
gcloud logging sinks create kms-audit-sink \
  "logging.googleapis.com/projects/${PROJECT_ID}/locations/global/buckets/kms-audit" \
  --log-filter='logName:"cloudaudit.googleapis.com" AND (protoPayload.serviceName="cloudkms.googleapis.com" OR protoPayload.serviceName="sts.googleapis.com" OR protoPayload.serviceName="iamcredentials.googleapis.com" OR protoPayload.serviceName="iam.googleapis.com")'
```

### 4. Make the CSR and the attestation, then order

**Attestation bundle** (proof to Sectigo that the key was made inside an HSM
and can never leave it): Console → Security → Key Management → `codesign` →
`sarv-inbox-authenticode` → version 1 → ⋮ → **Verify attestation** →
**Download attestation bundle**. Keep the `.zip` as it is.

**CSR**, signed by the key itself, in Cloud Shell. Give yourself temporary
permission to use the key, generate the CSR, then remove the permission:

```bash
export ME="user:$(gcloud config get-value account)"
gcloud kms keyrings add-iam-policy-binding "$KEY_RING" --location="$LOCATION" \
  --member="$ME" --role=roles/cloudkms.viewer
gcloud kms keys add-iam-policy-binding "$KEY" --keyring="$KEY_RING" --location="$LOCATION" \
  --member="$ME" --role=roles/cloudkms.signerVerifier

gcloud auth application-default login
sudo apt-get update && sudo apt-get install -y libengine-pkcs11-openssl
mkdir -p ~/kmsp11 && cd ~/kmsp11
curl -sSLO https://github.com/GoogleCloudPlatform/kms-integrations/releases/download/pkcs11-v1.9/libkmsp11-1.9-linux-amd64.tar.gz
tar xzf libkmsp11-1.9-linux-amd64.tar.gz
export PKCS11_MODULE_PATH="$(find ~/kmsp11 -name libkmsp11.so | head -1)"

# Check the library really is Google's (their published release-signing key):
cat > pkcs11-release-signing-key.pem <<'PEM'
-----BEGIN PUBLIC KEY-----
MHYwEAYHKoZIzj0CAQYFK4EEACIDYgAEtfLbXkHUVc9oUPTNyaEK3hIwmuGRoTtd
6zDhwqjJuYaMwNd1aaFQLMawTwZgR0Xn27ymVWtqJHBe0FU9BPIQ+SFmKw+9jSwu
/FuqbJnLmTnWMJ1jRCtyHNZawvv2wbiB
-----END PUBLIC KEY-----
PEM
openssl dgst -sha384 -verify pkcs11-release-signing-key.pem \
  -signature "${PKCS11_MODULE_PATH}.sig" "$PKCS11_MODULE_PATH"     # must print: Verified OK

printf -- '---\ntokens:\n  - key_ring: "projects/%s/locations/%s/keyRings/%s"\n' \
  "$PROJECT_ID" "$LOCATION" "$KEY_RING" > pkcs11-config.yaml
chmod 600 pkcs11-config.yaml
export KMS_PKCS11_CONFIG="$HOME/kmsp11/pkcs11-config.yaml"

# Use the EXACT legal name from step 2, and the state and city on the MCA record:
openssl req -new -sha256 -engine pkcs11 -keyform engine -key "pkcs11:object=${KEY}" \
  -subj "/C=IN/ST=XXXX/L=XXXX/O=XXXX EXACT LEGAL NAME/CN=XXXX EXACT LEGAL NAME" \
  -out sarv-inbox-authenticode.csr

# Check: the CSR is valid and carries the KMS key (the two hashes must match).
openssl req -in sarv-inbox-authenticode.csr -noout -verify
gcloud kms keys versions get-public-key 1 --key="$KEY" --keyring="$KEY_RING" \
  --location="$LOCATION" --output-file=kms-pub.pem
openssl req -in sarv-inbox-authenticode.csr -noout -pubkey | openssl pkey -pubin -outform DER | sha256sum
openssl pkey -pubin -in kms-pub.pem -outform DER | sha256sum

# Remove both temporary permissions again:
gcloud kms keys remove-iam-policy-binding "$KEY" --keyring="$KEY_RING" --location="$LOCATION" \
  --member="$ME" --role=roles/cloudkms.signerVerifier
gcloud kms keyrings remove-iam-policy-binding "$KEY_RING" --location="$LOCATION" \
  --member="$ME" --role=roles/cloudkms.viewer
```

**Order** the Sectigo OV Code Signing certificate with delivery method
**"Install on Existing HSM"** (not a USB token). On the key form: "key
generated on listed secure hardware" → **Yes**, HSM type **Google Cloud KMS
(Cloud HSM)**, paste the CSR, upload the attestation `.zip`. Then complete the
emailed steps: sign the Subscriber Agreement, take the automated callback, and
do the Video ID with your passport. Sectigo aims to issue within about two
working days once everything checks out.

Sectigo's own knowledge-base article on Google Cloud KMS is wrong in three
places (2048-bit key, a broken CSR command, non-existent role names). Follow
this page instead.

**The SSL2Buy portal (first order placed 2026-10-16).** SSL2Buy bills in US
dollars only, with no GST invoice. In the order → **Configure SSL** opens
`secure.configuressl.com`:

1. Solve the CAPTCHA (a person has to).
2. Set Validation Type to **Organization Codesign** and Hardware Module Type to
   **GOOGLE CLOUD**, then paste the CSR.
3. Click **Generate Key Attestation**, attach the attestation `.zip` in the
   pop-up, and generate.
4. Contact step:
   - Administrator: a company officer, with an email on the company's own
     domain.
   - Organisation address: exactly as on the MCA record.
   - Phone: one listed in an independent source (D-U-N-S, the Google Business
     Profile).
   - Publisher email: leave it blank, so no address is printed in the
     certificate.
5. Summary → **Submit Request**.

Validation then asks for:
- a government photo ID of the verifier, and a selfie holding it;
- a third-party directory listing (D-U-N-S) or a legal-opinion letter;
- a government directory listing (MCA) or the registration document.

After that come the Subscriber Agreement, the callback and the Video ID.

When the certificate arrives, download it **with its chain** (PEM) and send it
to the developer. It is public; it goes into the repository. In return you get
a few Cloud Shell commands that let GitHub's release build sign with the key
(see "How the release uses it"), plus a one-off test that signs a dummy file
before any real release depends on it.

### 5. Every year

1. In the reseller portal: Code Signing → **Reissue / Replace**.
2. Download a fresh attestation bundle for the **same key version** and submit
   it with the same CSR (if the reseller confirmed same-key reissues).
3. Put the new certificate chain in the repository before the old one expires.
   Its CN must stay exactly the same (`publisherNames[0]`), or the build stops.
   A renewal with the identical CN needs nothing else: no change to
   `publisherNames`, no extra release. Only a CN that really has to change
   follows "Changing the publisher name" below.

## How the release uses it

Everything below is already built and committed. It stays **dormant** until
the certificate chain is committed, and is **fail-closed** from then on.

### The switch

Signing is ON if and only if `apps/desktop/build/windows-signing-chain.pem`
exists. Everything else it needs is public and lives in
`apps/desktop/build/windows-signing.json`. Already committed: the key ring
and the pinned key version (`sarv-inbox-authenticode/cryptoKeyVersions/1`),
the sha256 of the KMS public key, the service account, the timestamp servers
(DigiCert, then Sectigo), and the jsign build pinned by sha256. Filled in at
switch-on, in the same change as the chain: the GitHub identity provider
(`workloadIdentityProvider`, empty until then) and the publisher names
auto-update will pin (`publisherNames`, empty until then).

- **Before the chain is committed** every Windows build is exactly what it
  always was: unsigned, and with no publisher name recorded for auto-update.
  The release log carries a warning saying so.
- **Once it is committed**, the build refuses to finish unless everything
  lines up: the identity provider is filled in, the chain parses, its first
  certificate is a code-signing (non-CA) certificate, its public key **is** the
  KMS key, it has not expired, and its CN is **exactly** `publisherNames[0]`
  (case included). The name is typed once, on purpose, and the certificate
  must agree with it: a reissued certificate under a different spelling stops
  the build instead of quietly changing what every install trusts.
- **Signing is a one-way latch, checked against what is actually
  installed.** Two checks make sure that a lost chain, a merge or a revert
  can never produce the unsigned release that strands every user:
  - *In the tree:* once `publisherNames` lists a name, a missing chain file is
    an error, not "signing is off".
  - *Against the last published release:* a `git revert` of the switch-on
    removes the chain **and** empties `publisherNames` in one change, and a tag
    cut from a branch older than the switch-on never had either; both trees
    look "disabled". So the release asks GitHub for the `windows-signing.json`
    of the release currently marked **Latest** (the one auto-update serves,
    and so what installed copies pin). If that file lists any name, this
    release must be signed, and its certificate's CN must be one of those
    names; otherwise the Windows build stops at its first step, and the
    publish job stops again just before `gh release create` (tags build in
    parallel, so it asks afresh). If no release is published yet, or Latest
    predates signing (no `windows-signing.json` at its tag), nothing is pinned
    and the log says which. Any other answer -- a network error, a 5xx, a file
    that is not valid -- fails the release rather than reading as "nothing is
    pinned".

  Switching signing off again therefore cannot be done by editing the tree
  once a signed release is Latest, and must not be: it strands every install.
  The check only protects tags whose own `release.yml` contains it, which is
  every tag cut after this change was merged.

### What happens in a release

0. **What installed copies pin.** The Windows job's first signing step asks
   GitHub which names the release marked Latest pins, and refuses to go on if
   this release would be refused by the installs it updated (see the latch
   above).
1. **GitHub's identity in Google Cloud.** The Windows job asks GitHub for an
   OIDC token and exchanges it for a one-hour Google access token. Google
   admits only tokens from `Sarv/Inbox` (by numeric repository id and by
   name), on a pushed `v*` tag, running `release.yml`, on a GitHub-hosted
   runner. Those tokens may impersonate one service account, which may only
   **sign with this one key**: no project roles, no downloadable keys. Every
   signature lands in the audit log. No signing secret is stored in GitHub.
2. **Signing inside the build.** electron-builder calls
   `apps/desktop/build/windowsSign.js` for every Windows binary: both apps (x64,
   arm64), their DLLs and native `.node` modules, the update helper
   (`elevate.exe`), the uninstaller and the installer. The hook runs jsign (Java,
   `GOOGLECLOUD` store, SHA-256, RFC 3161 timestamp) and re-reads each file to
   prove a signature landed. A file that is already signed (Microsoft's
   `d3dcompiler_47.dll` inside Electron) is left alone. Timestamp-server and
   network blips are retried; permission errors are not. It has to happen
   inside the build: `latest.yml`'s checksum, the signed update manifest and
   `SHA256SUMS` are all computed over the signed bytes. release.yml hands
   electron-builder the whole `publisherNames` list (one
   `-c.win.signtoolOptions.publisherName=…` flag per name, which
   electron-builder's command line turns into a list), and the hook refuses to
   sign unless it arrived intact.
3. **Checking the result on Windows.** After packaging,
   `scripts/verify-win-signatures.mjs` asks Windows itself
   (`Get-AuthenticodeSignature`, the same call the app's updater makes) about
   every executable file in both apps and the installer. Each must be Valid
   and timestamped; an unsigned file of any kind fails. **Our own files** --
   the two app executables, the installer and every `.node` addon -- must be
   signed by a name in `publisherNames` **with the committed certificate
   itself** (its SHA-256 fingerprint): the hook leaves an already-signed file
   alone, so a file that arrived signed under our name by some other
   certificate would otherwise ship as ours. Any other file (Electron's DLLs,
   `elevate.exe`, other helpers) may instead keep a Valid, timestamped
   signature it already carried before the build (the hook leaves signed files
   alone); each such file is listed in the log. Both apps' `app-update.yml`
   must record exactly `publisherNames`. Nothing is uploaded otherwise.
4. **Checking again before publishing.** The publish job (Linux) checks that
   the installer it is about to vouch for really carries a signature, and,
   just before `gh release create`, asks GitHub again what the release now
   marked Latest pins.

The same signing code is exercised on every pull request by CI's **"Windows
signing self-test"** job, with real jsign, real timestamps and Windows' own
verification, using a throwaway certificate made on the runner. So the code is
proven long before the release that first uses the real key.

### Auto-update and the publisher name

Installed copies today are unsigned and have no publisher name recorded, so
they accept the first signed update without a signature check. From then on,
every installed copy checks that each update is signed by **exactly** one of
the names its `app-update.yml` records (`publisherNames` at the time it was
built). Consequences:

- An **unsigned** Windows release can never ship again; it would strand every
  user. The build therefore fails closed. While signing is disabled the hook
  does nothing at all; it is the "Verify Windows Authenticode signatures" step
  that refuses an unsigned build whose `app-update.yml` carries any
  `publisherName` (even an empty list), as firmly as it refuses a signed build
  that does not record exactly `publisherNames`.
- If a renewal ever changes the certificate's CN (a company rename, a
  different CA spelling), installs that know only the old name refuse the
  first update signed under the new one. Follow "Changing the publisher name"
  below, and ask before renewing under a different name.
- A `workflow_dispatch` re-run of an old tag cannot sign (Google only admits a
  pushed tag), so once signing is on such a re-run fails rather than shipping
  unsigned. Cut a new tag instead.

### Changing the publisher name

A renewal under the **same** CN needs none of this (see "Every year").

Every install pins the `publisherNames` of the release it last took, and
refuses any update signed under a CN outside that list. So a CN change always
takes **two releases**, never one edit of the list. Two checks hold you to
that: the build requires the certificate's CN to be `publisherNames[0]`, and
the release requires it to be one of the names the Latest release already
pins.

0. **Get the new CN confirmed in writing first.** Step 1 has to name the new
   CN before the new certificate exists. Have the CA confirm, in writing, the
   exact Subject CN it will issue -- spelling, case, punctuation -- and do not
   start step 1 on a guess: a name that turns out wrong means repeating step 1
   and waiting another release cycle.
1. **While the old certificate is still valid**, append the new name:
   `["OLD NAME", "NEW NAME"]`, signed with the old certificate as before
   (which is why it must still be valid when you start). Ship that release and
   give it at least one full release cycle, so installs pick up a list that
   already trusts the new name.
2. **Then switch certificates**: commit the new chain and put the new name
   first, keeping the old one after it: `["NEW NAME", "OLD NAME"]`. The release
   check lets this through only while the step-1 release (or a later one
   listing the new name) is Latest; tried without step 1, it is refused.
3. Keep the old name for at least one more release cycle, so a release signed
   with the old certificate (a rollback) is still accepted, then remove it.

**An install that has not taken the step-1 release by the time step 2 ships
can never auto-update again.** It pins only the old name and refuses every
later update, and nothing a release does can reach it: its user has to
download the new version and reinstall it by hand. The longer step 1 is out,
the fewer such installs there are.

Never remove a name in the same release that stops signing with it. (A custom
`verifyUpdateCodeSignature` in the app's updater could one day accept a new
CN some other way; none exists today.)

### Accepted risk: any step of the release job can ask for the token

The build job is granted `id-token: write`, and GitHub cannot scope that to
one step or one matrix leg. While it is granted, any step of that job (on any
leg, including a dependency's install script) can request GitHub's OIDC token
and exchange it for a signing token. The Workload Identity condition limits
**which workflow and ref** can sign, not **which step**. The mitigations:

- every action in the build job is pinned by full commit SHA (a test fails
  if one is not), and jsign by sha256;
- npm dependencies are pinned by the lockfile, with integrity hashes -- but
  their install scripts still run in this job, so a malicious version that
  reaches the lockfile could ask for the token;
- the KMS audit log records every signing call.

Not pinned: the runner image, and the toolchains the setup steps fetch from
their vendors (Node, pnpm, Java). Treat an unexpected signing call in the
audit log as a compromise (below).

### If the key or a token is compromised

A signature made with this key -- through a leaked one-hour token, a
compromised step of the release job, or any other way of reaching the key --
is timestamped, so it **stays valid indefinitely**. The token expiring does
not end it, the certificate expiring does not end it, and disabling the key
does not end it. Only revoking the certificate does. So, in this order:

1. **Stop all signing.** Disable the key version in Cloud KMS
   (`gcloud kms keys versions disable 1 --key=sarv-inbox-authenticode
   --keyring=codesign --location=asia-south1 --project=sarv-inbox-signing`).
   Every release fails from here until the last step is done; that is
   intended.
2. **Cut GitHub's path in, before any re-key**, and keep it cut until the
   cause is found and fixed -- otherwise whatever leaked the token can sign
   with the new key too. Either disable the provider
   (`gcloud iam workload-identity-pools providers update-oidc sarv-inbox-tags
   --workload-identity-pool=github-release --location=global
   --project=sarv-inbox-signing --disabled`), or remove the service account's
   `roles/iam.workloadIdentityUser` binding (the `remove-iam-policy-binding`
   twin of the `add-iam-policy-binding` command in "Workload Identity
   Federation for GitHub" below).
3. **Find the first bad signature.** The KMS audit log (the `kms-audit`
   bucket) records every `AsymmetricSign` call with its caller and time. Match
   each one to a release you cut; the earliest call you cannot account for is
   the first bad signature. If you cannot pin it down, take the earliest
   moment anyone else could have reached the key.
4. **Ask Sectigo to revoke the certificate** (reason: key compromise) with a
   **revocation date before that first bad signature**. Windows keeps
   accepting a signature whose timestamp is before the revocation date and
   rejects every one after it, so the date decides which signatures die. Our
   own releases signed after that date stop verifying too and must be
   shipped again under the new certificate.
5. **Re-key.** Create a new key version (or a new key) in Cloud KMS, make a
   fresh attestation and CSR for it (step 4 of the setup), and schedule the
   old version for destruction. A new **version** of the same key keeps the
   service account's `roles/cloudkms.signer` binding (it sits on the key). A
   new **key** does not: grant the binding on the new key explicitly and
   remove it from the old one, then check both with `get-iam-policy`.
6. **Get a new certificate** for the new key from Sectigo, with the **same
   CN**. Commit its chain, and in the same change update `kms.keyVersion` (and
   the key name in it, for a new key) and `publicKeySha256` in
   `windows-signing.json` to the new key. `publisherNames` stays as it is, so
   installs keep accepting updates. Re-open GitHub's path in (step 2, undone)
   only once the cause is fixed, then cut a new release.

The same steps are in the leaked-secrets table of
[RELEASING.md](./RELEASING.md).

## Switching it on

Do these in order once the certificate has been issued. Steps 2 to 4 go in
one change.

1. **GitHub's identity in Google Cloud: done once, already.** The pool
   (`github-release`), its provider (`sarv-inbox-tags`) and the service
   account (`gha-authenticode`) exist. The commands in "Workload Identity
   Federation for GitHub" below are kept as the reference for rebuilding them.
   The provider's full name has the form
   `projects/<project number>/locations/global/workloadIdentityPools/github-release/providers/sarv-inbox-tags`;
   `gcloud iam workload-identity-pools providers describe sarv-inbox-tags
   --project=sarv-inbox-signing --location=global
   --workload-identity-pool=github-release --format='value(name)'` prints it.
2. **Fill in the provider.** Put that name into `workloadIdentityProvider` in
   `apps/desktop/build/windows-signing.json`.
3. **Commit the certificate chain** as
   `apps/desktop/build/windows-signing-chain.pem`: PEM, with **the code-signing
   certificate first**, then the intermediate(s). It is public; no key is in
   it.
4. **In the same change, set `publisherNames`** in `windows-signing.json` to
   the issued certificate's CN, exactly as issued (case and spacing included),
   as a one-name list: `["<CN>"]`. Read the CN off the certificate
   (`openssl x509 -in apps/desktop/build/windows-signing-chain.pem -noout -subject`
   prints the first certificate's subject) and check it is the company's exact
   legal name: it becomes permanent for auto-update. The chain and the name go
   in together; either one alone fails the build.
5. **Check it locally:** `node scripts/windows-signing.mjs status` must print
   `ENABLED, publisher "<CN>"` and `app-update.yml will pin ["<CN>"]`. If it
   fails, it says why (key mismatch, wrong order, expired, a CN that is not
   `publisherNames[0]`, ...). Adding `--previous-release Sarv/Inbox` (with `gh`
   logged in) also runs the release's check against the Latest release.
6. **Open a pull request.** CI runs the full test suite and the Windows signing
   self-test. Merge when green.
7. **Cut the next release as usual.** In the Windows job, the status step
   logs what the Latest release pins (nothing yet, for this first one); then
   watch for "Signing Windows binaries as ..." and the "Verify Windows
   Authenticode signatures" step ending in `OK`. Afterwards, on a Windows
   machine, the installer's Properties → Digital Signatures tab should show
   the company and a timestamp. **From the moment this release is published,
   every later Windows release must be signed under one of its names**; the
   release check enforces it.
8. **Renew before the certificate expires.** On its expiry date every release
   fails until the renewed chain is committed. Keep the CN identical, or follow
   "Changing the publisher name" above.

**If the switch-on release never published** (its build failed, or it was
stopped before `gh release create`), no install has seen its names. It is not
Latest, so the release check ignores it entirely: fix forward with a new tag,
or revert the switch-on, and nothing will object. The constraint starts only
with a signed release that was actually published.

### Workload Identity Federation for GitHub

Already created (see "Switching it on", step 1); kept here as the reference
for rebuilding it. Cloud Shell, same project as setup step 3. Only tokens for **this repository**, on
a **pushed `v*` tag**, running **`release.yml`**, on a **GitHub-hosted
runner** are admitted. Every claim the condition reads is mapped, as Google
requires.

The repository is matched twice: by its numeric id, and by name, because the
condition also pins the literal `workflow_ref`
(`Sarv/Inbox/.github/workflows/release.yml@refs/tags/v…`). So the match does
**not** survive a rename: renaming the repository or the organisation stops
signing until the condition is updated to the new name (which is the safe way
round: nothing signs by accident).

```bash
export PROJECT_ID=sarv-inbox-signing
export LOCATION=asia-south1
export KEY_RING=codesign
export KEY=sarv-inbox-authenticode
export POOL=github-release
export PROVIDER=sarv-inbox-tags
export SA_NAME=gha-authenticode
export SA="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
export GH_REPO_ID=1354572414        # Sarv/Inbox
export GH_OWNER_ID=23011303         # the Sarv organisation
export PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"

gcloud iam workload-identity-pools create "$POOL" --project="$PROJECT_ID" \
  --location=global --display-name="GitHub release signing"

gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" --project="$PROJECT_ID" \
  --location=global --workload-identity-pool="$POOL" --display-name="Sarv/Inbox release tags" \
  --issuer-uri="https://token.actions.githubusercontent.com" \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.repository_owner_id=assertion.repository_owner_id,attribute.event_name=assertion.event_name,attribute.ref=assertion.ref,attribute.ref_type=assertion.ref_type,attribute.workflow_ref=assertion.workflow_ref,attribute.runner_environment=assertion.runner_environment" \
  --attribute-condition="assertion.repository_id == '${GH_REPO_ID}' && assertion.repository_owner_id == '${GH_OWNER_ID}' && assertion.event_name == 'push' && assertion.ref_type == 'tag' && assertion.ref.startsWith('refs/tags/v') && assertion.workflow_ref.startsWith('Sarv/Inbox/.github/workflows/release.yml@refs/tags/v') && assertion.runner_environment == 'github-hosted'"

# The one identity GitHub may become. No keys, no project roles.
gcloud iam service-accounts create "$SA_NAME" --project="$PROJECT_ID" \
  --display-name="GitHub Actions Authenticode signer"
gcloud iam service-accounts add-iam-policy-binding "$SA" --project="$PROJECT_ID" \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/attribute.repository_id/${GH_REPO_ID}"

# Signing permission on THE ONE KEY only (not the ring, not the project).
gcloud kms keys add-iam-policy-binding "$KEY" --keyring="$KEY_RING" --location="$LOCATION" \
  --project="$PROJECT_ID" --member="serviceAccount:${SA}" --role=roles/cloudkms.signer

# Check: the key's policy lists the service account with roles/cloudkms.signer
# and nothing broader.
gcloud kms keys get-iam-policy "$KEY" --keyring="$KEY_RING" --location="$LOCATION" --project="$PROJECT_ID"

# This is the value for "workloadIdentityProvider":
gcloud iam workload-identity-pools providers describe "$PROVIDER" --project="$PROJECT_ID" \
  --location=global --workload-identity-pool="$POOL" --format='value(name)'
```

Notes:

- New pools, providers and grants can take a few minutes to take effect.
- The tag ruleset on the repository ("Protect release tags") already limits
  who can push a `v*` tag; this condition adds that only `release.yml` running
  from such a tag gets in.
- `roles/cloudkms.signer` is enough because the release pins the key version:
  jsign then signs without listing or reading key metadata.

### Optional: a dry run with a throwaway key

This proves the Google side (identity federation, KMS signing permission,
jsign, timestamps, Windows' own verification) end to end, without any release
and **without the production key or the production service account**.

**Never experiment with the production key.** The certificate is public, so
any signature the production key makes -- in a test, in a dry run, at any
time -- can later be wrapped with the real certificate into a valid
Authenticode signature by the company on whatever was signed. There is no
such thing as a "test" signature from that key, so not even a self-signed test
certificate is ever made from it. Everything below uses its own key ring, its
own throwaway HSM key, its own service account and its own identity pool.
Afterwards the provider, pool and service account are deleted and the key
version is destroyed; Cloud KMS cannot delete a key ring or a key, so the
empty ring and the destroyed key stay listed, unable to sign anything.

**Never push a `v*` tag to test**: every `v*` tag publishes a release to every
installed copy. Nothing from the dry-run branch is merged.

1. **Variables** (Cloud Shell). Every command below uses only these, plus
   `DRY_SHA`, set in step 5 (and `PKCS11_MODULE_PATH` / `KMS_PKCS11_CONFIG`,
   the two names Google's PKCS#11 library reads, set in step 3). Nothing here
   names the production ring, key, pool or service account. Re-run them in a
   new Cloud Shell session. Look up the three GitHub ids once, with `gh` or the
   API:

   ```bash
   export PROJECT_ID=sarv-inbox-signing
   export LOCATION=asia-south1
   export DRY_KEY_RING=codesign-dryrun             # NOT the production ring
   export DRY_KEY=authenticode-dryrun              # throwaway HSM key
   export DRY_SA_NAME=gha-authenticode-dryrun      # NOT the production service account
   export DRY_SA="${DRY_SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
   export DRY_POOL=github-dryrun                   # NOT the production pool
   export DRY_PROVIDER=dryrun-scratch
   export DRY_BRANCH=test/windows-signing-dry-run
   export DRY_WORKFLOW=windows-signing-dry-run.yml
   export GH_REPO=Sarv/Inbox
   export GH_REPO_ID=XXXX      # gh api repos/Sarv/Inbox --jq .id
   export GH_OWNER_ID=XXXX     # gh api orgs/Sarv --jq .id
   export GH_ACTOR_ID=XXXX     # YOUR numeric GitHub id: gh api user --jq .id
   export DRY_KMSP11_DIR="$HOME/kmsp11-dryrun"     # NOT the production ~/kmsp11
   export PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
   export DRY_ME="user:$(gcloud config get-value account)"
   ```

2. **A throwaway key in its own ring**, RSA-3072 in the HSM like the real one:

   ```bash
   gcloud kms keyrings create "$DRY_KEY_RING" --location="$LOCATION" --project="$PROJECT_ID"
   gcloud kms keys create "$DRY_KEY" --keyring="$DRY_KEY_RING" --location="$LOCATION" --project="$PROJECT_ID" \
     --purpose=asymmetric-signing --default-algorithm=rsa-sign-pkcs1-3072-sha256 \
     --protection-level=hsm --labels=use=dryrun
   ```

3. **A self-signed test certificate made from the THROWAWAY key**, through
   Google's PKCS#11 library installed into its own directory and pointed at
   the dry-run ring only. Your own permission is granted on the throwaway key
   and its ring only, and removed again straight after:

   ```bash
   gcloud kms keyrings add-iam-policy-binding "$DRY_KEY_RING" --location="$LOCATION" --project="$PROJECT_ID" \
     --member="$DRY_ME" --role=roles/cloudkms.viewer
   gcloud kms keys add-iam-policy-binding "$DRY_KEY" --keyring="$DRY_KEY_RING" --location="$LOCATION" \
     --project="$PROJECT_ID" --member="$DRY_ME" --role=roles/cloudkms.signerVerifier

   # Google's PKCS#11 library, checked against Google's release-signing key:
   gcloud auth application-default login
   sudo apt-get update && sudo apt-get install -y libengine-pkcs11-openssl
   mkdir -p "$DRY_KMSP11_DIR" && cd "$DRY_KMSP11_DIR"
   curl -sSLO https://github.com/GoogleCloudPlatform/kms-integrations/releases/download/pkcs11-v1.9/libkmsp11-1.9-linux-amd64.tar.gz
   tar xzf libkmsp11-1.9-linux-amd64.tar.gz
   cat > pkcs11-release-signing-key.pem <<'PEM'
   -----BEGIN PUBLIC KEY-----
   MHYwEAYHKoZIzj0CAQYFK4EEACIDYgAEtfLbXkHUVc9oUPTNyaEK3hIwmuGRoTtd
   6zDhwqjJuYaMwNd1aaFQLMawTwZgR0Xn27ymVWtqJHBe0FU9BPIQ+SFmKw+9jSwu
   /FuqbJnLmTnWMJ1jRCtyHNZawvv2wbiB
   -----END PUBLIC KEY-----
   PEM
   export PKCS11_MODULE_PATH="$(find "$DRY_KMSP11_DIR" -name libkmsp11.so | head -1)"
   openssl dgst -sha384 -verify pkcs11-release-signing-key.pem \
     -signature "${PKCS11_MODULE_PATH}.sig" "$PKCS11_MODULE_PATH"     # must print: Verified OK

   # The library sees the dry-run ring and nothing else:
   printf -- '---\ntokens:\n  - key_ring: "projects/%s/locations/%s/keyRings/%s"\n' \
     "$PROJECT_ID" "$LOCATION" "$DRY_KEY_RING" > "$DRY_KMSP11_DIR/dryrun-config.yaml"
   chmod 600 "$DRY_KMSP11_DIR/dryrun-config.yaml"
   export KMS_PKCS11_CONFIG="$DRY_KMSP11_DIR/dryrun-config.yaml"

   openssl req -new -x509 -sha256 -days 7 -engine pkcs11 -keyform engine -key "pkcs11:object=${DRY_KEY}" \
     -subj "/CN=Sarv Inbox KMS DRY RUN/O=TEST ONLY" \
     -addext "basicConstraints=critical,CA:FALSE" -addext "keyUsage=critical,digitalSignature" \
     -addext "extendedKeyUsage=codeSigning" -out "$DRY_KMSP11_DIR/dry-run-chain.pem"

   # The publicKeySha256 for the dry-run config:
   gcloud kms keys versions get-public-key 1 --key="$DRY_KEY" --keyring="$DRY_KEY_RING" \
     --location="$LOCATION" --project="$PROJECT_ID" --output-file="$DRY_KMSP11_DIR/dry-run-pub.pem"
   openssl pkey -pubin -in "$DRY_KMSP11_DIR/dry-run-pub.pem" -outform DER | sha256sum

   gcloud kms keys remove-iam-policy-binding "$DRY_KEY" --keyring="$DRY_KEY_RING" --location="$LOCATION" \
     --project="$PROJECT_ID" --member="$DRY_ME" --role=roles/cloudkms.signerVerifier
   gcloud kms keyrings remove-iam-policy-binding "$DRY_KEY_RING" --location="$LOCATION" --project="$PROJECT_ID" \
     --member="$DRY_ME" --role=roles/cloudkms.viewer
   ```

4. **The dry-run commit, on `test/windows-signing-dry-run` only** (the
   developer can prepare it). Commit it but do **not** push yet: the identity
   condition in step 5 pins this exact commit.
   - `dry-run-chain.pem` (in `$DRY_KMSP11_DIR`) as
     `apps/desktop/build/windows-signing-chain.pem`;
   - in `apps/desktop/build/windows-signing.json`: `kms.keyRing`
     `projects/<PROJECT_ID>/locations/<LOCATION>/keyRings/codesign-dryrun`,
     `kms.keyVersion` `authenticode-dryrun/cryptoKeyVersions/1`,
     `publicKeySha256` from step 3, `publisherNames`
     `["Sarv Inbox KMS DRY RUN"]`, `serviceAccount` the value of `$DRY_SA`,
     and `workloadIdentityProvider`
     `projects/<PROJECT_NUMBER>/locations/global/workloadIdentityPools/github-dryrun/providers/dryrun-scratch`
     (the name is known before the provider exists);
   - `.github/workflows/windows-signing-dry-run.yml`:

   ```yaml
   name: Windows signing dry run
   on:
     push:
       branches: [test/windows-signing-dry-run]
   permissions:
     contents: read
     id-token: write
   jobs:
     dry-run:
       runs-on: windows-latest
       steps:
         - uses: actions/checkout@v7
         - uses: ./.github/actions/setup-workspace
         - id: winsign
           shell: bash
           run: node scripts/windows-signing.mjs status --github-output
         - uses: actions/setup-java@de7274f081f381c8f8158605e0321c36c376e2e6 # v6.0.1
           with: { distribution: temurin, java-version: '17' }
         - id: jsign
           shell: bash
           run: node scripts/windows-signing.mjs fetch-jsign --dest "$RUNNER_TEMP/jsign" --github-output
         - id: gcp
           uses: google-github-actions/auth@7c6bc770dae815cd3e89ee6cdf493a5fab2cc093 # v3.0.0
           with:
             workload_identity_provider: ${{ steps.winsign.outputs.provider }}
             service_account: ${{ steps.winsign.outputs.service_account }}
             token_format: access_token
             access_token_lifetime: 600s
             access_token_scopes: https://www.googleapis.com/auth/cloudkms
             create_credentials_file: false
             export_environment_variables: false
         - name: Sign a test binary through the release hook
           shell: powershell
           env:
             SARV_WINDOWS_SIGNING_TOKEN: ${{ steps.gcp.outputs.access_token }}
             JSIGN_JAR: ${{ steps.jsign.outputs.path }}
             PUBLISHER_NAMES: ${{ steps.winsign.outputs.publisher_names }}
           run: |
             $ErrorActionPreference = 'Stop'
             $exe = Join-Path $env:RUNNER_TEMP 'dry-run.exe'
             Add-Type -OutputAssembly $exe -OutputType ConsoleApplication -TypeDefinition 'public static class P { public static int Main() { return 0; } }'
             certutil -addstore -f Root apps\desktop\build\windows-signing-chain.pem
             Set-Location apps\desktop
             node -e "require('./build/windowsSign.js').default({ path: process.argv[1], hash: 'sha256', isNest: false, options: { forceCodeSigning: true, signtoolOptions: { publisherName: JSON.parse(process.env.PUBLISHER_NAMES) } } }).catch((e) => { console.error(e); process.exit(1) })" $exe
             Get-AuthenticodeSignature -LiteralPath $exe | Format-List Status, StatusMessage, SignerCertificate, TimeStamperCertificate
   ```

   Then note the commit's full sha: `git rev-parse HEAD`.

5. **A separate service account, pool and provider** that admit only that
   scratch workflow, on that branch, pushed by you, at that exact commit:

   ```bash
   export DRY_SHA=XXXX    # the full 40-character sha from step 4

   gcloud iam service-accounts create "$DRY_SA_NAME" --project="$PROJECT_ID" \
     --display-name="Authenticode dry run (throwaway key only)"
   gcloud kms keys add-iam-policy-binding "$DRY_KEY" --keyring="$DRY_KEY_RING" --location="$LOCATION" \
     --project="$PROJECT_ID" --member="serviceAccount:${DRY_SA}" --role=roles/cloudkms.signer

   gcloud iam workload-identity-pools create "$DRY_POOL" --project="$PROJECT_ID" --location=global \
     --display-name="Authenticode dry run"
   gcloud iam workload-identity-pools providers create-oidc "$DRY_PROVIDER" --project="$PROJECT_ID" \
     --location=global --workload-identity-pool="$DRY_POOL" \
     --issuer-uri="https://token.actions.githubusercontent.com" \
     --attribute-mapping="google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.repository_owner_id=assertion.repository_owner_id,attribute.actor_id=assertion.actor_id,attribute.event_name=assertion.event_name,attribute.ref=assertion.ref,attribute.sha=assertion.sha,attribute.workflow_ref=assertion.workflow_ref,attribute.runner_environment=assertion.runner_environment" \
     --attribute-condition="assertion.repository_id == '${GH_REPO_ID}' && assertion.repository_owner_id == '${GH_OWNER_ID}' && assertion.actor_id == '${GH_ACTOR_ID}' && assertion.event_name == 'push' && assertion.ref == 'refs/heads/${DRY_BRANCH}' && assertion.sha == '${DRY_SHA}' && assertion.workflow_ref == '${GH_REPO}/.github/workflows/${DRY_WORKFLOW}@refs/heads/${DRY_BRANCH}' && assertion.runner_environment == 'github-hosted'"

   gcloud iam service-accounts add-iam-policy-binding "$DRY_SA" --project="$PROJECT_ID" \
     --role=roles/iam.workloadIdentityUser \
     --member="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${DRY_POOL}/attribute.repository_id/${GH_REPO_ID}"

   # Check: the provider name matches the one committed in step 4.
   gcloud iam workload-identity-pools providers describe "$DRY_PROVIDER" --project="$PROJECT_ID" \
     --location=global --workload-identity-pool="$DRY_POOL" --format='value(name)'
   ```

   Wait a few minutes for the grants to take effect, then push the branch.
   The last step should show `Status : Valid`, the "Sarv Inbox KMS DRY RUN"
   signer and a DigiCert timestamp, and the audit log should show one
   `AsymmetricSign` on the **dry-run** key by the **dry-run** service account.
   (Optionally, push one more commit: its run must fail at the Google login,
   which is the sha pin working.) Only the dry-run workflow runs on these
   pushes: CI and CodeQL run on `main`, `dev` and pull requests, and the
   release on `v*` tags. Do not open a pull request from the branch; CI would
   then run, and its tests fail on purpose against a non-production config.

6. **Tear it all down, the same day:**

   ```bash
   gcloud iam workload-identity-pools providers delete "$DRY_PROVIDER" --project="$PROJECT_ID" \
     --location=global --workload-identity-pool="$DRY_POOL" --quiet
   gcloud iam workload-identity-pools delete "$DRY_POOL" --project="$PROJECT_ID" --location=global --quiet
   gcloud iam service-accounts delete "$DRY_SA" --project="$PROJECT_ID" --quiet
   # Schedules the throwaway key version for destruction (Cloud KMS keeps it
   # recoverable for the scheduled-destruction period, then destroys it).
   gcloud kms keys versions destroy 1 --key="$DRY_KEY" --keyring="$DRY_KEY_RING" \
     --location="$LOCATION" --project="$PROJECT_ID"
   rm -rf "$DRY_KMSP11_DIR"
   ```

   Cloud KMS cannot delete a key ring or a key, so the empty `codesign-dryrun`
   ring and its destroyed key stay listed; they can sign nothing. Delete the
   `test/windows-signing-dry-run` branch on GitHub. The real switch-on (above)
   uses the CA's certificate on the production key, never anything from here.

## Sources

- Microsoft, Artifact Signing quickstart (eligibility):
  https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart
- Microsoft, SmartScreen reputation:
  https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation
- CA/B Forum Code Signing Baseline Requirements v3.11.0:
  https://cabforum.org/working-groups/code-signing/requirements/
- Sectigo, OV code signing validation:
  https://www.sectigo.com/knowledge-base/detail/OV-Code-Signing-Validation-for-Organizations-and-Individuals
- Sectigo, Key Attestation for Code Signing – Guide for Partners v2.2 (March 2026)
- SectigoStore, Google Cloud KMS walkthrough:
  https://sectigostore.com/blog/google-cloud-kms-for-code-signing/
- Google Cloud KMS: attest a key https://docs.cloud.google.com/kms/docs/attest-key ,
  PKCS#11 with OpenSSL https://docs.cloud.google.com/kms/docs/reference/pkcs11-openssl ,
  audit logging https://docs.cloud.google.com/kms/docs/audit-logging
- Workload Identity Federation with GitHub:
  https://docs.cloud.google.com/iam/docs/workload-identity-federation-with-deployment-pipelines
- jsign: https://ebourg.github.io/jsign/
