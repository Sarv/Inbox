import { describe, expect, it } from 'vitest';

import {
  AI_ENDPOINT_REFUSALS,
  aiEndpointHost,
  aiEndpointOrigin,
  checkAIEndpoint,
  isLoopbackHost,
} from '../../../src/utils';

// The one transport rule for AI provider addresses (CASA audit I-7): HTTPS to
// any host, plain HTTP only to this computer, never credentials in the URL.
// The renderer's endpoint field, main's stored-key binding and proxy, and the
// background categorizers all ask this helper, so a hole here is a hole in all
// of them: mail text and API keys sent unencrypted across a network.

describe('isLoopbackHost', () => {
  // Breaks: a local model server (Ollama, LM Studio) stops working over http.
  it.each(['localhost', '127.0.0.1', '[::1]', '::1', 'LOCALHOST'])('accepts %s', (host) => {
    expect(isLoopbackHost(host)).toBe(true);
  });

  // Breaks: a lookalike host or a LAN address counts as "this computer" and
  // gets plain-HTTP traffic. Matching must be exact, never prefix/suffix.
  it.each([
    'localhost.evil.com', 'evil-localhost', '127.0.0.1.nip.io', '127.0.0.2', '10.0.0.5',
    '192.168.1.10', '[::2]', '0.0.0.0', '', 'local',
  ])('refuses %s', (host) => {
    expect(isLoopbackHost(host)).toBe(false);
  });

  // Breaks: a missing hostname throws instead of reading as "not loopback".
  it('is false for a missing value', () => {
    expect(isLoopbackHost(undefined)).toBe(false);
    expect(isLoopbackHost(null)).toBe(false);
  });
});

describe('checkAIEndpoint', () => {
  // Breaks: a valid provider is refused — HTTPS anywhere, HTTP to this computer.
  it.each([
    ['https://api.openai.com/v1', 'https://api.openai.com'],
    ['https://models.example:8443/v1/', 'https://models.example:8443'],
    ['http://localhost:11434/v1', 'http://localhost:11434'],
    ['http://127.0.0.1:1234/v1', 'http://127.0.0.1:1234'],
    ['http://[::1]:8080/v1', 'http://[::1]:8080'],
    // The URL parser canonicalises these spellings to 127.0.0.1 itself.
    ['http://127.1:9091/edge/v1/llm', 'http://127.0.0.1:9091'],
    ['  https://api.openai.com/v1  ', 'https://api.openai.com'],
  ])('accepts %s', (url, origin) => {
    const check = checkAIEndpoint(url);
    expect(check).toMatchObject({ ok: true, origin });
  });

  // THE finding. Breaks: mail and keys go to another computer unencrypted.
  it.each([
    'http://api.openai.com/v1',
    'http://192.168.1.20:11434/v1',
    'http://10.0.0.5/v1',
    'http://localhost.evil.com/v1',
    'http://127.0.0.1.nip.io/v1',
    'http://evil.example/localhost',
    'ftp://models.example/v1',
    'file:///models',
    'ws://localhost:11434',
  ])('refuses %s as insecure', (url) => {
    expect(checkAIEndpoint(url)).toEqual({ ok: false, reason: 'insecure', message: AI_ENDPOINT_REFUSALS.insecure });
  });

  // Breaks: a URL that smuggles a password (or names localhost as the user
  // part to look local) is accepted.
  it.each([
    'https://user:secret@api.example/v1',
    'https://token@api.example/v1',
    'http://user:secret@localhost:11434/v1',
  ])('refuses %s for carrying credentials', (url) => {
    expect(checkAIEndpoint(url)).toMatchObject({ ok: false, reason: 'credentials' });
  });

  // `http://localhost@evil.com` is evil.com with a username — remote, so refused.
  it('reads a userinfo "localhost" as the remote host it is', () => {
    expect(checkAIEndpoint('http://localhost@evil.com/v1')).toMatchObject({ ok: false, reason: 'insecure' });
  });

  // Breaks: an empty or garbage address throws or reads as allowed.
  it.each([undefined, null, '', '   ', 'not a url', 'api.openai.com/v1'])('refuses %s as invalid', (url) => {
    expect(checkAIEndpoint(url as string | undefined | null)).toMatchObject({ ok: false, reason: 'invalid' });
  });

  // The user-facing wording main surfaces when it refuses a provider.
  it('says HTTPS is required in the insecure message', () => {
    expect(AI_ENDPOINT_REFUSALS.insecure).toMatch(/^AI provider address must use HTTPS/);
  });
});

describe('aiEndpointOrigin', () => {
  // Breaks: the stored-key binding and main's proxy stop working for a valid endpoint.
  it('returns the origin of an endpoint main may call', () => {
    expect(aiEndpointOrigin('https://api.openai.com/v1/chat/completions')).toBe('https://api.openai.com');
    expect(aiEndpointOrigin('http://localhost:11434/v1/models')).toBe('http://localhost:11434');
  });

  // Breaks: main's proxy attaches a saved key to a plain-HTTP request to another
  // computer (it refuses on null), or the key binds to such an origin.
  it('is null for plain HTTP to another computer, credentials, or a non-URL', () => {
    expect(aiEndpointOrigin('http://api.openai.com/v1')).toBeNull();
    expect(aiEndpointOrigin('http://localhost.evil.com/v1')).toBeNull();
    expect(aiEndpointOrigin('https://user:pw@api.openai.com/v1')).toBeNull();
    expect(aiEndpointOrigin('file:///etc/passwd')).toBeNull();
    expect(aiEndpointOrigin(undefined)).toBeNull();
    expect(aiEndpointOrigin('')).toBeNull();
  });
});

describe('aiEndpointHost', () => {
  // Breaks: the consent text (custom provider) or main's refusal log names the
  // wrong server, or throws on an address it cannot parse.
  it('gives host[:port] of any parseable address, allowed or not, and null otherwise', () => {
    expect(aiEndpointHost('https://llm.example.net:8443/v1')).toBe('llm.example.net:8443');
    expect(aiEndpointHost('http://models.lan.example/v1')).toBe('models.lan.example');
    expect(aiEndpointHost(' https://user:pw@api.example/v1 ')).toBe('api.example');
    expect(aiEndpointHost('not a url')).toBeNull();
    expect(aiEndpointHost('file:///models')).toBeNull();
    expect(aiEndpointHost(undefined)).toBeNull();
  });
});
