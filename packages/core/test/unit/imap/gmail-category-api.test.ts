import { afterEach, describe, expect, it, vi } from 'vitest';

import { gmailMessageIdHex, modifyGmailNativeCategories } from '../../../src/imap/gmail-category-api';
import { isConnectionError } from '../../../src/imap/imap-errors';
import { OAuthError } from '../../../src/oauth/types';

const base = () => ({ messageId: '18446744073709551615', add: ['promotions'], remove: ['social'],
  resolveBearer: vi.fn(async () => 'synthetic-token'), fetch: vi.fn(async () => new Response(null, { status: 200 })) });

afterEach(() => vi.useRealTimers());

describe('Gmail message identity', () => {
  it('preserves all 64 bits while converting decimal IMAP IDs to API hex', () => {
    expect(gmailMessageIdHex('18446744073709551615')).toBe('ffffffffffffffff');
    expect(gmailMessageIdHex(1278455344230334865n)).toBe('11bdfc5cae0c8191');
  });
  it.each(['0', '-1', '12.5', '0xff', '18446744073709551616', '', 123 as any])('rejects invalid identity %s', (id) => {
    expect(() => gmailMessageIdHex(id)).toThrow(expect.objectContaining({ code: 'GMAIL_MESSAGE_ID_INVALID', retryable: false }));
  });
});

describe('native Gmail category mutations', () => {
  it('uses the exact account resolver and alters only canonical category labels', async () => {
    const change = base();
    await modifyGmailNativeCategories(change);
    expect(change.resolveBearer).toHaveBeenCalledExactlyOnceWith(false);
    const [url, init] = change.fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/ffffffffffffffff/modify');
    expect(JSON.parse(init.body as string)).toEqual({ addLabelIds: ['CATEGORY_PROMOTIONS'], removeLabelIds: ['CATEGORY_SOCIAL'] });
    expect(init.redirect).toBe('error');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
  it('refreshes once after 401 and uses the refreshed mailbox token', async () => {
    const change = base();
    change.resolveBearer.mockResolvedValueOnce('old').mockResolvedValueOnce('fresh');
    change.fetch.mockResolvedValueOnce(new Response(null, { status: 401 }));
    await modifyGmailNativeCategories(change);
    expect(change.resolveBearer.mock.calls).toEqual([[false], [true]]);
    expect(change.fetch).toHaveBeenCalledTimes(2);
    expect((change.fetch.mock.calls[1] as unknown as [string, RequestInit])[1].headers).toMatchObject({ Authorization: 'Bearer fresh' });
  });
  it('does not keep refreshing a rejected token', async () => {
    const change = base();
    change.fetch.mockResolvedValue(new Response(null, { status: 401 }));
    await expect(modifyGmailNativeCategories(change)).rejects.toMatchObject({ retryable: false, status: 401 });
    expect(change.fetch).toHaveBeenCalledTimes(2);
  });
  it('rejects app-password native edits without network or local success', async () => {
    const change = base();
    await expect(modifyGmailNativeCategories({ ...change, resolveBearer: undefined })).rejects.toMatchObject({ code: 'GMAIL_CATEGORY_OAUTH_REQUIRED', retryable: false });
    expect(change.fetch).not.toHaveBeenCalled();
  });
  it.each([{ add: ['important'], remove: [] }, { add: ['Promotions'], remove: [] }, { add: ['promotions'], remove: ['promotions'] }])('rejects invalid selection %j before fetching', async (selection) => {
    const change = base();
    await expect(modifyGmailNativeCategories({ ...change, ...selection })).rejects.toMatchObject({ code: 'GMAIL_CATEGORY_INVALID', retryable: false });
    expect(change.fetch).not.toHaveBeenCalled();
  });
  it.each([400, 403, 404, 408, 429, 500, 503])('classifies HTTP %s without reading or exposing response data', async (status) => {
    const change = base();
    const response = new Response('private-mail-content synthetic-token', { status });
    const text = vi.spyOn(response, 'text');
    const json = vi.spyOn(response, 'json');
    change.fetch.mockResolvedValueOnce(response);
    const error = await modifyGmailNativeCategories(change).catch((e) => e);
    const retryable = status === 408 || status === 429 || status >= 500;
    expect(error).toMatchObject({ status, retryable });
    expect(isConnectionError(error)).toBe(retryable);
    expect(error.message).not.toMatch(/private-mail-content|synthetic-token/);
    expect(text).not.toHaveBeenCalled();
    expect(json).not.toHaveBeenCalled();
  });
  it('sanitizes network and token failures instead of retaining raw secret-bearing causes', async () => {
    const change = base();
    change.fetch.mockRejectedValueOnce(new Error('synthetic-token private response'));
    await expect(modifyGmailNativeCategories(change)).rejects.toMatchObject({ code: 'GMAIL_CATEGORY_NETWORK', retryable: true });
    change.resolveBearer.mockRejectedValueOnce(new OAuthError('secret token failure', 'REAUTH_REQUIRED'));
    const error = await modifyGmailNativeCategories(change).catch((e) => e);
    expect(error).toMatchObject({ code: 'GMAIL_CATEGORY_AUTH_REQUIRED', retryable: false });
    expect(error.message).not.toContain('secret');
    expect(error.cause).toBeUndefined();
  });
  it('does not resolve a token or write for an unchanged selection', async () => {
    const change = base();
    await modifyGmailNativeCategories({ ...change, add: [], remove: [] });
    expect(change.resolveBearer).not.toHaveBeenCalled();
    expect(change.fetch).not.toHaveBeenCalled();
  });
  it.each([0, NaN, Infinity, 120001])('rejects invalid deadline %s before resolving credentials', async (timeoutMs) => {
    const change = base();
    await expect(modifyGmailNativeCategories({ ...change, timeoutMs })).rejects.toMatchObject({ code: 'GMAIL_CATEGORY_INVALID', retryable: false });
    expect(change.resolveBearer).not.toHaveBeenCalled();
  });
  it('requires a nonblank token from the owning account', async () => {
    const change = base();
    change.resolveBearer.mockResolvedValueOnce('  ');
    await expect(modifyGmailNativeCategories(change)).rejects.toMatchObject({ code: 'GMAIL_CATEGORY_AUTH_REQUIRED', retryable: false });
    expect(change.fetch).not.toHaveBeenCalled();
  });
  it('retains retryable token outages without exposing resolver details', async () => {
    const change = base();
    change.resolveBearer.mockRejectedValueOnce(new Error('synthetic-token network details'));
    const error = await modifyGmailNativeCategories(change).catch((e) => e);
    expect(error).toMatchObject({ code: 'GMAIL_CATEGORY_TOKEN_UNAVAILABLE', retryable: true });
    expect(isConnectionError(error)).toBe(true);
    expect(error.message).not.toContain('synthetic-token');
    expect(change.fetch).not.toHaveBeenCalled();
  });
  it('uses the runtime fetch when no test transport is supplied', async () => {
    const change = base();
    vi.stubGlobal('fetch', change.fetch);
    try { await modifyGmailNativeCategories({ ...change, fetch: undefined }); }
    finally { vi.unstubAllGlobals(); }
    expect(change.fetch).toHaveBeenCalledOnce();
  });
  it('aborts a hung request at its deadline', async () => {
    vi.useFakeTimers();
    const change = base();
    let signal: AbortSignal | undefined;
    change.fetch.mockImplementation((...args: any[]) => new Promise((_resolve, reject) => {
      signal = args[1].signal;
      signal!.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const assertion = expect(modifyGmailNativeCategories({ ...change, timeoutMs: 20 })).rejects.toMatchObject({ code: 'GMAIL_CATEGORY_TIMEOUT', retryable: true });
    await vi.advanceTimersByTimeAsync(21);
    await assertion;
    expect(signal?.aborted).toBe(true);
  });
  it('bounds a hung token resolver and never writes after late resolution', async () => {
    vi.useFakeTimers();
    const change = base();
    let resolve!: (token: string) => void;
    change.resolveBearer.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const assertion = expect(modifyGmailNativeCategories({ ...change, timeoutMs: 20 })).rejects.toMatchObject({ code: 'GMAIL_CATEGORY_TIMEOUT' });
    await vi.advanceTimersByTimeAsync(21);
    await assertion;
    resolve('late');
    await Promise.resolve();
    expect(change.fetch).not.toHaveBeenCalled();
  });
});
