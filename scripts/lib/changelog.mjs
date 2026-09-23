// Changelog generation and CHANGELOG.md surgery — the single source for both.
//
// Two consumers need this logic and used to hold separate copies of it:
//   • scripts/release.sh   — writes a new version section when cutting a release
//   • .github/workflows/release.yml — reads that section back out for the
//     GitHub release body
//
// It previously lived as inline bash + awk inside release_github.sh, where a
// macOS-awk quirk ("newline in string") had already silently produced an empty
// changelog once. Everything here is pure string-in/string-out so it can be
// unit tested; all git and filesystem I/O stays in the callers.
//
// Format follows Keep a Changelog 1.1.0 + SemVer, matching the existing
// CHANGELOG.md: canonical section headings only, newest version first, and
// link reference definitions at the bottom.

/** Conventional-commit subjects we surface to users. Anything else is internal. */
const CONVENTIONAL_SUBJECT = /^(feat|fix|perf)(\(([^)]+)\))?(!)?:\s+(.+)$/;

/** Conventional type → Keep a Changelog heading. */
const HEADING_BY_TYPE = Object.freeze({ feat: 'Added', fix: 'Fixed', perf: 'Changed' });

/** Scopes that are documentation by definition and never user-facing. */
const DOCS_SCOPES = new Set(['docs', 'readme', 'changelog']);

/** Keep a Changelog section order. Only these six headings are ever emitted. */
const HEADING_ORDER = Object.freeze([
  'Added',
  'Changed',
  'Deprecated',
  'Removed',
  'Fixed',
  'Security',
]);

/**
 * True when every file a commit touched is documentation, so the commit has no
 * user-visible effect on the app regardless of its conventional type.
 * An empty file list is NOT docs-only — an unknown commit must not be dropped.
 */
export const isDocsOnlyChange = (files) =>
  files.length > 0 && files.every((file) => file.endsWith('.md') || file.startsWith('docs/'));

/** Upper-case the first character without touching the rest of the sentence. */
const capitalize = (text) => (text ? text[0].toUpperCase() + text.slice(1) : text);

/**
 * Parse one commit into a changelog entry, or null when it does not belong in
 * user-facing notes.
 *
 * A `!` breaking marker routes the entry to `Changed` with a **BREAKING**
 * prefix rather than inventing a "Breaking" heading, which Keep a Changelog
 * does not define.
 */
export const parseCommit = ({ subject, files = [] }) => {
  const match = CONVENTIONAL_SUBJECT.exec(subject);
  if (!match) return null;

  const [, type, , scope, breaking, description] = match;
  if (scope && DOCS_SCOPES.has(scope.toLowerCase())) return null;
  if (isDocsOnlyChange(files)) return null;

  return {
    heading: breaking ? 'Changed' : HEADING_BY_TYPE[type],
    description: breaking
      ? `**BREAKING** ${capitalize(description)}`
      : capitalize(description),
  };
};

/**
 * Build the markdown body for one release from a list of commits
 * ({ subject, files }), newest first.
 *
 * Never returns an empty string: a release cut from commits that are all
 * internal still needs a section, and a blank one reads as a broken release.
 */
export const buildSection = (commits) => {
  const entries = commits.map(parseCommit).filter(Boolean);
  if (entries.length === 0) return '### Changed\n- Maintenance and internal improvements.';

  return HEADING_ORDER.flatMap((heading) => {
    const lines = entries
      .filter((entry) => entry.heading === heading)
      .map((entry) => `- ${entry.description}`);
    return lines.length > 0 ? [`### ${heading}`, ...lines, ''] : [];
  })
    .join('\n')
    .trimEnd();
};

/**
 * Insert a new `## [version] - date` section into CHANGELOG.md, directly below
 * `## [Unreleased]`, and refresh the link reference definitions at the bottom.
 *
 * Returns the new markdown. Idempotent: a changelog that already documents
 * `version` is returned untouched, so a re-run of a release never duplicates a
 * section.
 */
export const insertVersionSection = (markdown, { version, date, section, repo }) => {
  if (new RegExp(`^## \\[${escapeForRegExp(version)}\\]`, 'm').test(markdown)) return markdown;

  const entry = `## [${version}] - ${date}\n\n${section}\n\n`;
  const unreleasedAt = markdown.indexOf('## [Unreleased]');

  let next;
  if (unreleasedAt === -1) {
    next = `${markdown.trimEnd()}\n\n${entry}`;
  } else {
    // Land the entry immediately before the previous newest version so
    // [Unreleased] keeps whatever is still pending above it.
    const followingSection = markdown.indexOf('\n## [', unreleasedAt + 1);
    next =
      followingSection === -1
        ? `${markdown.trimEnd()}\n\n${entry}`
        : `${markdown.slice(0, followingSection + 1)}${entry}${markdown.slice(followingSection + 1)}`;
  }

  return updateLinkReferences(next, { version, repo });
};

/** Point [Unreleased] at the new tag and add a link ref for the new version. */
const updateLinkReferences = (markdown, { version, repo }) => {
  const base = `https://github.com/${repo}`;
  const unreleasedLink = `[Unreleased]: ${base}/compare/v${version}...HEAD`;

  let next = /^\[Unreleased\]:.*$/m.test(markdown)
    ? markdown.replace(/^\[Unreleased\]:.*$/m, unreleasedLink)
    : `${markdown.trimEnd()}\n\n${unreleasedLink}\n`;

  if (!new RegExp(`^\\[${escapeForRegExp(version)}\\]:`, 'm').test(next)) {
    next = next.replace(
      /^\[Unreleased\]:.*$/m,
      `$&\n[${version}]: ${base}/releases/tag/v${version}`
    );
  }
  return next;
};

/**
 * Pull one version's notes back out of CHANGELOG.md — what the GitHub release
 * body is built from, so the release page and the changelog can never disagree.
 * Returns null when the version has no section.
 */
export const extractVersionSection = (markdown, version) => {
  const heading = new RegExp(`^## \\[${escapeForRegExp(version)}\\][^\\n]*\\n`, 'm');
  const start = heading.exec(markdown);
  if (!start) return null;

  const bodyStart = start.index + start[0].length;
  const rest = markdown.slice(bodyStart);

  // Stop at the next version heading OR at the link reference definitions that
  // close the file. Without the second stop, the OLDEST section (which has no
  // heading after it) carries "[1.1.0]: https://…" lines into the GitHub
  // release body as trailing junk.
  const end = rest.search(/^(?:## \[|\[[^\]]+\]:\s*http)/m);
  const body = end === -1 ? rest : rest.slice(0, end);

  const trimmed = body.trim();
  return trimmed.length > 0 ? trimmed : null;
};

/** Escape a version string for literal use inside a RegExp. */
const escapeForRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Bump a semver string. Throws on anything that is not X.Y.Z. */
export const bumpVersion = (current, release) => {
  const parts = current.split('.').map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part) || part < 0)) {
    throw new Error(`Not a semver version: "${current}"`);
  }
  const [major, minor, patch] = parts;
  switch (release) {
    case 'major':
      return `${major + 1}.0.0`;
    case 'minor':
      return `${major}.${minor + 1}.0`;
    case 'patch':
      return `${major}.${minor}.${patch + 1}`;
    default:
      throw new Error(`Unknown release type: "${release}" (expected major|minor|patch)`);
  }
};
