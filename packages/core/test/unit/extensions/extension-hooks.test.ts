/**
 * The hook surface an extension manages the app through: `ctx.mail`,
 * `ctx.ui.onAction`, `ctx.ui.openPanel`/`openMessage`, and manifest-declared
 * capabilities.
 *
 * These are the calls that CHANGE the reader's mailbox from third-party code,
 * so what is asserted here is mostly what they refuse to do. A permission gate
 * that quietly stops working looks like nothing at all from the outside — the
 * extension keeps working, it simply works without the user having agreed.
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExtensionContextImpl } from '../../../src/extensions/extension-api';
import type {
  ExtensionMailBackend,
  ExtensionSettingsBackend,
  ExtensionStorageBackend,
  ExtensionUIBackend,
} from '../../../src/extensions/extension-api';
import { validateManifest } from '../../../src/extensions/extension-loader';
import { panelRequestPermission } from '../../../src/extensions/panel-bridge';
import type {
  ExtensionManifest,
  ExtensionPermission,
  ExtensionUIAction,
} from '../../../src/extensions/types';
import { splitNotificationId } from '../../../src/extensions/ui-notification';
import { createEventBus } from '../../../src/pipeline/event-bus';

let workDir: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'sarvinbox-hooks-'));
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function manifestFor(id: string, extra: Partial<ExtensionManifest> = {}): ExtensionManifest {
  return {
    id,
    name: id,
    version: '1.0.0',
    description: 'test extension',
    author: 'test',
    main: 'index.js',
    engines: { sarvinbox: '>=0.1.0' },
    permissions: [],
    ...extra,
  } as ExtensionManifest;
}

function noopStorageBackend(): ExtensionStorageBackend {
  const data = new Map<string, unknown>();
  return {
    get: <T>(_id: string, key: string) => data.get(key) as T | undefined,
    set: async (_id: string, key: string, value: unknown) => {
      data.set(key, value);
    },
    delete: async (_id: string, key: string) => {
      data.delete(key);
    },
    clear: async () => {
      data.clear();
    },
    keys: () => [...data.keys()],
  };
}

function noopSettingsBackend(): ExtensionSettingsBackend {
  return {
    get: () => undefined,
    update: async () => undefined,
    has: () => false,
  };
}

/** A mail backend that records what it was asked to do and nothing else. */
function recordingMailBackend() {
  const calls: { method: string; args: unknown[] }[] = [];
  const backend: ExtensionMailBackend = {
    get: async (...args) => {
      calls.push({ method: 'get', args });
      return null;
    },
    folders: async (...args) => {
      calls.push({ method: 'folders', args });
      return [];
    },
    applyLabels: async (...args) => {
      calls.push({ method: 'applyLabels', args });
    },
    move: async (...args) => {
      calls.push({ method: 'move', args });
    },
    trash: async (...args) => {
      calls.push({ method: 'trash', args });
    },
  };
  return { backend, calls };
}

function contextFor(
  id: string,
  grantedPermissions: ExtensionPermission[],
  extra: {
    manifest?: Partial<ExtensionManifest>;
    mailBackend?: ExtensionMailBackend;
    uiBackend?: ExtensionUIBackend;
  } = {}
): ExtensionContextImpl {
  return new ExtensionContextImpl({
    manifest: manifestFor(id, extra.manifest ?? {}),
    storagePath: join(workDir, id),
    grantedPermissions,
    eventBus: createEventBus(),
    storageBackend: noopStorageBackend(),
    settingsBackend: noopSettingsBackend(),
    mailBackend: extra.mailBackend,
    uiBackend: extra.uiBackend,
  });
}

// ------------------------------------------------------------------
// ctx.mail
// ------------------------------------------------------------------

describe('context.mail permission gates', () => {
  // Regression: every mail mutation is gated on the permission the user was
  // actually shown at install. If a wrapper stops checking, an extension that
  // asked only to READ mail can start relabelling, moving and trashing it.
  it.each([
    ['get', 'email:read', (mail: any) => mail.get('e1')],
    ['folders', 'email:read', (mail: any) => mail.folders()],
    ['markRead', 'email:flag', (mail: any) => mail.markRead('e1')],
    ['markUnread', 'email:flag', (mail: any) => mail.markUnread('e1')],
    ['star', 'email:flag', (mail: any) => mail.star('e1')],
    ['unstar', 'email:flag', (mail: any) => mail.unstar('e1')],
    ['addLabel', 'email:label', (mail: any) => mail.addLabel('e1', 'work')],
    ['removeLabel', 'email:label', (mail: any) => mail.removeLabel('e1', 'work')],
    ['move', 'email:move', (mail: any) => mail.move('e1', 'f1')],
    ['trash', 'email:delete', (mail: any) => mail.trash('e1')],
  ])('mail.%s is refused without %s', async (operation, permission, call) => {
    const { backend, calls } = recordingMailBackend();
    // Granted everything EXCEPT the one permission this call needs.
    const granted = (
      ['email:read', 'email:label', 'email:flag', 'email:move', 'email:delete'] as const
    ).filter((candidate) => candidate !== permission) as ExtensionPermission[];

    const context = contextFor('gated', granted, { mailBackend: backend });
    await expect(Promise.resolve().then(() => call(context.mail))).rejects.toThrow(
      /permission/i
    );
    expect(calls).toHaveLength(0);

    // …and goes through once it IS granted, so the test cannot pass by the
    // method being broken for everyone.
    const allowed = contextFor('allowed', [...granted, permission as ExtensionPermission], {
      mailBackend: backend,
    });
    await call(allowed.mail);
    expect(calls.map((entry) => entry.method)).toContain(
      operation === 'get' || operation === 'folders' || operation === 'move' || operation === 'trash'
        ? operation
        : 'applyLabels'
    );
  });

  // Regression: read and starred are FLAGS, not labels — routing them through
  // `applyLabels` is what makes the host push them to the server through the
  // same planner a workflow uses. A separate path here would drift from it.
  it('maps flags onto add/remove of the flag tag', async () => {
    const { backend, calls } = recordingMailBackend();
    const context = contextFor('flags', ['email:flag'], { mailBackend: backend });

    await context.mail.markRead('e1');
    await context.mail.markUnread('e2');
    await context.mail.star('e3');
    await context.mail.unstar('e4');

    expect(calls.map((entry) => entry.args[2])).toEqual([
      { add: ['read'] },
      { remove: ['read'] },
      { add: ['starred'] },
      { remove: ['starred'] },
    ]);
  });

  // Regression: a host that wires no mail backend must say so. Resolving
  // silently would have an extension believe it filed the mail, and a reader
  // find it unfiled, with nothing anywhere saying why.
  it('throws rather than no-opping when the host has no mail backend', async () => {
    const context = contextFor('nobackend', ['email:flag']);
    await expect(context.mail.markRead('e1')).rejects.toThrow(/not available in this host/);
  });
});

// ------------------------------------------------------------------
// ctx.ui.onAction / openPanel / openMessage
// ------------------------------------------------------------------

describe('context.ui action hooks', () => {
  // Regression: this is the return leg that lets a card DO something. Losing
  // it turns every notification into a dead end that can show a value but
  // never learn the reader took it.
  it('delivers a card action to every subscriber', () => {
    const context = contextFor('cards', ['ui:notify']);
    const seen: ExtensionUIAction[] = [];
    context.ui.onAction((action) => {
      seen.push(action);
    });
    context.ui.onAction((action) => {
      seen.push(action);
    });

    context.dispatchUIAction({ notificationId: 'code:e1', action: 'copy', emailId: 'e1' });
    expect(seen).toHaveLength(2);
    expect(seen[0].action).toBe('copy');
  });

  // Regression: unsubscribing must actually stop delivery, or a handler
  // registered per message accumulates for the life of the process.
  it('stops delivering after unsubscribe', () => {
    const context = contextFor('cards', ['ui:notify']);
    let count = 0;
    const off = context.ui.onAction(() => {
      count += 1;
    });
    context.dispatchUIAction({ notificationId: 'a', action: 'copy' });
    off();
    context.dispatchUIAction({ notificationId: 'a', action: 'copy' });
    expect(count).toBe(1);
  });

  // Regression: one extension's throwing handler must not stop the others
  // from being told, and must never reach the reader's click as an error.
  it('keeps running handlers when one throws or rejects', async () => {
    const context = contextFor('cards', ['ui:notify']);
    let reached = false;
    context.ui.onAction(() => {
      throw new Error('boom');
    });
    context.ui.onAction(async () => {
      throw new Error('async boom');
    });
    context.ui.onAction(() => {
      reached = true;
    });

    expect(() =>
      context.dispatchUIAction({ notificationId: 'a', action: 'copy' })
    ).not.toThrow();
    expect(reached).toBe(true);
    await vi.waitFor(() => expect(reached).toBe(true));
  });

  it('refuses onAction without ui:notify, and a non-function handler', () => {
    const ungranted = contextFor('cards', []);
    expect(() => ungranted.ui.onAction(() => undefined)).toThrow(/permission/i);

    const granted = contextFor('cards', ['ui:notify']);
    expect(() => granted.ui.onAction('nope' as never)).toThrow(/expects a function/);
  });

  // Regression: an extension with ui:panel could otherwise open ANOTHER
  // extension's panel — putting a surface the reader trusts on screen at a
  // moment of its own choosing.
  it('refuses to open a panel the manifest does not declare', () => {
    const opened: string[] = [];
    const uiBackend: ExtensionUIBackend = {
      notify: () => undefined,
      dismiss: () => undefined,
      openPanel: (_id, panelId) => opened.push(panelId),
    };
    const context = contextFor('panels', ['ui:panel'], {
      manifest: { contributes: { panels: [{ id: 'mine', title: 'Mine', entry: 'p.html', surface: 'sidebar' }] } } as Partial<ExtensionManifest>,
      uiBackend,
    });

    expect(() => context.ui.openPanel('someone-elses')).toThrow(/declares no panel/);
    expect(opened).toHaveLength(0);

    context.ui.openPanel('mine');
    expect(opened).toEqual(['mine']);
  });

  // Regression: openMessage navigates the reader's window. It is gated on
  // email:read because knowing which message to open is knowing about the mail.
  it('refuses openMessage without email:read', () => {
    const context = contextFor('nav', []);
    expect(() => context.ui.openMessage('e1')).toThrow(/permission/i);
  });

  // Regression: a disposed context must not keep delivering into handlers that
  // belong to an extension the user has disabled.
  it('drops action handlers on dispose', async () => {
    const context = contextFor('cards', ['ui:notify']);
    let count = 0;
    context.ui.onAction(() => {
      count += 1;
    });
    await context.dispose();
    context.dispatchUIAction({ notificationId: 'a', action: 'copy' });
    expect(count).toBe(0);
  });
});

// ------------------------------------------------------------------
// Capabilities
// ------------------------------------------------------------------

describe('capability contributions', () => {
  // Regression: a capability with no id or no export names nothing callable —
  // the app would resolve a provider and then fail at invoke time, on the
  // reader's click rather than at install.
  it.each([
    ['no id', { export: 'summarize' }],
    ['no export', { id: 'thread.summarize' }],
    ['an id with spaces', { id: 'thread summarize', export: 'summarize' }],
    ['a non-numeric priority', { id: 'thread.summarize', export: 'summarize', priority: 'high' }],
  ])('rejects a capability with %s', (_label, capability) => {
    const result = validateManifest(
      manifestFor('cap', { contributes: { capabilities: [capability] } } as Partial<ExtensionManifest>)
    );
    expect(result.valid).toBe(false);
  });

  // Regression: two capabilities sharing an id in one manifest makes which one
  // answers depend on array order — a coin flip the author never sees.
  it('rejects duplicate capability ids in one manifest', () => {
    const result = validateManifest(
      manifestFor('cap', {
        contributes: {
          capabilities: [
            { id: 'thread.summarize', export: 'a' },
            { id: 'thread.summarize', export: 'b' },
          ],
        },
      } as Partial<ExtensionManifest>)
    );
    expect(result.valid).toBe(false);
  });

  it('accepts a well-formed capability', () => {
    const result = validateManifest(
      manifestFor('cap', {
        contributes: {
          capabilities: [{ id: 'thread.summarize', export: 'summarizeThread', priority: 10 }],
        },
      } as Partial<ExtensionManifest>)
    );
    expect(result.valid).toBe(true);
  });
});

// ------------------------------------------------------------------
// Notification id round trip
// ------------------------------------------------------------------

describe('splitNotificationId', () => {
  // Regression: the split is on the FIRST colon because an extension id can
  // never contain one but an extension-authored card id often does. Splitting
  // the other way hands the extension its own id back truncated, and the
  // action goes to nobody.
  it('splits on the first colon so a card id may contain colons', () => {
    expect(splitNotificationId('otp-code:code:e1')).toEqual({
      extensionId: 'otp-code',
      notificationId: 'code:e1',
    });
  });

  it.each([
    ['no colon', 'otp-code'],
    ['an empty extension id', ':code'],
    ['an empty card id', 'otp-code:'],
    ['an invalid extension id', 'OTP Code:code'],
    ['an empty string', ''],
  ])('returns null for %s', (_label, input) => {
    expect(splitNotificationId(input)).toBeNull();
  });
});

// ------------------------------------------------------------------
// Panel surface
// ------------------------------------------------------------------

describe('panel mail methods', () => {
  // Regression: a panel runs extension-authored code inside the reader's
  // window. Every method it can call must map to exactly one permission here —
  // an unlisted method is refused, so a new one cannot ship ungated by being
  // forgotten.
  it.each([
    ['mail.get', 'email:read'],
    ['mail.folders', 'email:read'],
    ['mail.markRead', 'email:flag'],
    ['mail.markUnread', 'email:flag'],
    ['mail.star', 'email:flag'],
    ['mail.unstar', 'email:flag'],
    ['mail.addLabel', 'email:label'],
    ['mail.removeLabel', 'email:label'],
    ['mail.move', 'email:move'],
    ['mail.trash', 'email:delete'],
  ])('%s needs %s', (method, permission) => {
    expect(panelRequestPermission(method as never)).toBe(permission);
  });

  // Regression: an unknown method must resolve to `undefined`, which the caller
  // treats as a refusal. Defaulting to "no permission required" would make
  // every future method public the day it is added.
  it('returns undefined for a method with no entry', () => {
    expect(panelRequestPermission('mail.expunge' as never)).toBeUndefined();
  });
});
