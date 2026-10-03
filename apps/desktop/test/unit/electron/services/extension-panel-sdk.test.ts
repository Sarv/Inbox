import { runInNewContext } from 'node:vm';

import type { ExtensionSecurity } from '@sarvinbox/core';
import { describe, expect, it } from 'vitest';

import { PANEL_SDK_SOURCE } from '../../../../electron/services/extension-panel-sdk';

describe('panel antivirus SDK', () => {
  it('exposes the six promise based methods and only sends target ids and options', async () => {
    const requests: Array<{ channel: string; requestId: string; method: string; params?: unknown }> = [];
    let onMessage!: (event: { data: unknown }) => void;
    const window: { sarv?: { security: ExtensionSecurity }; addEventListener: (_name: string, callback: typeof onMessage) => void } = {
      addEventListener: (_name: string, callback: typeof onMessage) => { onMessage = callback; },
    };
    runInNewContext(PANEL_SDK_SOURCE, {
      window,
      parent: { postMessage: (request: typeof requests[number]) => requests.push(request) },
      console,
    });
    const security = window.sarv!.security;
    const calls = [
      security.getTargets(), security.getSetup(), security.openSetup(),
      security.submit(['opaque-attachment'], { includeBodyConsent: true }),
      security.get('job-1'), security.cancel('job-1'),
    ];
    expect(requests.map((request) => request.method)).toEqual([
      'security.getTargets', 'security.getSetup', 'security.openSetup',
      'security.submit', 'security.get', 'security.cancel',
    ]);
    expect(requests[3].params).toEqual({
      targetIds: ['opaque-attachment'], options: { includeBodyConsent: true },
    });
    expect(requests[4].params).toEqual({ jobId: 'job-1' });
    expect(requests[5].params).toEqual({ jobId: 'job-1' });
    requests.forEach((request, index) => onMessage({ data: {
      channel: request.channel, requestId: request.requestId, ok: true, value: index,
    } }));
    expect(await Promise.all(calls)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('propagates host permission errors to the panel caller', async () => {
    let request: { channel: string; requestId: string } | undefined;
    let onMessage!: (event: { data: unknown }) => void;
    const window: { sarv?: { security: ExtensionSecurity }; addEventListener: (_name: string, callback: typeof onMessage) => void } = {
      addEventListener: (_name: string, callback: typeof onMessage) => { onMessage = callback; },
    };
    runInNewContext(PANEL_SDK_SOURCE, {
      window, console, parent: { postMessage: (value: typeof request) => { request = value; } },
    });
    const pending = window.sarv!.security.submit(['body']);
    onMessage({ data: { ...request, ok: false, error: "Permission denied: 'security:scan-body'" } });
    await expect(pending).rejects.toThrow('security:scan-body');
  });
});
