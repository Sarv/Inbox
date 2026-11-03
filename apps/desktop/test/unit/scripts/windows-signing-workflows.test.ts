import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

import { builderOptionsProblems } from '../../../../../scripts/lib/windows-signing.mjs';

/**
 * Guards the GitHub Actions half of Windows Authenticode signing: the steps
 * in .github/workflows/release.yml that obtain the Google token, hand it to
 * electron-builder, and check the result, and CI's Windows self-test.
 *
 * A workflow is only exercised by a pushed tag, and a tag publishes a release
 * to every installed copy within the hour. So a step that moved, lost its
 * platform gate or its pin is caught here, by `pnpm test`, rather than by the
 * release it breaks. Every regression named below has the same consequence: a
 * Windows release that is unsigned, signed with nothing verified, or that
 * leaks the signing token to a leg that does not need it.
 */

type Step = {
  name?: string;
  id?: string;
  uses?: string;
  if?: string;
  run?: string;
  shell?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
};
type Job = {
  name?: string;
  'runs-on'?: string;
  permissions?: Record<string, string>;
  steps: Step[];
  env?: Record<string, string>;
};
type Workflow = { permissions?: Record<string, string>; jobs: Record<string, Job> };

const workflowText = (name: string) =>
  readFileSync(
    fileURLToPath(new URL(`../../../../../.github/workflows/${name}`, import.meta.url)),
    'utf8'
  );
const workflow = (name: string) => parseYaml(workflowText(name)) as Workflow;

const release = workflow('release.yml');
const ci = workflow('ci.yml');
const build = release.jobs['build'];
const publish = release.jobs['publish'];

const indexOf = (steps: Step[], predicate: (step: Step) => boolean, what: string): number => {
  const index = steps.findIndex(predicate);
  expect(index, `${what} not found`).toBeGreaterThanOrEqual(0);
  return index;
};
const byName = (steps: Step[], name: string) =>
  indexOf(steps, (step) => step.name === name, `step "${name}"`);
const byRun = (steps: Step[], text: string) =>
  indexOf(steps, (step) => step.run?.includes(text) ?? false, `step running "${text}"`);
const byUses = (steps: Step[], action: string) =>
  indexOf(steps, (step) => step.uses?.startsWith(`${action}@`) ?? false, `step using ${action}`);

const AUTH_SHA = '7c6bc770dae815cd3e89ee6cdf493a5fab2cc093';

/**
 * electron-builder's OWN command-line parser -- createYargs() and
 * configureBuildCommand() from electron-builder/out/builder.js, then its
 * normalizeOptions() -- run on an argv without building anything. Returns the
 * `config` object electron-builder would hand app-builder-lib.
 */
type BuilderCliConfig = {
  win?: { forceCodeSigning?: unknown; signtoolOptions?: { publisherName?: unknown } };
};
const parseElectronBuilderArgs = (argv: string[]): BuilderCliConfig | undefined => {
  const builder = createRequire(import.meta.url)('electron-builder/out/builder.js');
  let captured: Record<string, unknown> | undefined;
  builder
    .createYargs()
    .command(
      ['build', '*'],
      'Build',
      builder.configureBuildCommand,
      (args: Record<string, unknown>) => {
        captured = args;
      }
    )
    .strict()
    .parse(argv);
  return builder.normalizeOptions(captured).config;
};

// Old bash (macOS's /bin/bash 3.2) treats "${EMPTY[@]}" as unbound under
// set -u; the release runners (Git Bash, Ubuntu) do not. Only the unsigned
// case expands an empty EXTRA, so only it needs a modern bash.
const bashAvailable = process.platform !== 'win32';
const bashExpandsEmptyArrays = (() => {
  if (!bashAvailable) return false;
  try {
    execFileSync('bash', ['-c', 'set -u; a=(); : "${a[@]}"'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
const ENABLED_WIN = "matrix.platform == 'win' && steps.winsign.outputs.enabled == 'true'";

describe('release.yml: permissions', () => {
  // A job-level block REPLACES the workflow default, so id-token alone would
  // silently drop contents: read and break checkout of a private fork.
  it('grants the build job exactly contents: read and id-token: write', () => {
    expect(build.permissions).toEqual({ contents: 'read', 'id-token': 'write' });
  });

  // id-token must not leak to the workflow default or to the publish job,
  // which already holds contents: write.
  it('keeps id-token out of the default and the publish job', () => {
    expect(release.permissions).toEqual({ contents: 'read' });
    expect(publish.permissions).toEqual({ contents: 'write' });
    expect(release.jobs['verify'].permissions).toBeUndefined();
  });
});

describe('release.yml: the Windows signing steps', () => {
  const steps = build.steps;

  // Status first: a misconfigured enabled config must stop the job before
  // anything is built, and every later step branches on its outputs.
  // Changed deliberately: the step now also checks the build against what
  // the release marked Latest pins (--previous-release, with the job's token);
  // without it a revert of the switch-on would ship unsigned as Latest.
  it('computes the signing status on Windows, before anything that uses it', () => {
    const status =
      steps[indexOf(steps, (step) => step.id === 'winsign', 'the winsign status step')];
    expect(status.if).toBe("matrix.platform == 'win'");
    expect(status.run).toBe(
      'node scripts/windows-signing.mjs status --previous-release "$GITHUB_REPOSITORY" --github-output'
    );
    expect(status.env).toEqual({ GH_TOKEN: '${{ github.token }}' });
    // After the install (the script needs yaml), before Java, jsign, auth, Package.
    const statusAt = steps.indexOf(status);
    expect(statusAt).toBeGreaterThan(byName(steps, 'Install dependencies'));
    for (const later of [
      byUses(steps, 'actions/setup-java'),
      byRun(steps, 'fetch-jsign'),
      byUses(steps, 'google-github-actions/auth'),
      byName(steps, 'Package ${{ matrix.platform }}'),
    ]) {
      expect(later).toBeGreaterThan(statusAt);
    }
  });

  // The auth action sees the OIDC capability: pinned by full commit SHA,
  // Windows-only and only when enabled, an access token for Cloud KMS only,
  // no credentials file and nothing exported to later steps.
  it('authenticates to Google only on Windows, only when enabled, pinned by SHA', () => {
    const auth = steps[byUses(steps, 'google-github-actions/auth')];
    expect(auth.uses).toBe(`google-github-actions/auth@${AUTH_SHA}`);
    expect(auth.id).toBe('gcp');
    expect(auth.if).toBe(ENABLED_WIN);
    expect(auth.with).toEqual({
      workload_identity_provider: '${{ steps.winsign.outputs.provider }}',
      service_account: '${{ steps.winsign.outputs.service_account }}',
      token_format: 'access_token',
      access_token_lifetime: '3600s',
      access_token_scopes: 'https://www.googleapis.com/auth/cloudkms',
      create_credentials_file: false,
      export_environment_variables: false,
    });
    // Immediately before packaging: the token lives one hour.
    expect(byName(steps, 'Package ${{ matrix.platform }}')).toBe(steps.indexOf(auth) + 1);
  });

  // Java and the jar are Windows-only, enabled-only, and pinned.
  it('sets up a pinned Java and the checksum-verified jsign only when enabled', () => {
    const java = steps[byUses(steps, 'actions/setup-java')];
    expect(java.uses).toMatch(/^actions\/setup-java@[0-9a-f]{40}$/);
    expect(java.if).toBe(ENABLED_WIN);
    expect(java.with).toEqual({ distribution: 'temurin', 'java-version': '17' });
    const jsign = steps[byRun(steps, 'fetch-jsign')];
    expect(jsign.id).toBe('jsign');
    expect(jsign.if).toBe(ENABLED_WIN);
  });

  // CSC_LINK must stay mac-only: electron-builder falls back from WIN_CSC_LINK
  // to CSC_LINK, so ungated it would hand the Apple .p12 to the Windows build.
  // The Google token, the jar and the publisher names are Windows-only for the
  // same reason.
  it("gates each platform's signing secrets to that platform", () => {
    const env = steps[byName(steps, 'Package ${{ matrix.platform }}')].env ?? {};
    expect(env['CSC_LINK']).toBe(
      "${{ matrix.platform == 'mac' && secrets.APPLE_CERTIFICATE_P12 || '' }}"
    );
    expect(env['CSC_KEY_PASSWORD']).toBe(
      "${{ matrix.platform == 'mac' && secrets.APPLE_CERTIFICATE_PASSWORD || '' }}"
    );
    expect(env['SARV_WINDOWS_SIGNING_TOKEN']).toBe(
      "${{ matrix.platform == 'win' && steps.gcp.outputs.access_token || '' }}"
    );
    expect(env['JSIGN_JAR']).toBe(
      "${{ matrix.platform == 'win' && steps.jsign.outputs.path || '' }}"
    );
    expect(env['WIN_SIGNING_ENABLED']).toBe(
      "${{ matrix.platform == 'win' && steps.winsign.outputs.enabled || '' }}"
    );
    expect(env['WIN_PUBLISHER']).toBe(
      "${{ matrix.platform == 'win' && steps.winsign.outputs.publisher || '' }}"
    );
    expect(env['WIN_PUBLISHER_NAMES']).toBe(
      "${{ matrix.platform == 'win' && steps.winsign.outputs.publisher_names || '' }}"
    );
  });

  // forceCodeSigning and the publisherName are added ONLY in the enabled
  // Windows branch: anywhere else, an unsigned build would pin a publisher.
  // Changed deliberately: publisherName is now one flag per pinned name (the
  // whole publisherNames list), built in a loop, not one derived publisher.
  it('passes forceCodeSigning and the pinned publisher names only when signing', () => {
    const run = steps[byName(steps, 'Package ${{ matrix.platform }}')].run ?? '';
    const branch = run.slice(
      run.indexOf('"${WIN_SIGNING_ENABLED}" == "true"'),
      run.indexOf('elif [[ "${{ matrix.platform }}" == "win" ]]')
    );
    expect(branch).toContain('EXTRA+=(-c.win.forceCodeSigning=true)');
    expect(branch).toContain('EXTRA+=("-c.win.signtoolOptions.publisherName=${NAME}")');
    expect(branch).toContain('process.env.WIN_PUBLISHER_NAMES');
    expect(run.split('-c.win.signtoolOptions.publisherName').length - 1).toBe(1);
    expect(run.split('-c.win.forceCodeSigning').length - 1).toBe(1);
    expect(run).toContain('::warning::Windows code signing is not switched on yet');
    // The token is never interpolated into the script, where it would be logged.
    expect(run).not.toContain('SARV_WINDOWS_SIGNING_TOKEN');
    expect(run).not.toContain('steps.gcp');
  });

  /**
   * The Package step's real bash, run for the Windows leg with `pnpm` stubbed
   * to record its argv instead of building. What it returns is exactly what
   * electron-builder's CLI would receive.
   */
  const packageArgv = (env: Record<string, string>): string[] => {
    const run = steps[byName(steps, 'Package ${{ matrix.platform }}')].run ?? '';
    const script = run
      .split('${{ matrix.platform }}')
      .join('win')
      .split('${{ matrix.args }}')
      .join('--win');
    expect(script).not.toContain('${{');
    const dir = mkdtempSync(join(tmpdir(), 'winsign-package-'));
    try {
      const argvFile = join(dir, 'argv');
      const stub = `pnpm() { printf '%s\\0' "$@" > "$ARGV_FILE"; }\n`;
      execFileSync('bash', ['-c', stub + script], {
        env: {
          PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ''}`,
          HAS_APPLE_CERT: 'false',
          ARGV_FILE: argvFile,
          ...env,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return readFileSync(argvFile, 'utf8').split('\0').slice(0, -1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const signingEnv = (names: string[]) => ({
    WIN_SIGNING_ENABLED: 'true',
    WIN_PUBLISHER: names[0],
    WIN_PUBLISHER_NAMES: JSON.stringify(names),
  });

  // End to end, through the real bash and electron-builder's real parser: a
  // CN change's two names -- with spaces -- must reach electron-builder as
  // ONE list, in order, that the hook then accepts. A quoting slip splits a
  // name into words; a single flag would drop the old name and strand the
  // installs still pinned to it.
  // Skipped where there is no POSIX bash to run the step's script (Windows).
  it.skipIf(!bashAvailable)(
    'hands electron-builder the whole publisher list, intact, through bash and its CLI parser',
    () => {
      const names = ['SARV WEBS PRIVATE LIMITED', 'Sarv Webs Old Name Ltd.'];
      const argv = packageArgv(signingEnv(names));
      expect(argv).toEqual([
        'exec',
        'electron-builder',
        '--win',
        '-c.win.forceCodeSigning=true',
        '-c.win.signtoolOptions.publisherName=SARV WEBS PRIVATE LIMITED',
        '-c.win.signtoolOptions.publisherName=Sarv Webs Old Name Ltd.',
        '--publish',
        'never',
      ]);
      const config = parseElectronBuilderArgs(argv.slice(2));
      expect(config?.win?.signtoolOptions?.publisherName).toEqual(names);
      expect(
        builderOptionsProblems({ hash: 'sha256', isNest: false, options: config?.win }, names)
      ).toEqual([]);
    }
  );

  // The ordinary case, one name: yargs hands electron-builder a STRING, which
  // it (and the hook) read as a one-name list.
  // Skipped where there is no POSIX bash to run the step's script (Windows).
  it.skipIf(!bashAvailable)('hands electron-builder a single pinned name the hook accepts', () => {
    const argv = packageArgv(signingEnv(['SARV WEBS PRIVATE LIMITED']));
    const config = parseElectronBuilderArgs(argv.slice(2));
    expect(config?.win?.signtoolOptions?.publisherName).toBe('SARV WEBS PRIVATE LIMITED');
    expect(
      builderOptionsProblems({ hash: 'sha256', isNest: false, options: config?.win }, [
        'SARV WEBS PRIVATE LIMITED',
      ])
    ).toEqual([]);
  });

  // No usable list while signing is on must stop the step (set -e), never
  // build without a publisherName -- which would ship with the update
  // signature check switched off.
  // Skipped where there is no POSIX bash to run the step's script (Windows).
  it.skipIf(!bashAvailable)('fails the Package step when the publisher list cannot be read', () => {
    let failure: { status?: number | null; stderr?: Buffer } = {};
    try {
      packageArgv({
        WIN_SIGNING_ENABLED: 'true',
        WIN_PUBLISHER: 'X',
        WIN_PUBLISHER_NAMES: 'not json',
      });
    } catch (error) {
      failure = error as typeof failure;
    }
    expect(failure.status).toBe(1);
    // It stopped at the list, before electron-builder was ever invoked.
    expect(String(failure.stderr)).toMatch(/SyntaxError/);
  });

  // Unsigned: neither flag at all, so app-update.yml gets no publisherName.
  // Skipped on bash older than 4.4 (macOS's /bin/bash 3.2), which rejects the
  // step's empty "${EXTRA[@]}" under set -u; the release runners' bash 5 does not.
  it.skipIf(!bashExpandsEmptyArrays)('passes no signing flags when signing is off', () => {
    const argv = packageArgv({
      WIN_SIGNING_ENABLED: '',
      WIN_PUBLISHER: '',
      WIN_PUBLISHER_NAMES: '',
    });
    expect(argv).toEqual(['exec', 'electron-builder', '--win', '--publish', 'never']);
    expect(parseElectronBuilderArgs(argv.slice(2))).toBeUndefined();
  });

  // forceCodeSigning cannot tell whether the hook signed anything, so the
  // signatures are read back on Windows after packaging and BEFORE anything
  // is uploaded.
  it('verifies the Authenticode signatures after Package and before upload', () => {
    const verify = byRun(steps, 'node scripts/verify-win-signatures.mjs apps/desktop/release');
    expect(steps[verify].if).toBe("matrix.platform == 'win'");
    expect(verify).toBeGreaterThan(byName(steps, 'Package ${{ matrix.platform }}'));
    expect(verify).toBeLessThan(byName(steps, 'Upload artifacts'));
  });
});

describe('release.yml: the publish job', () => {
  // The last look before the installer's hash is vouched for by the signed
  // update manifest: after the workspace install (the script needs it) and
  // before "Sign the update manifest".
  it('checks the installer carries a signature before the manifest is signed', () => {
    const steps = publish.steps;
    const check = byRun(steps, 'node scripts/verify-pe-signed.mjs artifacts/*.exe');
    expect(check).toBeGreaterThan(
      indexOf(steps, (step) => step.uses === './.github/actions/setup-workspace', 'setup-workspace')
    );
    expect(check).toBeLessThan(byName(steps, 'Sign the update manifest'));
    expect(steps[check].if).toBeUndefined();
  });

  // The cross-release latch, asked again at the very last moment: tags build
  // in parallel, so a release may have been published since this tag's
  // Windows job checked. It must run unconditionally, with the token, after
  // the install (the script needs it), and IMMEDIATELY before the step that
  // runs `gh release create` -- anything between them could publish first.
  it('checks against the last published release immediately before gh release create', () => {
    const steps = publish.steps;
    const check = byRun(
      steps,
      'node scripts/windows-signing.mjs status --previous-release "$GITHUB_REPOSITORY"'
    );
    const create = byRun(steps, 'gh release create');
    expect(create).toBe(check + 1);
    expect(steps[check].if).toBeUndefined();
    expect(steps[check].env).toEqual({ GH_TOKEN: '${{ github.token }}' });
    expect(steps[check].run).not.toContain('--github-output');
    expect(check).toBeGreaterThan(
      indexOf(steps, (step) => step.uses === './.github/actions/setup-workspace', 'setup-workspace')
    );
  });
});

describe("electron-builder's CLI and a list of publisher names", () => {
  // The fact release.yml's loop is built on, as a tripwire on electron-builder
  // and yargs upgrades: a REPEATED -c flag becomes an array in order, while an
  // indexed .0/.1 form becomes an object (which the schema rejects) and a
  // bracketed [0] form is dropped altogether. A numeric value turns into a
  // number, which is why the hook compares names strictly.
  it('turns repeated -c flags into an array, and nothing else does', () => {
    const flag = '-c.win.signtoolOptions.publisherName';
    const nameOf = (argv: string[]) =>
      parseElectronBuilderArgs(['--win', ...argv])?.win?.signtoolOptions?.publisherName;
    expect(nameOf([`${flag}=A B`, `${flag}=C D`])).toEqual(['A B', 'C D']);
    expect(nameOf([`${flag}=A B`])).toBe('A B');
    expect(nameOf([`${flag}.0=A B`, `${flag}.1=C D`])).toEqual({ 0: 'A B', 1: 'C D' });
    expect(nameOf([`${flag}[0]=A B`, `${flag}[1]=C D`])).toBeUndefined();
    expect(nameOf([`${flag}=12345`])).toBe(12345);
  });
});

describe('ci.yml: the Windows signing self-test', () => {
  const job = ci.jobs['windows-signing-selftest'];

  // The only place the real jsign, real timestamps and Windows' own trust
  // check run before a release depends on them.
  it('exists on windows-latest with a stable name', () => {
    expect(job).toBeDefined();
    expect(job['runs-on']).toBe('windows-latest');
    expect(job.name).toBe('Windows signing self-test (jsign + Authenticode)');
  });

  // Same Java pin and the same checksum-verified jar as the release.
  it("uses the release's Java pin and jsign download", () => {
    const java = job.steps[byUses(job.steps, 'actions/setup-java')];
    const releaseJava = build.steps[byUses(build.steps, 'actions/setup-java')];
    expect(java.uses).toBe(releaseJava.uses);
    expect(java.with).toEqual(releaseJava.with);
    expect(job.steps[byRun(job.steps, 'fetch-jsign')].id).toBe('jsign');
  });

  // Certificates made and trusted on the runner, then the real core run.
  it('creates and trusts throwaway certificates, then runs the self-test script', () => {
    const setup = job.steps[byRun(job.steps, 'New-SelfSignedCertificate -Type CodeSigningCert')];
    expect(setup.shell).toBe('powershell');
    expect(setup.run).toContain('Cert:\\LocalMachine\\Root');
    expect(setup.run).toContain('Cert:\\LocalMachine\\TrustedPublisher');
    expect(setup.run).toContain('::add-mask::');
    const selftest = job.steps[byRun(job.steps, 'node scripts/windows-signing-selftest.mjs')];
    expect(selftest.env).toEqual({ JSIGN_JAR: '${{ steps.jsign.outputs.path }}' });
    expect(byRun(job.steps, 'node scripts/windows-signing-selftest.mjs')).toBeGreaterThan(
      job.steps.indexOf(setup)
    );
    expect(job.env).toMatchObject({
      SELFTEST_PUBLISHER: expect.any(String),
      SELFTEST_UPSTREAM: expect.any(String),
    });
  });
});

describe('ci.yml: the Windows unit tests', () => {
  const job = ci.jobs['windows-unit-tests'];
  const run = () => job.steps[byRun(job.steps, 'vitest run')];
  const files = () => (run().run ?? '').split(/\s+/).filter((word) => word.endsWith('.test.ts'));

  // Breaks: the Mark-of-the-Web stream, its survival across the save's
  // rename / hard link, and the loopback listener's close-and-rebind run on
  // Linux only again — the Windows-only paths go back to never being tested.
  it('runs on windows-latest, on the shared workspace setup, after building the libraries', () => {
    expect(job).toBeDefined();
    expect(job['runs-on']).toBe('windows-latest');
    const setup = indexOf(job.steps, (step) => step.uses === './.github/actions/setup-workspace', 'the setup-workspace step');
    const libraries = byRun(job.steps, "turbo run build --filter='@sarvinbox/desktop^...'");
    expect(setup).toBeLessThan(libraries);
    expect(libraries).toBeLessThan(job.steps.indexOf(run()));
    expect(run()).toMatchObject({ shell: 'bash', 'working-directory': 'apps/desktop' });
  });

  // Breaks: a suite renamed or moved silently drops out of the Windows run —
  // vitest runs the files it can find and passes.
  it('names only test files that exist, including the Windows-specific ones', () => {
    expect(files()).toEqual(expect.arrayContaining([
      'test/unit/electron/services/mark-downloaded.test.ts',
      'test/unit/electron/services/oauth-loopback.test.ts',
    ]));
    for (const file of files()) {
      expect(() => readFileSync(fileURLToPath(new URL(`../../../${file}`, import.meta.url))), file).not.toThrow();
    }
  });
});

describe('third-party actions in the signing path', () => {
  // A tag can be moved; a commit SHA cannot. The two actions that only the
  // signing path uses are pinned wherever they appear (release and the CI
  // self-test); the next test covers everything else in the build job.
  it('pins setup-java and google-github-actions/auth by full commit SHA everywhere', () => {
    const all = [...Object.values(release.jobs), ...Object.values(ci.jobs)].flatMap(
      (job) => job.steps
    );
    const pinned = all.filter((step) =>
      /^(actions\/setup-java|google-github-actions\/auth)@/.test(step.uses ?? '')
    );
    expect(pinned.length).toBe(3);
    for (const step of pinned) expect(step.uses).toMatch(/@[0-9a-f]{40}$/);
  });

  // The build job holds id-token: write, so ANY step in it could mint the
  // signing token: every action there must be a full commit SHA (a moved
  // tag would run new code next to the token) with its version beside it
  // for review and Dependabot. Local ./ actions live in this repository and
  // are reviewed with it.
  it('pins every action in the build job by full commit SHA, with a version comment', () => {
    const text = workflowText('release.yml');
    const uses = build.steps.map((step) => step.uses).filter((value): value is string => !!value);
    expect(uses.length).toBeGreaterThanOrEqual(7);
    for (const action of uses) {
      if (action.startsWith('./')) continue;
      expect(action, `${action} is not pinned by commit SHA`).toMatch(
        /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/
      );
      const line = text.split('\n').find((candidate) => candidate.includes(`uses: ${action}`));
      expect(line, `${action} has no version comment`).toMatch(/@[0-9a-f]{40} # v\d+(\.\d+)*$/);
    }
  });
});
