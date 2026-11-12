import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Lets a test change what the ticket path names at the moment it is opened.
const h = vi.hoisted(() => ({ beforeOpen: undefined as ((path: string) => void) | undefined, blockingOpens: 0 }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    openSync: (path: import('node:fs').PathLike, flags: import('node:fs').OpenMode, mode?: import('node:fs').Mode) => {
      h.beforeOpen?.(String(path));
      // A FIFO opened for reading without O_NONBLOCK blocks until a writer
      // appears: count it and fail fast instead of hanging the run.
      const nonBlocking = typeof flags === 'number' && (flags & (actual.constants.O_NONBLOCK || 0)) !== 0;
      if (!nonBlocking && actual.statSync(path, { throwIfNoEntry: false })?.isFIFO()) {
        h.blockingOpens++;
        throw new Error('opened a FIFO without O_NONBLOCK: this would block forever');
      }
      return actual.openSync(path, flags, mode);
    },
  };
});

import { consumeLocalDataResetTicket, createLocalDataResetTicket } from '../../../../electron/services/local-data-reset-ticket';

let directory: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'inbox-reset-ticket-')); h.beforeOpen = undefined; h.blockingOpens = 0; });
afterEach(() => { rmSync(directory, { recursive: true, force: true }); });
const fileFor = (token: string) => join(directory, `local-data-reset-${token.split(':')[0]}.json`);

describe('authenticated one-use local reset tickets', () => {
  it('authorizes only its profile, consumes once and contains no persistent capability key', () => {
    const ticket = createLocalDataResetTicket(directory, 'production', 1000);
    expect(readFileSync(fileFor(ticket.token), 'utf8')).not.toContain(ticket.token.split(':')[1]);
    consumeLocalDataResetTicket(directory, ticket.token, 'production', 1001);
    expect(readdirSync(directory)).toEqual([]);
    expect(() => consumeLocalDataResetTicket(directory, ticket.token, 'production', 1002)).toThrow(/could not be verified/);
  });
  it.each(['production', '../production', '', 'bad:token'])('a bare or malformed environment request cannot reset anything: %s', token => {
    expect(() => consumeLocalDataResetTicket(directory, token, 'production')).toThrow();
    expect(readdirSync(directory)).toEqual([]);
  });
  it('rejects a different build and consumes its request so it cannot later replay', () => {
    const ticket = createLocalDataResetTicket(directory, 'production', 1000);
    expect(() => consumeLocalDataResetTicket(directory, ticket.token, 'development', 1001)).toThrow();
    expect(existsSync(fileFor(ticket.token))).toBe(false);
  });
  it.each([400_000, -10_000])('rejects expired and future tickets (now=%s)', now => {
    const ticket = createLocalDataResetTicket(directory, 'production', 1000);
    expect(() => consumeLocalDataResetTicket(directory, ticket.token, 'production', now)).toThrow();
    expect(existsSync(fileFor(ticket.token))).toBe(false);
  });
  it('rejects tampering even if its JSON remains valid', () => {
    const ticket = createLocalDataResetTicket(directory, 'production', 1000);
    const envelope = JSON.parse(readFileSync(fileFor(ticket.token), 'utf8'));
    envelope.payload = JSON.stringify({ version: 1, profile: 'development', time: 1000 });
    writeFileSync(fileFor(ticket.token), JSON.stringify(envelope));
    expect(() => consumeLocalDataResetTicket(directory, ticket.token, 'development', 1001)).toThrow();
  });
  it('rejects oversized files without reading unbounded content', () => {
    const ticket = createLocalDataResetTicket(directory, 'production');
    writeFileSync(fileFor(ticket.token), 'x'.repeat(2048));
    expect(() => consumeLocalDataResetTicket(directory, ticket.token, 'production')).toThrow();
  });
  it.skipIf(process.platform === 'win32')('refuses a symlink ticket and preserves its destination', () => {
    const ticket = createLocalDataResetTicket(directory, 'production');
    const target = join(directory, 'keep.txt');
    writeFileSync(target, 'keep me'); rmSync(fileFor(ticket.token)); symlinkSync(target, fileFor(ticket.token));
    expect(() => consumeLocalDataResetTicket(directory, ticket.token, 'production')).toThrow();
    expect(readFileSync(target, 'utf8')).toBe('keep me');
  });
  // Breaks: the ticket path is checked and THEN opened by name, so a FIFO
  // swapped in between blocks the open — and the app's startup — forever.
  it.skipIf(process.platform === 'win32')('refuses a FIFO swapped in at the ticket path without hanging startup', () => {
    const ticket = createLocalDataResetTicket(directory, 'production', 1000);
    const file = fileFor(ticket.token);
    h.beforeOpen = (path) => {
      if (path !== file) return;
      h.beforeOpen = undefined;
      rmSync(file);
      execFileSync('mkfifo', [file]);
    };
    expect(() => consumeLocalDataResetTicket(directory, ticket.token, 'production', 1001)).toThrow(/No data was erased/);
    expect(h.blockingOpens).toBe(0);
    expect(existsSync(file)).toBe(false);
  });
});
