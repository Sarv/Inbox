import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  AttachmentDownloadProtection,
  getAttachmentOperationProtection,
  readUnscannedAttachment,
  setAttachmentOperationProtection,
  attachmentScanRequired,
  downloadScanners,
  writeProtectedAttachment,
  type AttachmentDownloadDependencies,
  type DownloadScanner,
} from '../../../../electron/services/attachment-download-protection';

const temporary: string[] = [];
afterEach(async () => {
  for (const directory of temporary.splice(0))
    await rm(directory, { recursive: true, force: true });
});

function fixture(
  initial: DownloadScanner[] = [
    { id: 'clamav-scan', enabled: true, active: true, scanner: true, granted: true },
  ]
) {
  let scanners = initial;
  const content = Buffer.from('exact synthetic attachment');
  const assertCurrent = vi.fn(async () => {});
  const dispose = vi.fn(() => content.fill(0));
  const events: string[] = [];
  const deps: AttachmentDownloadDependencies = {
    scanners: () => scanners,
    scan: vi.fn(async (_id, _message, _account, _filename, options) => {
      events.push('scan');
      options.onProgress('scanning');
      return { content, assertCurrent, dispose };
    }),
    openSetup: vi.fn(),
    resolveLegacy: vi.fn(async () => '/synthetic/cache.txt'),
    readLegacy: vi.fn(async () => Buffer.from('warning-approved local bytes')),
    chooseSavePath: vi.fn(async () => {
      events.push('dialog');
      return '/synthetic/saved.txt';
    }),
    writeContent: vi.fn(async (_destination, bytes, _signal, beforeCommit) => {
      events.push(`write:${bytes.toString()}`);
      await beforeCommit();
      events.push('commit');
    }),
    copyLegacy: vi.fn(async () => {}),
    progress: vi.fn((_id, phase) => {
      events.push(phase);
    }),
  };
  const service = new AttachmentDownloadProtection(deps);
  return {
    service,
    deps,
    content,
    assertCurrent,
    dispose,
    events,
    scanners: (value: DownloadScanner[]) => {
      scanners = value;
    },
  };
}

// Breaks: Download can bypass its configured scanner, save different bytes, or overwrite after cancellation.
describe('attachment download protection', () => {
  it('scans once before showing the dialog and commits only the retained clean bytes', async () => {
    const f = fixture();
    expect(await f.service.download('message-b', 'account-b', 'report.txt', 'request-1')).toBe(
      '/synthetic/saved.txt'
    );
    expect(f.deps.scan).toHaveBeenCalledWith(
      'clamav-scan',
      'message-b',
      'account-b',
      'report.txt',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(f.events).toEqual([
      'downloading',
      'scan',
      'scanning',
      'dialog',
      'saving',
      'write:exact synthetic attachment',
      'commit',
    ]);
    expect(f.assertCurrent).toHaveBeenCalledTimes(3);
    expect(f.deps.resolveLegacy).not.toHaveBeenCalled();
    expect(f.deps.copyLegacy).not.toHaveBeenCalled();
    expect(f.dispose).toHaveBeenCalledOnce();
    expect(f.content.every((byte) => byte === 0)).toBe(true);
  });

  it.each([
    'ClamAV detected a threat',
    'incomplete coverage',
    'scanner unavailable',
    'digest mismatch',
  ])('does not open a destination or write after %s', async (reason) => {
    const f = fixture();
    vi.mocked(f.deps.scan).mockRejectedValue(new Error(reason));
    await expect(f.service.download('message', 'account', 'sample.txt')).rejects.toThrow(reason);
    expect(f.deps.chooseSavePath).not.toHaveBeenCalled();
    expect(f.deps.writeContent).not.toHaveBeenCalled();
    expect(f.deps.resolveLegacy).not.toHaveBeenCalled();
  });

  it.each([
    { active: false, granted: true },
    { active: true, granted: false },
  ])('blocks an enabled scanner when %j', async (flags) => {
    const f = fixture([{ id: 'clamav-scan', scanner: true, enabled: true, ...flags }]);
    await expect(f.service.download('message', 'account', 'sample.txt')).rejects.toThrow(
      /unavailable or lacks/
    );
    expect(f.deps.openSetup).toHaveBeenCalledWith('clamav-scan');
    expect(f.deps.scan).not.toHaveBeenCalled();
    expect(f.deps.resolveLegacy).not.toHaveBeenCalled();
  });

  it('refuses to choose a scanner silently when multiple extensions are enabled', async () => {
    const scanner = { enabled: true, active: true, scanner: true, granted: true };
    const f = fixture([
      { id: 'clamav-scan', ...scanner },
      { id: 'another-scan', ...scanner },
    ]);
    await expect(f.service.download('message', 'account', 'sample.txt')).rejects.toThrow(
      /More than one/
    );
    expect(f.deps.scan).not.toHaveBeenCalled();
    expect(f.deps.resolveLegacy).not.toHaveBeenCalled();
  });

  it('preserves ordinary downloads when no scanner is enabled', async () => {
    const f = fixture([
      { id: 'clamav-scan', enabled: false, active: false, scanner: true, granted: true },
    ]);
    await f.service.download('message-b', 'account-b', 'sample.txt');
    expect(f.deps.resolveLegacy).toHaveBeenCalledWith('message-b', 'sample.txt', 'account-b');
    expect(f.deps.copyLegacy).toHaveBeenCalledWith('/synthetic/cache.txt', '/synthetic/saved.txt');
    expect(f.deps.scan).not.toHaveBeenCalled();
  });

  it('blocks a legacy download if scanning becomes enabled while the dialog is open', async () => {
    const f = fixture([]);
    vi.mocked(f.deps.chooseSavePath).mockImplementation(async () => {
      f.scanners([
        { id: 'clamav-scan', enabled: true, active: true, scanner: true, granted: true },
      ]);
      return '/synthetic/saved.txt';
    });
    await expect(f.service.download('message', 'account', 'sample.txt')).rejects.toThrow(
      /Retry the download/
    );
    expect(f.deps.copyLegacy).not.toHaveBeenCalled();
  });

  it('rechecks consent after the native dialog and disposes retained content on refusal', async () => {
    const f = fixture();
    vi.mocked(f.deps.chooseSavePath).mockImplementation(async () => {
      f.assertCurrent.mockRejectedValue(new Error('consent revoked'));
      return '/synthetic/saved.txt';
    });
    await expect(f.service.download('message', 'account', 'sample.txt')).rejects.toThrow(
      /consent revoked/
    );
    expect(f.deps.writeContent).not.toHaveBeenCalled();
    expect(f.dispose).toHaveBeenCalledOnce();
  });

  // Breaks: an extension permission revoked during an awaited receipt check still opens a save/viewer.
  it('rechecks extension permission after an asynchronous receipt check', async () => {
    const f = fixture();
    let finish!: () => void;
    f.assertCurrent.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    const pending = f.service.download('message', 'account', 'sample.txt');
    await vi.waitFor(() => expect(typeof finish).toBe('function'));
    f.scanners([]);
    finish();
    await expect(pending).rejects.toThrow(/disabled or changed/);
    expect(f.deps.chooseSavePath).not.toHaveBeenCalled();
    expect(f.dispose).toHaveBeenCalledOnce();
  });

  it('blocks the commit if the extension is disabled during a staged write', async () => {
    const f = fixture();
    vi.mocked(f.deps.writeContent).mockImplementation(
      async (_path, _bytes, _signal, beforeCommit) => {
        f.scanners([]);
        await beforeCommit();
      }
    );
    await expect(f.service.download('message', 'account', 'sample.txt')).rejects.toThrow(
      /disabled or changed/
    );
    expect(f.dispose).toHaveBeenCalledOnce();
  });

  it('cancel while scanning reaches the service signal and blocks a late clean result', async () => {
    const f = fixture();
    let release!: () => void;
    let observed: AbortSignal | undefined;
    vi.mocked(f.deps.scan).mockImplementation(async (_id, _message, _account, _name, options) => {
      observed = options.signal;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { content: f.content, assertCurrent: f.assertCurrent, dispose: f.dispose };
    });
    const pending = f.service.download('message', 'account', 'sample.txt', 'request-cancel');
    expect(f.service.cancel('request-cancel')).toBe(true);
    expect(observed?.aborted).toBe(true);
    release();
    await expect(pending).rejects.toThrow('Download cancelled.');
    expect(f.deps.chooseSavePath).not.toHaveBeenCalled();
    expect(f.dispose).toHaveBeenCalledOnce();
    expect(f.service.cancel('request-cancel')).toBe(false);
  });

  it('cancel while choosing a path resolves promptly and prevents a later write', async () => {
    const f = fixture();
    let choose!: (path: string) => void;
    vi.mocked(f.deps.chooseSavePath).mockImplementation(
      () =>
        new Promise((resolve) => {
          choose = resolve;
        })
    );
    const pending = f.service.download('message', 'account', 'sample.txt', 'dialog-cancel');
    await vi.waitFor(() => expect(f.deps.chooseSavePath).toHaveBeenCalled());
    f.service.cancel('dialog-cancel');
    await expect(pending).rejects.toThrow('Download cancelled.');
    choose('/synthetic/saved.txt');
    await Promise.resolve();
    expect(f.deps.writeContent).not.toHaveBeenCalled();
    expect(f.dispose).toHaveBeenCalledOnce();
  });

  it('rejects duplicate/invalid request ids and retains the original cancellation handle', async () => {
    const f = fixture();
    let release!: () => void;
    vi.mocked(f.deps.scan).mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { content: f.content, assertCurrent: f.assertCurrent, dispose: f.dispose };
    });
    const first = f.service.download('message', 'account', 'sample.txt', 'unique-id');
    await expect(
      f.service.download('message', 'account', 'sample.txt', 'unique-id')
    ).rejects.toThrow(/already in progress/);
    await expect(f.service.download('message', 'account', 'sample.txt', '../bad')).rejects.toThrow(
      /Invalid/
    );
    expect(f.service.cancel('unique-id')).toBe(true);
    release();
    await expect(first).rejects.toThrow(/cancelled/);
  });

  it('bounds active requests and releases each slot after cancellation', async () => {
    const f = fixture();
    vi.mocked(f.deps.scan).mockImplementation(
      (_id, _message, _account, _name, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), {
            once: true,
          });
        })
    );
    const pending = Array.from({ length: 4 }, (_, index) =>
      f.service.download('message', 'account', 'sample.txt', `bounded-${index}`)
    );
    await expect(
      f.service.download('message', 'account', 'sample.txt', 'too-many')
    ).rejects.toThrow(/Too many/);
    for (let index = 0; index < 4; index++) f.service.cancel(`bounded-${index}`);
    expect(
      (await Promise.allSettled(pending)).every((result) => result.status === 'rejected')
    ).toBe(true);
    vi.mocked(f.deps.scan).mockImplementation(async () => ({
      content: f.content,
      assertCurrent: f.assertCurrent,
      dispose: f.dispose,
    }));
    expect(await f.service.download('message', 'account', 'sample.txt', 'slot-reused')).toBe(
      '/synthetic/saved.txt'
    );
  });

  it('aborts a stalled protected scan at its bounded deadline without saving', async () => {
    const f = fixture();
    f.deps.timeoutMs = 5;
    vi.mocked(f.deps.scan).mockImplementation(
      (_id, _message, _account, _name, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), {
            once: true,
          });
        })
    );
    await expect(f.service.download('message', 'account', 'sample.txt', 'timeout')).rejects.toThrow(
      /timed out/
    );
    expect(f.deps.chooseSavePath).not.toHaveBeenCalled();
    expect(f.service.cancel('timeout')).toBe(false);
  });

  // Breaks: a real scanner's generic aborted response reports a host deadline as a user cancellation.
  it('preserves timeout when the scanner converts the aborted signal into a generic cancellation', async () => {
    const f = fixture();
    f.deps.timeoutMs = 5;
    vi.mocked(f.deps.scan).mockImplementation(
      (_id, _message, _account, _name, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new Error('Download cancelled.')), {
            once: true,
          });
        })
    );
    await expect(
      f.service.download('message', 'account', 'sample.txt', 'real-timeout')
    ).rejects.toThrow('Attachment download timed out.');
    expect(f.deps.chooseSavePath).not.toHaveBeenCalled();
    expect(f.deps.writeContent).not.toHaveBeenCalled();
  });
});

// Breaks: a setup warning crosses account/configuration boundaries or rescues an actual failed scan.
describe('optional scanning only when setup is missing', () => {
  function missingSetup() {
    const f = fixture();
    const assertMissing = vi.fn(async () => {});
    f.deps.checkSetup = vi.fn(async () => ({ assertCurrent: assertMissing }));
    f.deps.confirmUnscanned = vi.fn(async () => 'continue' as const);
    return { ...f, assertMissing };
  }

  it('accepts one warning-bound local save without scanning or storing consent, and warns again next time', async () => {
    const f = missingSetup();
    const flag = vi.fn();
    await f.service.download('message-b', 'account-b', 'sample.txt', 'skip-1', flag);
    expect(f.deps.checkSetup).toHaveBeenCalledWith('clamav-scan', 'account-b');
    expect(f.deps.confirmUnscanned).toHaveBeenCalledWith(
      {
        messageId: 'message-b',
        accountId: 'account-b',
        filename: 'sample.txt',
        action: 'download',
      },
      expect.any(AbortSignal),
      expect.any(Function)
    );
    expect(f.events).toContain('write:warning-approved local bytes');
    expect(f.deps.scan).not.toHaveBeenCalled();
    expect(f.deps.copyLegacy).not.toHaveBeenCalled();
    expect(f.deps.openSetup).not.toHaveBeenCalled();
    expect(flag).toHaveBeenCalledOnce();
    await f.service.download('message-other', 'account-other', 'other.txt');
    expect(f.deps.confirmUnscanned).toHaveBeenCalledTimes(2);
    expect(vi.mocked(f.deps.confirmUnscanned!).mock.calls[1]?.[0]?.accountId).toBe('account-other');
  });

  // Breaks: the modal truncates MIME metadata or offers the wrong Continue action.
  it.each(['view', 'open', 'download', 'calendar'] as const)(
    'passes the full filename and trusted %s action to the warning',
    async (action) => {
      const f = missingSetup();
      const filename = 'arakiri_A_50186774_/_3.pdf';
      const consume = vi.fn(async () => true);
      await f.service.operations.run(
        'message',
        'account',
        filename,
        consume,
        undefined,
        undefined,
        action
      );
      expect(f.deps.confirmUnscanned).toHaveBeenCalledWith(
        { messageId: 'message', accountId: 'account', filename, action },
        expect.any(AbortSignal),
        expect.any(Function)
      );
      expect(consume).toHaveBeenCalledOnce();
    }
  );

  // Breaks: a stale warning can persist suppression before the gate notices new setup or cancellation.
  it.each(['configuration', 'permission', 'cancel'] as const)(
    'validates %s before a warning implementation can remember its choice',
    async (change) => {
      const f = missingSetup();
      const remember = vi.fn();
      vi.mocked(f.deps.confirmUnscanned!).mockImplementation(async (_target, _signal, verify) => {
        if (change === 'configuration')
          f.assertMissing.mockRejectedValue(new Error('setup changed'));
        else if (change === 'permission')
          f.scanners([
            { id: 'clamav-scan', enabled: true, active: true, scanner: true, granted: false },
          ]);
        else f.service.cancel('warning-choice');
        await verify();
        remember();
        return 'continue';
      });
      await expect(
        f.service.download('message', 'account', 'sample.txt', 'warning-choice')
      ).rejects.toThrow(/changed|cancelled/);
      expect(remember).not.toHaveBeenCalled();
      expect(f.deps.resolveLegacy).not.toHaveBeenCalled();
    }
  );

  // Breaks: scanner revocation or cancellation during asynchronous snapshot validation still records suppression.
  it.each(['permission', 'cancel'] as const)(
    'rechecks %s after awaiting warning validation',
    async (change) => {
      const f = missingSetup();
      const remember = vi.fn();
      f.assertMissing.mockResolvedValueOnce(undefined).mockImplementationOnce(async () => {
        await Promise.resolve();
        if (change === 'permission')
          f.scanners([
            { id: 'clamav-scan', enabled: true, active: true, scanner: true, granted: false },
          ]);
        else f.service.cancel('warning-revalidation');
      });
      vi.mocked(f.deps.confirmUnscanned!).mockImplementation(async (_target, _signal, verify) => {
        await verify();
        remember();
        return 'continue';
      });
      await expect(
        f.service.download('message', 'account', 'sample.txt', 'warning-revalidation')
      ).rejects.toThrow(/changed|cancelled/);
      expect(remember).not.toHaveBeenCalled();
      expect(f.deps.resolveLegacy).not.toHaveBeenCalled();
    }
  );

  it.each(['cancel', 'setup'] as const)(
    'stops the action after choosing %s without reading or saving bytes',
    async (choice) => {
      const f = missingSetup();
      vi.mocked(f.deps.confirmUnscanned!).mockResolvedValue(choice);
      await expect(f.service.download('message', 'account', 'sample.txt')).rejects.toThrow(
        'Download cancelled.'
      );
      expect(f.deps.openSetup).toHaveBeenCalledTimes(choice === 'setup' ? 1 : 0);
      expect(f.deps.scan).not.toHaveBeenCalled();
      expect(f.deps.resolveLegacy).not.toHaveBeenCalled();
      expect(f.deps.chooseSavePath).not.toHaveBeenCalled();
    }
  );

  it('keeps missing setup blocked if the host has no warning implementation', async () => {
    const f = missingSetup();
    f.deps.confirmUnscanned = undefined;
    await expect(f.service.download('message', 'account', 'sample.txt')).rejects.toThrow(
      /Set up antivirus/
    );
    expect(f.deps.openSetup).toHaveBeenCalledWith('clamav-scan');
    expect(f.deps.resolveLegacy).not.toHaveBeenCalled();
  });

  it('does not offer a bypass when setup cannot be read or when a configured scan fails', async () => {
    const f = missingSetup();
    vi.mocked(f.deps.checkSetup!).mockRejectedValueOnce(new Error('credential store unreadable'));
    await expect(f.service.download('message', 'account', 'sample.txt')).rejects.toThrow(
      /unreadable/
    );
    expect(f.deps.confirmUnscanned).not.toHaveBeenCalled();
    vi.mocked(f.deps.checkSetup!).mockResolvedValue(undefined);
    for (const reason of ['threat', 'incomplete', 'offline', 'digest mismatch']) {
      vi.mocked(f.deps.scan).mockRejectedValueOnce(new Error(reason));
      await expect(f.service.download('message', 'account', 'sample.txt')).rejects.toThrow(reason);
    }
    expect(f.deps.confirmUnscanned).not.toHaveBeenCalled();
    expect(f.deps.resolveLegacy).not.toHaveBeenCalled();
  });

  it('rejects a configuration change or permission revocation while the warning is pending', async () => {
    for (const change of ['configuration', 'permission']) {
      const f = missingSetup();
      vi.mocked(f.deps.confirmUnscanned!).mockImplementation(async () => {
        if (change === 'configuration')
          f.assertMissing.mockRejectedValue(new Error('setup changed'));
        else
          f.scanners([
            { id: 'clamav-scan', enabled: true, active: true, scanner: true, granted: false },
          ]);
        return 'continue';
      });
      await expect(f.service.download('message', 'account', 'sample.txt')).rejects.toThrow(
        /changed/
      );
      expect(f.deps.resolveLegacy).not.toHaveBeenCalled();
    }
  });

  it('cancels a pending warning and ignores a late Continue response', async () => {
    const f = missingSetup();
    let finish!: () => void;
    vi.mocked(f.deps.confirmUnscanned!).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = () => resolve('continue');
        })
    );
    const pending = f.service.download('message', 'account', 'sample.txt', 'pending-warning');
    await vi.waitFor(() => expect(f.deps.confirmUnscanned).toHaveBeenCalled());
    f.service.cancel('pending-warning');
    await expect(pending).rejects.toThrow('Download cancelled.');
    finish();
    await Promise.resolve();
    expect(f.deps.resolveLegacy).not.toHaveBeenCalled();
  });

  it('bounds a stalled warning and rejects future actions after shutdown', async () => {
    const f = missingSetup();
    f.deps.timeoutMs = 5;
    vi.mocked(f.deps.confirmUnscanned!).mockImplementation(() => new Promise(() => {}));
    await expect(f.service.download('message', 'account', 'sample.txt')).rejects.toThrow(
      /timed out/
    );
    setAttachmentOperationProtection(f.service.operations);
    expect(getAttachmentOperationProtection()).toBe(f.service.operations);
    f.service.operations.dispose();
    await expect(f.service.download('message', 'account', 'sample.txt')).rejects.toThrow(
      'Download cancelled.'
    );
  });

  it('allows derived content only after missing-setup continuation and never sends it to the configured scanner', async () => {
    const f = missingSetup();
    const consume = vi.fn(async (operation) => operation.notScanned);
    expect(
      await f.service.operations.run(
        'message',
        'account',
        'generated.ics',
        consume,
        undefined,
        'Cannot scan generated content'
      )
    ).toBe(true);
    vi.mocked(f.deps.checkSetup!).mockResolvedValue(undefined);
    await expect(
      f.service.operations.run(
        'message',
        'account',
        'generated.ics',
        consume,
        undefined,
        'Cannot scan generated content'
      )
    ).rejects.toThrow(/Cannot scan generated/);
    expect(f.deps.scan).not.toHaveBeenCalled();
    expect(consume).toHaveBeenCalledOnce();
  });

  // Regression: changing setup while a bypass save stages must preserve an existing destination.
  it('erases local snapshots and preserves the destination if setup changes before commit', async () => {
    const f = missingSetup();
    const directory = await mkdtemp(path.join(tmpdir(), 'inbox-unscanned-save-'));
    temporary.push(directory);
    const destination = path.join(directory, 'saved.txt');
    await writeFile(destination, 'original');
    const content = Buffer.from('not scanned local bytes');
    vi.mocked(f.deps.readLegacy!).mockResolvedValue(content);
    vi.mocked(f.deps.chooseSavePath).mockResolvedValue(destination);
    vi.mocked(f.deps.writeContent).mockImplementation((file, bytes, signal, beforeCommit) =>
      writeProtectedAttachment(file, bytes, signal, async () => {
        f.assertMissing.mockRejectedValue(new Error('setup changed'));
        await beforeCommit();
      })
    );
    await expect(f.service.download('message', 'account', 'sample.txt')).rejects.toThrow(
      /setup changed/
    );
    expect(await readFile(destination, 'utf8')).toBe('original');
    expect(await readdir(directory)).toEqual(['saved.txt']);
    expect(content.every((byte) => byte === 0)).toBe(true);
  });

  it('cannot continue a local save without a bounded read implementation', async () => {
    const f = missingSetup();
    f.deps.readLegacy = undefined;
    await expect(f.service.download('message', 'account', 'sample.txt')).rejects.toThrow(
      /could not be saved/
    );
    expect(f.deps.chooseSavePath).not.toHaveBeenCalled();
    expect(f.deps.copyLegacy).not.toHaveBeenCalled();
  });
});

// Breaks: warning-approved previews buffer an unbounded local file or retain intermediate bytes.
describe('bounded local attachment snapshots', () => {
  it('copies exact bytes up to the bound, rejects larger files, and handles empty/missing/aborted reads', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'inbox-local-bound-'));
    temporary.push(directory);
    const file = path.join(directory, 'local.txt');
    const signal = new AbortController().signal;
    await writeFile(file, '12345');
    expect((await readUnscannedAttachment(file, signal, 5)).toString()).toBe('12345');
    await expect(readUnscannedAttachment(file, signal, 4)).rejects.toThrow(/too large/);
    await writeFile(file, '');
    expect(await readUnscannedAttachment(file, signal, 5)).toEqual(Buffer.alloc(0));
    await expect(
      readUnscannedAttachment(path.join(directory, 'missing'), signal, 5)
    ).rejects.toThrow();
    const abort = new AbortController();
    abort.abort();
    await expect(readUnscannedAttachment(file, abort.signal, 5)).rejects.toThrow(/aborted/);
  });
});

// Breaks: an interrupted or revoked save destroys the user's existing file or leaves exposed partial bytes.
describe('protected attachment destination writes', () => {
  async function destination() {
    const directory = await mkdtemp(path.join(tmpdir(), 'inbox-download-test-'));
    temporary.push(directory);
    const file = path.join(directory, 'saved.txt');
    await writeFile(file, 'original destination');
    return { directory, file };
  }

  it('atomically replaces a destination only after the final authorization check', async () => {
    const f = await destination();
    await writeProtectedAttachment(
      f.file,
      Buffer.from('verified bytes'),
      new AbortController().signal,
      async () => {
        expect(await readFile(f.file, 'utf8')).toBe('original destination');
        expect(await readdir(f.directory)).toHaveLength(2);
      }
    );
    expect(await readFile(f.file, 'utf8')).toBe('verified bytes');
    expect(await readdir(f.directory)).toEqual(['saved.txt']);
  });

  it.each(['cancel', 'revoke'] as const)(
    'preserves the destination and deletes staging when %s occurs before commit',
    async (action) => {
      const f = await destination();
      const abort = new AbortController();
      const write = writeProtectedAttachment(
        f.file,
        Buffer.from('verified bytes'),
        abort.signal,
        async () => {
          if (action === 'cancel') abort.abort(new Error('Download cancelled.'));
          else throw new Error('consent revoked');
        }
      );
      await expect(write).rejects.toThrow(action === 'cancel' ? /cancelled/ : /revoked/);
      expect(await readFile(f.file, 'utf8')).toBe('original destination');
      expect(await readdir(f.directory)).toEqual(['saved.txt']);
    }
  );
});

// Breaks: revoking a permission or failing activation silently changes an enabled scanner into an unprotected download.
describe('download scanner recognition', () => {
  it.each([
    { id: 'clamav-scan', grantedPermissions: [], manifest: undefined },
    { id: 'other-scanner', grantedPermissions: ['security:scan-attachments'], manifest: undefined },
    {
      id: 'other-scanner',
      grantedPermissions: [],
      manifest: { permissions: ['security:scan-attachments'] },
    },
    {
      id: 'other-scanner',
      grantedPermissions: [],
      manifest: { permissions: [], contributes: { capabilities: [{ id: 'attachment.scan' }] } },
    },
  ])('recognizes an enabled scanner from %j', ({ id, grantedPermissions, manifest }) => {
    const manager = {
      getRegistry: () => ({
        getAll: () => [{ id, enabled: true, grantedPermissions }],
        getLoaded: () => (manifest ? { manifest } : undefined),
      }),
      getHost: () => ({ isActive: () => false }),
    } as unknown as Parameters<typeof downloadScanners>[0];
    expect(downloadScanners(manager)).toEqual([
      { id, enabled: true, active: false, scanner: true, granted: grantedPermissions.length > 0 },
    ]);
    expect(attachmentScanRequired(manager)).toBe(true);
  });

  it('does not require scanning for unrelated or disabled extensions', () => {
    const manager = {
      getRegistry: () => ({
        getAll: () => [
          { id: 'other-extension', enabled: true, grantedPermissions: [] },
          { id: 'clamav-scan', enabled: false, grantedPermissions: [] },
        ],
        getLoaded: () => ({ manifest: { permissions: [] } }),
      }),
      getHost: () => ({ isActive: () => true }),
    } as unknown as Parameters<typeof downloadScanners>[0];
    expect(attachmentScanRequired(manager)).toBe(false);
    expect(attachmentScanRequired(null)).toBe(false);
  });
});
