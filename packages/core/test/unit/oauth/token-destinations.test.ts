import { afterEach, describe, expect, it } from 'vitest';

import {
  getOAuthProvider,
  setSarvBaseUrl,
} from '../../../src/oauth/providers';
import {
  isOAuthMailHostAllowed,
  isSarvAIEndpointAllowed,
  oauthMailHostsFor,
} from '../../../src/oauth/token-destinations';

// Where main may send an OAuth bearer. The host / baseUrl arrives from the
// renderer, which also renders untrusted email HTML — if any of these pass a
// host that is not the provider's own, a compromised renderer walks off with
// the user's Gmail (restricted-scope) token. This is the control the CASA
// reviewer checks first.

describe('isOAuthMailHostAllowed — a mail bearer only goes to its own provider', () => {
  // Breaks: real accounts stop connecting the day the guard ships.
  it.each([
    ['gmail', 'imap', 'imap.gmail.com'],
    ['gmail', 'smtp', 'smtp.gmail.com'],
    ['gmail', 'imap', 'imap.googlemail.com'],
    ['gmail', 'smtp', 'smtp.googlemail.com'],
    ['microsoft', 'imap', 'outlook.office365.com'],
    ['microsoft', 'smtp', 'smtp.office365.com'],
    ['microsoft', 'imap', 'imap-mail.outlook.com'],
    ['microsoft', 'smtp', 'smtp-mail.outlook.com'],
    ['yahoo', 'imap', 'imap.mail.yahoo.com'],
    ['yahoo', 'smtp', 'smtp.mail.yahoo.com'],
    ['sarv', 'imap', 'imap.sarv.com'],
    ['sarv', 'smtp', 'smtp.sarv.com'],
  ] as const)('allows %s over %s to %s', (provider, protocol, host) => {
    expect(isOAuthMailHostAllowed(provider, protocol, host)).toBe(true);
  });

  // Breaks: a stored host typed in capitals or as an FQDN with the root dot is
  // refused, and that account silently stops syncing.
  it('normalises case, surrounding space and one trailing root dot', () => {
    expect(isOAuthMailHostAllowed('gmail', 'imap', 'IMAP.Gmail.COM')).toBe(true);
    expect(isOAuthMailHostAllowed('gmail', 'imap', '  imap.gmail.com  ')).toBe(true);
    expect(isOAuthMailHostAllowed('gmail', 'imap', 'imap.gmail.com.')).toBe(true);
  });

  // Breaks: THE leak — a renderer-chosen server receives the Gmail token.
  it.each([
    'evil.example',
    'imap.gmail.com.evil.example',
    'evilimap.gmail.com',
    'evil.example/imap.gmail.com',
    'imap.gmail.com:993',
    'imap.gmail.com..',
    'gmail.com',
    '127.0.0.1',
    '',
    '   ',
  ])('refuses a gmail bearer for %j', (host) => {
    expect(isOAuthMailHostAllowed('gmail', 'imap', host)).toBe(false);
  });

  // Breaks: one provider's token is accepted for ANOTHER provider's server
  // (it would be presented to, and logged by, a third party).
  it('refuses cross-provider hosts', () => {
    expect(isOAuthMailHostAllowed('gmail', 'imap', 'outlook.office365.com')).toBe(false);
    expect(isOAuthMailHostAllowed('microsoft', 'smtp', 'smtp.gmail.com')).toBe(false);
    expect(isOAuthMailHostAllowed('sarv', 'imap', 'imap.gmail.com')).toBe(false);
    // Yahoo used to inherit Gmail's hosts from the template it is spread from.
    expect(isOAuthMailHostAllowed('yahoo', 'imap', 'imap.gmail.com')).toBe(false);
    expect(isOAuthMailHostAllowed('yahoo', 'smtp', 'smtp.gmail.com')).toBe(false);
  });

  // Breaks: an SMTP host is accepted for IMAP (or vice versa), widening the set.
  it('keeps IMAP and SMTP host sets apart', () => {
    expect(isOAuthMailHostAllowed('gmail', 'imap', 'smtp.gmail.com')).toBe(false);
    expect(isOAuthMailHostAllowed('gmail', 'smtp', 'imap.gmail.com')).toBe(false);
  });

  // Breaks: a missing host or a bogus provider id (including inherited object
  // keys) resolves to SOME host list and lets a token through.
  it('refuses missing hosts and unknown or inherited provider ids', () => {
    expect(isOAuthMailHostAllowed('gmail', 'imap', undefined)).toBe(false);
    expect(isOAuthMailHostAllowed('gmail', 'imap', null)).toBe(false);
    for (const id of ['google', 'GMAIL', '__proto__', 'constructor', 'toString', '']) {
      expect(isOAuthMailHostAllowed(id, 'imap', 'imap.gmail.com')).toBe(false);
      expect(oauthMailHostsFor(id, 'smtp')).toEqual([]);
    }
  });

  // Breaks: the list drifts from the provider registry the sign-in flow hands
  // the renderer — a freshly signed-in account would then be refused.
  it('always includes the registry host the OAuth flow returns', () => {
    for (const id of ['gmail', 'microsoft', 'yahoo', 'sarv'] as const) {
      const p = getOAuthProvider(id);
      expect(oauthMailHostsFor(id, 'imap')).toContain(p.imap!.host);
      expect(oauthMailHostsFor(id, 'smtp')).toContain(p.smtp!.host);
    }
  });
});

describe('isSarvAIEndpointAllowed — a Sarv bearer only goes to Sarv AI', () => {
  afterEach(() => {
    // Back to the production defaults.
    setSarvBaseUrl({
      oauthBase: 'https://oauth.sarv.com',
      apiBase: 'https://ai.sarv.com',
      edgeBase: 'https://jpr1-ai-edge.sarv.com',
    });
  });

  // Breaks: Sarv AI stops working — every zone has its own edge host.
  it('allows https hosts under sarv.com, including per-zone edge hosts', () => {
    expect(isSarvAIEndpointAllowed('https://jpr1-ai-edge.sarv.com/edge/v1/llm')).toBe(true);
    expect(isSarvAIEndpointAllowed('https://blr2-ai-edge.sarv.com/edge/v1/llm')).toBe(true);
    expect(isSarvAIEndpointAllowed('https://ai.sarv.com')).toBe(true);
    expect(isSarvAIEndpointAllowed('https://SARV.com/x')).toBe(true);
  });

  // Breaks: the Sarv token (and its email:* mailbox scopes) is POSTed to a
  // renderer-chosen server.
  it.each([
    'https://api.openai.com/v1',
    'https://sarv.com.evil.example/v1',
    'https://evilsarv.com/v1',
    'http://jpr1-ai-edge.sarv.com/edge/v1/llm',
    'https://user:pw@jpr1-ai-edge.sarv.com/edge/v1/llm',
    'https://jpr1-ai-edge.sarv.com@evil.example/v1',
    'not a url',
    '',
  ])('refuses %j', (url) => {
    expect(isSarvAIEndpointAllowed(url)).toBe(false);
  });

  // Breaks: a missing baseUrl falls through to the OpenAI default with a Sarv token.
  it('refuses a missing URL', () => {
    expect(isSarvAIEndpointAllowed(undefined)).toBe(false);
    expect(isSarvAIEndpointAllowed(null)).toBe(false);
  });

  // Breaks: Sarv AI against a local dev stack can't authenticate at all.
  it('allows the exact origin of a configured dev base URL, and nothing else on that host', () => {
    expect(isSarvAIEndpointAllowed('http://localhost:8787/edge/v1/llm')).toBe(false);
    setSarvBaseUrl({ edgeBase: 'http://localhost:8787' });
    expect(isSarvAIEndpointAllowed('http://localhost:8787/edge/v1/llm')).toBe(true);
    expect(isSarvAIEndpointAllowed('http://localhost:9999/edge/v1/llm')).toBe(false);
  });
});
