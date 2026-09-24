#!/usr/bin/env node

// CLI over scripts/lib/changelog.mjs — the I/O edge around those pure functions.
//
//   node scripts/changelog.mjs write <version>   generate the section for
//       <version> from the commits since the last v* tag and insert it into
//       CHANGELOG.md. Used by scripts/release.sh when cutting a release.
//
//   node scripts/changelog.mjs notes <version>   print an existing version's
//       notes to stdout. Used by .github/workflows/release.yml to build the
//       GitHub release body, so the release page and CHANGELOG.md always agree.
//
// Both exit non-zero with a message rather than producing empty output: a
// release that ships blank notes is worse than a release that fails to publish.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildSection,
  extractVersionSection,
  insertVersionSection,
  readUnreleasedBody,
} from './lib/changelog.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHANGELOG_PATH = join(ROOT, 'CHANGELOG.md');

const fail = (message) => {
  console.error(`ERROR: ${message}`);
  process.exit(1);
};

const git = (args, { quiet = false } = {}) =>
  execFileSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    // `quiet` silences stderr for calls whose failure is an expected outcome
    // rather than an error worth showing.
    stdio: quiet ? ['ignore', 'pipe', 'ignore'] : ['ignore', 'pipe', 'inherit'],
  });

/**
 * The last v* tag, or null on a repo that has never been released — where
 * `git describe` exits non-zero with "No names found", which is not an error
 * here: it just means the range is the whole history.
 */
const lastReleaseTag = () => {
  try {
    return git(['describe', '--tags', '--match', 'v*', '--abbrev=0'], { quiet: true }).trim() || null;
  } catch {
    return null;
  }
};

/**
 * Commits in `range` as { subject, files }, newest first. Uses NUL separators
 * so a subject containing a tab or newline cannot corrupt the parse — the
 * class of bug that dropped entries from the old bash implementation.
 */
const commitsInRange = (range) => {
  // %x00 makes GIT emit the NUL; the separator must never appear literally in
  // the argv string, where a raw NUL would truncate the argument and yield an
  // empty log. `tformat` (not `format`) also terminates the LAST record, which
  // is what stops the oldest commit in the range being dropped.
  const RECORD_SEPARATOR = '\u0000';
  const log = git(['log', range, '--no-merges', '--pretty=tformat:%x00%H%x09%s']);

  return log
    .split(RECORD_SEPARATOR)
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const tab = record.indexOf('\t');
      const hash = record.slice(0, tab);
      const subject = record.slice(tab + 1);
      const files = git(['diff-tree', '--no-commit-id', '--name-only', '-r', hash])
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
      return { subject, files };
    });
};

const commandWrite = (version) => {
  const baseTag = lastReleaseTag();
  const range = baseTag ? `${baseTag}..HEAD` : 'HEAD';
  console.log(`Generating ${version} notes from commits (${baseTag ?? 'repo start'}..HEAD)`);

  const commits = commitsInRange(range);
  if (commits.length === 0) {
    fail(
      `no commits in range "${range}" — refusing to write an empty ${version} entry. ` +
        `A v${version} tag may already exist, which makes the range empty.`
    );
  }

  const section = buildSection(commits);
  // Dates are UTC per the repo's store-UTC rule, so a release cut late in the
  // day never lands on tomorrow's date for a reader in another zone.
  const date = new Date().toISOString().slice(0, 10);
  const repo = process.env.GITHUB_REPO ?? 'Sarv/Inbox';

  const markdown = readFileSync(CHANGELOG_PATH, 'utf8');
  const pending = readUnreleasedBody(markdown);
  const next = insertVersionSection(markdown, { version, date, section, repo });

  if (next === markdown) {
    console.log(`CHANGELOG.md already documents ${version} — left unchanged.`);
    return;
  }

  writeFileSync(CHANGELOG_PATH, next);
  console.log(`OK: CHANGELOG.md updated with [${version}] - ${date}`);

  // Say which of the two sources was used. Silence here is how v1.2.1 nearly
  // shipped notes that described none of what was in it: the hand-written
  // [Unreleased] entries were left behind and only the generated ones showed.
  if (pending === '') {
    console.log(`\n${section}\n`);
  } else {
    console.log('\nPromoted the hand-written [Unreleased] notes into the release:\n');
    console.log(`${pending}\n`);
    console.log('For cross-checking, the commits since the last tag say:\n');
    console.log(`${section}\n`);
  }
};

const commandNotes = (version) => {
  const notes = extractVersionSection(readFileSync(CHANGELOG_PATH, 'utf8'), version);
  if (!notes) fail(`CHANGELOG.md has no section for ${version}.`);
  process.stdout.write(`${notes}\n`);
};

const [command, version] = process.argv.slice(2);
if (!command || !version) {
  fail('usage: node scripts/changelog.mjs <write|notes> <version>');
}

switch (command) {
  case 'write':
    commandWrite(version);
    break;
  case 'notes':
    commandNotes(version);
    break;
  default:
    fail(`unknown command "${command}" (expected write or notes)`);
}
