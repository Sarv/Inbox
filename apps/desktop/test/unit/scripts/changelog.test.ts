import { describe, expect, it } from 'vitest';

import {
  buildSection,
  bumpVersion,
  extractVersionSection,
  insertVersionSection,
  isDocsOnlyChange,
  parseCommit,
} from '../../../../../scripts/lib/changelog.mjs';

const commit = (subject: string, files: string[] = ['src/a.ts']) => ({ subject, files });

describe('parseCommit', () => {
  // If this fails, release notes lose the feat/fix/perf mapping and every
  // change lands under the wrong Keep a Changelog heading.
  it('maps conventional types to Keep a Changelog headings', () => {
    expect(parseCommit(commit('feat: add tag search'))).toEqual({
      heading: 'Added',
      description: 'Add tag search',
    });
    expect(parseCommit(commit('fix: stop duplicate sync'))?.heading).toBe('Fixed');
    expect(parseCommit(commit('perf: speed up threading'))?.heading).toBe('Changed');
  });

  // If this fails, chore/refactor/test/docs commits leak into user-facing notes
  // and the release page fills with internal noise.
  it('drops non-user-facing commit types', () => {
    expect(parseCommit(commit('chore(deps): upgrade nodemailer'))).toBeNull();
    expect(parseCommit(commit('refactor: extract helper'))).toBeNull();
    expect(parseCommit(commit('not a conventional commit'))).toBeNull();
  });

  // If this fails, a docs-scoped commit is announced as a product change.
  it('drops documentation scopes', () => {
    expect(parseCommit(commit('feat(docs): document the API'))).toBeNull();
    expect(parseCommit(commit('fix(readme): fix a typo'))).toBeNull();
    expect(parseCommit(commit('feat(CHANGELOG): tidy'))).toBeNull();
  });

  // If this fails, a `feat:` commit that only edited markdown is shipped as a
  // feature — the exact case the old bash `docs_only` guard existed for.
  it('drops commits whose files are all documentation', () => {
    expect(parseCommit(commit('feat: explain sync', ['docs/SYNC.md', 'README.md']))).toBeNull();
    // A single non-docs file is enough to keep it.
    expect(parseCommit(commit('feat: explain sync', ['docs/SYNC.md', 'src/sync.ts']))).not.toBeNull();
  });

  // If this fails, a breaking change ships without any warning to someone
  // upgrading, which is the one thing a changelog must never do.
  it('flags breaking changes inline under Changed', () => {
    expect(parseCommit(commit('feat(api)!: drop the v1 endpoint'))).toEqual({
      heading: 'Changed',
      description: '**BREAKING** Drop the v1 endpoint',
    });
  });

  // If this fails, bullets render as "add tag search" mid-list — cosmetic, but
  // it is what makes generated notes look unedited.
  it('capitalizes the description', () => {
    expect(parseCommit(commit('fix: resolve a crash'))?.description).toBe('Resolve a crash');
  });
});

describe('isDocsOnlyChange', () => {
  // If this fails, a commit with no detectable file list is silently dropped
  // from the notes instead of being kept.
  it('treats an empty file list as NOT docs-only', () => {
    expect(isDocsOnlyChange([])).toBe(false);
  });

  it('recognises markdown and docs/ paths', () => {
    expect(isDocsOnlyChange(['docs/a.md', 'README.md'])).toBe(true);
    expect(isDocsOnlyChange(['docs/a.md', 'src/a.ts'])).toBe(false);
  });
});

describe('buildSection', () => {
  // If this fails, sections render out of Keep a Changelog order.
  it('emits headings in canonical order', () => {
    const section = buildSection([
      commit('fix: b'),
      commit('feat: a'),
      commit('perf: c'),
    ]);
    expect(section.indexOf('### Added')).toBeLessThan(section.indexOf('### Changed'));
    expect(section.indexOf('### Changed')).toBeLessThan(section.indexOf('### Fixed'));
  });

  // If this fails, a release ships with blank notes — the failure the old
  // script guarded against by hand.
  it('never returns an empty section', () => {
    expect(buildSection([])).toContain('Maintenance and internal improvements');
    expect(buildSection([commit('chore: tidy')])).toContain('### Changed');
  });

  // If this fails, the oldest commit in the range is dropped — the bug that
  // silently cost earlier releases their first entry.
  it('keeps every commit in the range', () => {
    const section = buildSection([commit('feat: first'), commit('feat: second'), commit('feat: third')]);
    expect(section).toContain('- First');
    expect(section).toContain('- Second');
    expect(section).toContain('- Third');
  });

  it('omits headings that have no entries', () => {
    expect(buildSection([commit('feat: only a feature')])).not.toContain('### Fixed');
  });
});

const CHANGELOG = `# Changelog

All notable changes to Sarv Inbox are documented here.

## [Unreleased]

### Added
- Something still pending.

## [1.1.0] - 2026-09-01

### Fixed
- An older fix.

[Unreleased]: https://github.com/Sarv/Inbox/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/Sarv/Inbox/releases/tag/v1.1.0
`;

describe('insertVersionSection', () => {
  const insert = (markdown: string, version = '1.2.0') =>
    insertVersionSection(markdown, {
      version,
      date: '2026-09-23',
      section: '### Added\n- A new thing.',
      repo: 'Sarv/Inbox',
    });

  // If this fails, the newest release is not at the top and readers see a
  // stale version first.
  it('inserts the new version below [Unreleased] and above the previous one', () => {
    const next = insert(CHANGELOG);
    expect(next.indexOf('## [Unreleased]')).toBeLessThan(next.indexOf('## [1.2.0] - 2026-09-23'));
    expect(next.indexOf('## [1.2.0]')).toBeLessThan(next.indexOf('## [1.1.0]'));
  });

  // If this fails, pending [Unreleased] notes are swallowed by the release.
  it('leaves the [Unreleased] content in place', () => {
    expect(insert(CHANGELOG)).toContain('- Something still pending.');
  });

  // If this fails, re-running a release duplicates the section — and the old
  // bash version did exactly that.
  it('is idempotent for a version already present', () => {
    expect(insert(CHANGELOG, '1.1.0')).toBe(CHANGELOG);
  });

  // If this fails, the changelog's compare link points at an old tag and the
  // version link 404s.
  it('refreshes the link reference definitions', () => {
    const next = insert(CHANGELOG);
    expect(next).toContain('[Unreleased]: https://github.com/Sarv/Inbox/compare/v1.2.0...HEAD');
    expect(next).toContain('[1.2.0]: https://github.com/Sarv/Inbox/releases/tag/v1.2.0');
    expect(next).not.toContain('compare/v1.1.0...HEAD');
  });

  // If this fails, the very first release on a fresh changelog throws instead
  // of appending.
  it('appends when there is no [Unreleased] section', () => {
    const next = insertVersionSection('# Changelog\n\nSome preamble.\n', {
      version: '1.0.0',
      date: '2026-09-23',
      section: '### Added\n- First release.',
      repo: 'Sarv/Inbox',
    });
    expect(next).toContain('## [1.0.0] - 2026-09-23');
    expect(next).toContain('[1.0.0]: https://github.com/Sarv/Inbox/releases/tag/v1.0.0');
  });
});

describe('extractVersionSection', () => {
  // If this fails, the GitHub release body is empty or carries the wrong
  // version's notes — the release page then disagrees with CHANGELOG.md.
  it('returns only the requested version body', () => {
    const notes = extractVersionSection(CHANGELOG, '1.1.0');
    expect(notes).toBe('### Fixed\n- An older fix.');
    expect(notes).not.toContain('Unreleased');
  });

  // If this fails, CI publishes a release with notes it could not actually
  // find, instead of failing loudly.
  it('returns null for a version that is not documented', () => {
    expect(extractVersionSection(CHANGELOG, '9.9.9')).toBeNull();
  });

  // If this fails, the last version in the file comes back empty because there
  // is no following heading to stop at.
  it('reads the final section to the end of the file', () => {
    const markdown = '# Changelog\n\n## [1.0.0] - 2026-01-01\n\n### Added\n- The first one.\n';
    expect(extractVersionSection(markdown, '1.0.0')).toBe('### Added\n- The first one.');
  });
});

describe('bumpVersion', () => {
  // If this fails, a release is tagged with the wrong number and the tag can
  // never be reused.
  it('bumps each release type and resets lower parts', () => {
    expect(bumpVersion('1.2.3', 'major')).toBe('2.0.0');
    expect(bumpVersion('1.2.3', 'minor')).toBe('1.3.0');
    expect(bumpVersion('1.2.3', 'patch')).toBe('1.2.4');
  });

  // If this fails, a malformed version silently becomes "NaN.0.0" and the
  // release is published under a nonsense tag.
  it('throws on a non-semver version or unknown release type', () => {
    expect(() => bumpVersion('1.2', 'patch')).toThrow(/semver/);
    expect(() => bumpVersion('v1.2.3', 'patch')).toThrow(/semver/);
    // @ts-expect-error -- deliberately bad input: the runtime guard must hold
    // even when a caller (a shell script, say) is not type-checked at all.
    expect(() => bumpVersion('1.2.3', 'sideways')).toThrow(/Unknown release type/);
  });
});
