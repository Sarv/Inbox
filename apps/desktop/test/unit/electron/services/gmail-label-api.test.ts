import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Gmail label colors. Color is COSMETIC and labels are the point, so every path
 * degrades instead of throwing: an unknown color means "plain label", a rejected
 * color falls back to creating the label plain, and any transport failure is
 * swallowed. Also pinned: the already-correct color is a NO-OP (the repeated
 * provisioning PATCH storm) and names match case-insensitively.
 */

vi.mock('@sarvinbox/core', () => ({
  createLogger: () => ({
    info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, trace: () => {},
  }),
}));

import {
  deleteGmailLabelsUnder,
  ensureGmailLabelColor,
  renameGmailLabel,
} from '../../../../electron/services/gmail-label-api';

const API = 'https://gmail.googleapis.com/gmail/v1/users/me/labels';

interface Call { url: string; method: string; body: Record<string, unknown> | undefined; auth: string | undefined }

let calls: Call[] = [];
let labels: Array<Record<string, unknown>> = [];
/** url+method -> canned outcome. */
let failures: Array<{ match: (c: Call) => boolean; status?: number; text?: string; throws?: boolean }> = [];
let getStatus = 200;
let getBodyIsJson = true;

const originalFetch = globalThis.fetch;

const jsonResponse = (body: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as Response;

beforeEach(() => {
  calls = [];
  labels = [];
  failures = [];
  getStatus = 200;
  getBodyIsJson = true;

  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const call: Call = {
      url: String(url),
      method: init?.method ?? 'GET',
      body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined,
      auth: (init?.headers as Record<string, string> | undefined)?.Authorization,
    };
    calls.push(call);

    const failure = failures.find((f) => f.match(call));
    if (failure?.throws) throw new Error('network down');
    if (failure) {
      return {
        ok: false,
        status: failure.status ?? 400,
        text: async () => failure.text ?? 'rejected',
        json: async () => ({}),
      } as unknown as Response;
    }

    if (call.method === 'GET') {
      if (!getBodyIsJson) {
        return {
          ok: true,
          status: getStatus,
          json: async () => { throw new Error('not json'); },
          text: async () => 'garbage',
        } as unknown as Response;
      }
      return jsonResponse({ labels }, getStatus);
    }
    if (call.method === 'DELETE') {
      return { ok: true, status: 204, json: async () => null, text: async () => '' } as unknown as Response;
    }
    return jsonResponse({ id: 'new-id' });
  }) as unknown as typeof fetch;
});

afterEach(() => { globalThis.fetch = originalFetch; });

const post = () => calls.find((c) => c.method === 'POST');
const patch = () => calls.find((c) => c.method === 'PATCH');

describe('ensureGmailLabelColor — color resolution', () => {
  it('snaps a NAMED color to Gmail’s fixed palette and picks readable text', async () => {
    await expect(ensureGmailLabelColor('tok', 'Sarv Inbox/Work', 'blue')).resolves.toBe(true);
    const color = post()!.body!.color as { backgroundColor: string; textColor: string };
    expect(color.backgroundColor).toMatch(/^#[0-9a-f]{6}$/);
    expect(['#000000', '#ffffff']).toContain(color.textColor);
  });

  it('accepts a hex with or without the leading #, case-insensitively', async () => {
    await ensureGmailLabelColor('tok', 'A', '#FB4C2F');
    const first = (post()!.body!.color as { backgroundColor: string }).backgroundColor;
    calls = [];
    await ensureGmailLabelColor('tok', 'A', 'fb4c2f');
    const second = (post()!.body!.color as { backgroundColor: string }).backgroundColor;
    expect(second).toBe(first);
    // An exact palette member snaps to itself.
    expect(first).toBe('#fb4c2f');
  });

  it('picks BLACK text on a light background and WHITE on a dark one', async () => {
    await ensureGmailLabelColor('tok', 'light', '#cccccc');
    expect((post()!.body!.color as { textColor: string }).textColor).toBe('#000000');
    calls = [];
    await ensureGmailLabelColor('tok', 'dark', '#434343');
    expect((post()!.body!.color as { textColor: string }).textColor).toBe('#ffffff');
  });

  it('creates a PLAIN label for an unknown / missing color', async () => {
    await expect(ensureGmailLabelColor('tok', 'Plain', 'chartreuse')).resolves.toBe(true);
    expect(post()!.body).toEqual({
      name: 'Plain', labelListVisibility: 'labelShow', messageListVisibility: 'show',
    });

    calls = [];
    await ensureGmailLabelColor('tok', 'Plain2');
    expect(post()!.body!.color).toBeUndefined();
  });

  it('sends the bearer token on every call', async () => {
    await ensureGmailLabelColor('tok-123', 'X', 'red');
    expect(calls.every((c) => c.auth === 'Bearer tok-123')).toBe(true);
    expect(calls[0].url).toBe(API);
  });
});

describe('ensureGmailLabelColor — existing labels', () => {
  it('PATCHes an existing label whose color differs', async () => {
    labels = [{ id: 'L1', name: 'sarv inbox/work', color: { backgroundColor: '#999999', textColor: '#000000' } }];
    await expect(ensureGmailLabelColor('tok', 'Sarv Inbox/Work', 'blue')).resolves.toBe(true);
    expect(patch()!.url).toBe(`${API}/L1`);
    expect(post()).toBeUndefined();
  });

  it('is a NO-OP when the color already matches (no PATCH storm)', async () => {
    // Learn the snapped color first.
    await ensureGmailLabelColor('tok', 'Work', 'blue');
    const color = post()!.body!.color as { backgroundColor: string; textColor: string };
    calls = [];

    labels = [{ id: 'L1', name: 'Work', color }];
    await expect(ensureGmailLabelColor('tok', 'Work', 'blue')).resolves.toBe(false);
    expect(patch()).toBeUndefined();
  });

  it('leaves an existing label alone when no color is wanted', async () => {
    labels = [{ id: 'L1', name: 'Work' }];
    await expect(ensureGmailLabelColor('tok', 'Work')).resolves.toBe(false);
    expect(calls).toHaveLength(1); // the GET only
  });

  it('treats a colorless existing label as needing the color', async () => {
    labels = [{ id: 'L1', name: 'Work' }];
    await expect(ensureGmailLabelColor('tok', 'Work', 'red')).resolves.toBe(true);
    expect(patch()).toBeTruthy();
  });

  it('returns false (never throws) when the PATCH is rejected', async () => {
    labels = [{ id: 'L1', name: 'Work' }];
    failures = [{ match: (c) => c.method === 'PATCH', status: 400, text: 'bad color' }];
    await expect(ensureGmailLabelColor('tok', 'Work', 'red')).resolves.toBe(false);
  });
});

describe('ensureGmailLabelColor — failure fallbacks', () => {
  it('falls back to creating the label PLAIN when the colored create is rejected', async () => {
    let seen = 0;
    failures = [{ match: (c) => c.method === 'POST' && seen++ === 0, status: 400, text: 'color rejected' }];
    await expect(ensureGmailLabelColor('tok', 'Work', 'red')).resolves.toBe(true);
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts).toHaveLength(2);
    expect(posts[1].body!.color).toBeUndefined();
  });

  it('returns false when even the plain create fails', async () => {
    failures = [{ match: (c) => c.method === 'POST', status: 500, text: 'boom' }];
    await expect(ensureGmailLabelColor('tok', 'Work', 'red')).resolves.toBe(false);
  });

  it('returns false when the label list cannot be read', async () => {
    failures = [{ match: (c) => c.method === 'GET', throws: true }];
    await expect(ensureGmailLabelColor('tok', 'Work', 'red')).resolves.toBe(false);
  });

  it('tolerates a GET whose body is not JSON', async () => {
    getBodyIsJson = false;
    // api() resolves to null -> destructuring `{ labels = [] }` throws -> caught.
    await expect(ensureGmailLabelColor('tok', 'Work', 'red')).resolves.toBe(false);
  });

  it('surfaces the HTTP status in the error it swallows (no throw to the caller)', async () => {
    failures = [{ match: (c) => c.method === 'GET', status: 403, text: 'x'.repeat(500) }];
    await expect(ensureGmailLabelColor('tok', 'Work')).resolves.toBe(false);
  });
});

describe('renameGmailLabel', () => {
  it('patches the name of the matching label (case-insensitive)', async () => {
    labels = [{ id: 'L1', name: 'Sarv Inbox/Old' }];
    await renameGmailLabel('tok', 'sarv inbox/old', 'Sarv Inbox/New');
    expect(patch()!.url).toBe(`${API}/L1`);
    expect(patch()!.body).toEqual({ name: 'Sarv Inbox/New' });
  });

  it('does nothing when the names are identical', async () => {
    await renameGmailLabel('tok', 'Same', 'Same');
    expect(calls).toHaveLength(0);
  });

  it('does nothing when the label does not exist', async () => {
    labels = [{ id: 'L1', name: 'Other' }];
    await renameGmailLabel('tok', 'Missing', 'New');
    expect(patch()).toBeUndefined();
  });

  it('swallows a rejected PATCH (target name may already exist)', async () => {
    labels = [{ id: 'L1', name: 'Old' }];
    failures = [{ match: (c) => c.method === 'PATCH', status: 409, text: 'exists' }];
    await expect(renameGmailLabel('tok', 'Old', 'New')).resolves.toBeUndefined();
  });

  it('swallows a failing label list', async () => {
    failures = [{ match: (c) => c.method === 'GET', throws: true }];
    await expect(renameGmailLabel('tok', 'Old', 'New')).resolves.toBeUndefined();
  });
});

describe('deleteGmailLabelsUnder', () => {
  it('deletes the prefix label and everything under it, and counts them', async () => {
    labels = [
      { id: 'L1', name: 'Sarv Inbox' },
      { id: 'L2', name: 'Sarv Inbox/Work' },
      { id: 'L3', name: 'sarv inbox/Personal' },
      { id: 'L4', name: 'Sarv Inbox Archive' }, // NOT under the prefix
      { id: 'L5', name: 'Unrelated' },
    ];
    await expect(deleteGmailLabelsUnder('tok', 'Sarv Inbox')).resolves.toBe(3);
    const deleted = calls.filter((c) => c.method === 'DELETE').map((c) => c.url);
    expect(deleted).toEqual([`${API}/L1`, `${API}/L2`, `${API}/L3`]);
  });

  it('skips a label whose delete fails and still counts the rest', async () => {
    labels = [{ id: 'L1', name: 'P/a' }, { id: 'L2', name: 'P/b' }];
    failures = [{ match: (c) => c.url.endsWith('/L1'), status: 404, text: 'gone' }];
    await expect(deleteGmailLabelsUnder('tok', 'P')).resolves.toBe(1);
  });

  it('is 0 when nothing matches, and 0 when the list cannot be read', async () => {
    labels = [{ id: 'L1', name: 'Other' }];
    await expect(deleteGmailLabelsUnder('tok', 'P')).resolves.toBe(0);

    failures = [{ match: (c) => c.method === 'GET', throws: true }];
    await expect(deleteGmailLabelsUnder('tok', 'P')).resolves.toBe(0);
  });
});
