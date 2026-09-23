// Type declarations for changelog.mjs — see the sibling .mjs for the rationale.
// Mirrors the convention used by dev-processes / native-abi / stale-js.

export interface CommitInput {
  /** The commit subject line, e.g. "feat(search): add a tag: operator". */
  subject: string;
  /** Paths the commit touched; used to drop docs-only changes. */
  files?: string[];
}

export interface ChangelogEntry {
  /** Keep a Changelog heading this entry belongs under. */
  heading: 'Added' | 'Changed' | 'Deprecated' | 'Removed' | 'Fixed' | 'Security';
  /** Capitalized bullet text, with a **BREAKING** prefix when applicable. */
  description: string;
}

export interface InsertOptions {
  version: string;
  /** ISO-8601 date (UTC), e.g. "2026-09-23". */
  date: string;
  /** Markdown body produced by buildSection. */
  section: string;
  /** GitHub "owner/repo", used to build the link reference definitions. */
  repo: string;
}

export function isDocsOnlyChange(files: string[]): boolean;
export function parseCommit(commit: CommitInput): ChangelogEntry | null;
export function buildSection(commits: CommitInput[]): string;
export function insertVersionSection(markdown: string, options: InsertOptions): string;
export function extractVersionSection(markdown: string, version: string): string | null;
export function bumpVersion(current: string, release: 'major' | 'minor' | 'patch'): string;
