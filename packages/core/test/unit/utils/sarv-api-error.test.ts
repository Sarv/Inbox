import { describe, expect, it, vi } from 'vitest';

import { parseSarvApiError, SarvApiError } from '../../../src/utils/sarv-api-error';

const response = (body: unknown, status: number, headers?: HeadersInit) =>
  new Response(JSON.stringify(body), { status, headers });

describe('provider-aware AI API errors', () => {
  // Regression: a rejected OpenAI request must not tell users that their email was sent to Sarv.
  it('names OpenAI and extracts its nested error while retaining typed retry metadata', async () => {
    const detail = { error: { message: "Unknown parameter: 'chat_template_kwargs'.", type: 'invalid_request_error' } };
    const error = await parseSarvApiError(response(detail, 400), 'openai');
    expect(error).toBeInstanceOf(SarvApiError);
    expect(error).toMatchObject({ name: 'AIProviderApiError', provider: 'openai', status: 400, code: 'upstream_error', detail });
    expect(error.message).toBe("OpenAI API 400: Unknown parameter: 'chat_template_kwargs'.");
    expect(error.message).not.toContain('Sarv');
  });

  // Regression: Sarv discovery and wallet callers must retain their existing names, messages and recovery codes.
  it('preserves the default Sarv response contract and FastAPI envelope', async () => {
    const error = await parseSarvApiError(response({ detail: { error: 'insufficient_balance', message: 'Top up your wallet' } }, 402));
    expect(error).toMatchObject({ name: 'SarvApiError', provider: 'sarv', status: 402, code: 'insufficient_balance' });
    expect(error.message).toBe('Top up your wallet');
  });

  // Regression: provider labels must survive quota failures without losing Retry-After or retry classification.
  it('labels Gemini direct messages and retains its retry delay', async () => {
    const error = await parseSarvApiError(response({ message: 'Quota exhausted' }, 429, { 'retry-after': '17' }), 'gemini');
    expect(error).toMatchObject({ name: 'AIProviderApiError', provider: 'gemini', code: 'rate_limit_exceeded', retryAfterSec: 17 });
    expect(error.message).toBe('Gemini API 429: Quota exhausted');
  });

  // Regression: proxy HTML must remain diagnostic and bounded, with no claim that a custom server is Sarv.
  it('labels custom failures and truncates an unstructured body', async () => {
    const text = '<html>Bad gateway</html>' + 'x'.repeat(250);
    const error = await parseSarvApiError(new Response(text, { status: 502 }), 'custom');
    expect(error).toMatchObject({ name: 'AIProviderApiError', provider: 'custom', code: 'upstream_error' });
    expect(error.message).toBe(`AI API 502: ${text.slice(0, 200)}`);
  });

  // Regression: empty error responses must expose their provider/status without a dangling colon.
  it.each(['openai', 'gemini', 'custom', 'other'])('handles an empty %s error response', async (provider) => {
    const error = await parseSarvApiError(new Response('', { status: 503 }), provider);
    expect(error.message).toBe(`${provider === 'openai' ? 'OpenAI' : provider === 'gemini' ? 'Gemini' : 'AI'} API 503`);
    expect(error.provider).toBe(provider);
  });

  // Regression: status-based authentication and quota handling must still work without a documented error code.
  it.each([[401, 'invalid_token'], [402, 'insufficient_balance'], [429, 'rate_limit_exceeded'], [500, 'upstream_error']] as const)(
    'classifies status %i without a provider-specific response shape', async (status, code) => {
      const error = await parseSarvApiError(response({ error: 'unknown_code' }, status), 'openai');
      expect(error.code).toBe(code);
      expect(error.name).toBe('AIProviderApiError');
    },
  );

  // Regression: unreadable or malformed error bodies must not replace the HTTP failure with a parsing exception.
  it('handles body read failures, primitive JSON and unusable retry headers', async () => {
    const unreadable = { text: vi.fn().mockRejectedValue(new Error('socket closed')), status: 503, headers: new Headers() } as unknown as Response;
    expect((await parseSarvApiError(unreadable, 'openai')).message).toBe('OpenAI API 503');
    for (const body of [null, 42, 'plain error']) {
      const error = await parseSarvApiError(response(body, 500, { 'retry-after': 'soon' }), 'custom');
      expect(error.code).toBe('upstream_error');
      expect(error.retryAfterSec).toBeUndefined();
    }
    expect((await parseSarvApiError(response({}, 429, { 'retry-after': '0' }))).retryAfterSec).toBeUndefined();
  });

  // Regression: a provider's empty message must not suppress the actual request destination and HTTP status.
  it('handles empty provider messages and default Sarv fallback text', async () => {
    expect((await parseSarvApiError(response({ message: '' }, 400), 'openai')).message).toBe('OpenAI API 400');
    expect((await parseSarvApiError(new Response('', { status: 500 }))).message).toBe('Sarv API 500');
    expect((await parseSarvApiError(new Response('<html>down</html>', { status: 502 }))).message).toBe('Sarv API 502: <html>down</html>');
  });

  // Regression: direct constructors used by Sarv catalog callers must remain compatible with the shared error class.
  it('retains direct-constructor defaults and explicitly identifies non-Sarv providers', () => {
    expect(new SarvApiError('expired', { status: 401, code: 'invalid_token' })).toMatchObject({ name: 'SarvApiError', provider: 'sarv' });
    expect(new SarvApiError('OpenAI failure', { status: 400, code: 'upstream_error', provider: 'openai' })).toMatchObject({ name: 'AIProviderApiError', provider: 'openai' });
  });
});
