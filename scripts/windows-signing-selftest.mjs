#!/usr/bin/env node
/*
 * End-to-end self-test of the Windows signing pipeline, run by CI
 * (.github/workflows/ci.yml, "Windows signing self-test") on windows-latest.
 *
 * Why this exists. The release signs with an HSM key nobody can use outside a
 * tagged release, so the signing code would otherwise first run for real on
 * the release that switches signing on -- the one release that must not fail
 * in a new way. This runs the SAME core (signPeFile, the jsign argument
 * builder, the certificate-table reader, the Get-AuthenticodeSignature query
 * and its evaluator, verifyWindowsRelease) with real jsign and real Windows
 * trust checks, against throwaway self-signed certificates the workflow
 * creates and trusts on the runner. Only the signer differs: PKCS12 here,
 * GOOGLECLOUD in the release. There is no switch that points the release hook
 * at another key; this script calls the core directly.
 *
 * Usage (after the workflow step that creates the certificates):
 *   node scripts/windows-signing-selftest.mjs <work-dir>
 *
 * <work-dir> holds self.p12 and other.p12 (password in
 * SARV_WINDOWS_SIGNING_SELFTEST_PASSWORD) and unsigned.exe. The subjects come
 * from SELFTEST_PUBLISHER and SELFTEST_UPSTREAM; JSIGN_JAR names the jar.
 */

import { X509Certificate } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  DEFAULT_UNPACKED_DIRS,
  JSIGN_JAR_ENV,
  evaluateSignatures,
  loadWindowsSigningConfig,
  pkcs12Signer,
  queryAuthenticode,
  sha256File,
  signPeFile,
  signingSettings,
  verifyWindowsRelease,
} from './lib/windows-signing.mjs';

const PASSWORD_ENV = 'SARV_WINDOWS_SIGNING_SELFTEST_PASSWORD';

/** @type {string[]} */
const failures = [];
/**
 * @param {boolean} condition
 * @param {string} message What broke, phrased as the regression.
 */
function check(condition, message) {
  if (condition) {
    console.log(`PASS: ${message}`);
  } else {
    console.error(`FAIL: ${message}`);
    failures.push(message);
  }
}

/**
 * @param {string} from
 * @param {string} to
 */
function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

async function main(argv) {
  const [workDir] = argv;
  const { SELFTEST_PUBLISHER: publisher, SELFTEST_UPSTREAM: upstream } = process.env;
  const jar = process.env[JSIGN_JAR_ENV];
  if (
    process.platform !== 'win32' ||
    !workDir ||
    !publisher ||
    !upstream ||
    !jar ||
    !process.env[PASSWORD_ENV]
  ) {
    console.error(
      'usage (Windows, CI): SELFTEST_PUBLISHER=… SELFTEST_UPSTREAM=… JSIGN_JAR=… ' +
        `${PASSWORD_ENV}=… node scripts/windows-signing-selftest.mjs <work-dir>`
    );
    return 2;
  }

  // The committed config supplies the timestamp servers, program name/URL and
  // the jar digest: the self-test signs the way the release signs.
  const { config } = loadWindowsSigningConfig();
  check(
    sha256File(jar) === config.jsign.sha256,
    `the jar at ${jar} is the pinned jsign ${config.jsign.version}`
  );
  const settings = signingSettings(config);
  const self = pkcs12Signer({
    keystore: path.join(workDir, 'self.p12'),
    passwordEnv: PASSWORD_ENV,
  });
  const other = pkcs12Signer({
    keystore: path.join(workDir, 'other.p12'),
    passwordEnv: PASSWORD_ENV,
  });
  const sign = (
    /** @type {string} */ file,
    /** @type {import('./lib/windows-signing.mjs').Signer} */ signer
  ) => signPeFile({ file, signer, settings, jar, retryDelaysMs: [5_000, 15_000] });

  const unsigned = path.join(workDir, 'unsigned.exe');
  const release = path.join(workDir, 'release');
  fs.rmSync(release, { recursive: true, force: true });

  // The shape of a real Windows release: two apps and one installer. Every
  // binary is a copy of the same tiny .NET program; jsign and Windows decide
  // what a file is by its content, not its name. In the second app,
  // elevate.exe arrives already signed by someone else: a helper that is not
  // one of OUR files may keep a signature it came with.
  /** @type {string[]} */
  const ours = [];
  /** @type {string[]} */
  const upstreamSigned = [];
  for (const [index, name] of DEFAULT_UNPACKED_DIRS.entries()) {
    const dir = path.join(release, name);
    const elevate = 'resources/elevate.exe';
    for (const relative of [
      'Sarv Inbox Self-Test.exe',
      elevate,
      'resources/app.asar.unpacked/addon.node',
      'ffmpeg.dll',
      'd3dcompiler_47.dll',
    ]) {
      const file = path.join(dir, relative);
      copy(unsigned, file);
      const arrivesSigned =
        relative === 'd3dcompiler_47.dll' || (relative === elevate && index === 1);
      (arrivesSigned ? upstreamSigned : ours).push(file);
    }
    fs.writeFileSync(
      path.join(dir, 'resources', 'app-update.yml'),
      `owner: Sarv\nrepo: Inbox\nprovider: github\npublisherName:\n  - ${publisher}\n`
    );
  }
  const installer = path.join(release, 'Sarv-Inbox-Setup-0.0.0-selftest.exe');
  copy(unsigned, installer);
  ours.push(installer);

  // 1. A file that arrives already signed by someone else (Microsoft's
  //    d3dcompiler_47.dll in a real build) must keep that signature.
  for (const file of upstreamSigned) {
    check(
      (await sign(file, other)).status === 'signed',
      `pre-signing ${path.relative(release, file)} with the upstream certificate`
    );
  }
  const upstreamBytes = upstreamSigned.map((file) => sha256File(file));

  // 2. Every one of our files gets signed (.exe, .dll, .node, installer).
  for (const file of ours) {
    check((await sign(file, self)).status === 'signed', `signing ${path.relative(release, file)}`);
  }

  // 3. Offered to the hook again, a signed file is a no-op: electron-builder's
  //    own retry, or a second pass, must not re-sign or nest a signature.
  for (const [index, file] of upstreamSigned.entries()) {
    check(
      (await sign(file, self)).status === 'skipped',
      `already-signed ${path.relative(release, file)} is skipped`
    );
    check(
      sha256File(file) === upstreamBytes[index],
      `${path.relative(release, file)} keeps its upstream signature byte for byte`
    );
  }
  const installerBytes = sha256File(installer);
  check(
    (await sign(installer, self)).status === 'skipped',
    'a second sign call on the installer is a no-op'
  );
  check(
    sha256File(installer) === installerBytes,
    'the installer bytes are unchanged by the second call'
  );

  // 4. The release verifier, exactly as release.yml runs it: Valid, timestamped,
  //    ours signed by the publisher, upstream-signed helpers allowed,
  //    app-update.yml pinned.
  // Our own files must carry THE committed certificate, not just our CN: the
  // workflow exported ours as self.cer, the stand-in for the committed leaf.
  const leafSha256 = new X509Certificate(fs.readFileSync(path.join(workDir, 'self.cer')))
    .fingerprint256;
  const status = { enabled: true, publisherNames: [publisher], leafSha256 };
  const verdict = await verifyWindowsRelease({ releaseDir: release, status });
  for (const problem of verdict.problems) console.error(`  problem: ${problem}`);
  for (const note of verdict.notes) console.log(`  note: ${note}`);
  check(verdict.problems.length === 0, 'verify-win-signatures passes a correctly signed release');
  check(
    verdict.checked === ours.length + upstreamSigned.length,
    `every PE file was checked (${verdict.checked})`
  );
  check(
    verdict.notes.length === upstreamSigned.length,
    'each upstream-signed file is reported as such'
  );

  // 5. An unsigned file fails, as does one of OUR files signed by someone else.
  const neverSigned = path.join(workDir, 'never-signed.exe');
  copy(unsigned, neverSigned);
  const foreignExe = path.join(workDir, 'foreign.exe');
  copy(unsigned, foreignExe);
  await sign(foreignExe, other);
  const results = await queryAuthenticode([neverSigned, foreignExe]);
  const unsignedVerdict = evaluateSignatures(
    [{ path: neverSigned, kind: 'other', result: results[0] }],
    [publisher]
  );
  check(
    unsignedVerdict.problems.some((problem) => problem.includes('NotSigned')),
    'an unsigned file fails verification'
  );
  const foreignVerdict = evaluateSignatures(
    [{ path: foreignExe, kind: 'own', result: results[1] }],
    [publisher],
    { leafSha256 }
  );
  check(
    foreignVerdict.problems.some((problem) => problem.includes(upstream)),
    'our app .exe signed by another certificate fails verification'
  );

  // 6. An unsigned DLL slipped into the app, and an app-update.yml without the
  //    publisher, both fail the release verifier.
  const lateDll = path.join(release, DEFAULT_UNPACKED_DIRS[0], 'late.dll');
  copy(unsigned, lateDll);
  const appUpdate = path.join(release, DEFAULT_UNPACKED_DIRS[1], 'resources', 'app-update.yml');
  fs.writeFileSync(appUpdate, 'owner: Sarv\nrepo: Inbox\nprovider: github\n');
  const broken = await verifyWindowsRelease({ releaseDir: release, status });
  check(
    broken.problems.some((problem) => problem.includes('late.dll')),
    'an unsigned DLL in the app fails the release verifier'
  );
  check(
    broken.problems.some((problem) => problem.includes('app-update.yml')),
    'a signed build whose app-update.yml pins no publisher fails'
  );

  if (failures.length > 0) {
    console.error(
      `\n${failures.length} self-test check(s) failed. The release signing pipeline is broken; do not switch it on.`
    );
    return 1;
  }
  console.log(
    '\nOK: jsign signs, Windows trusts, and the release verifier judges exactly as the release will.'
  );
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    console.error(error);
    process.exit(1);
  }
);
