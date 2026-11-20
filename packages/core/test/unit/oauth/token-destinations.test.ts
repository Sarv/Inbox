import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getOAuthProvider,
  setSarvBaseUrl,
} from '../../../src/oauth/providers';
import {
  allowedSarvReputationOrigin,
  describeEndpointOrigin,
  isOAuthMailHostAllowed,
  isSarvAIEndpointAllowed,
  matchReputationOrigin,
  oauthMailHostsFor,
  sarvReputationOrigin,
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

  // Breaks: Sarv AI stops working — every zone has its own edge host, and
  // the LLM API's requests (chat, model list) all live under /edge/v1/llm.
  it('allows the LLM API on every zone edge host', () => {
    expect(isSarvAIEndpointAllowed('https://jpr1-ai-edge.sarv.com/edge/v1/llm')).toBe(true);
    expect(isSarvAIEndpointAllowed('https://blr2-ai-edge.sarv.com/edge/v1/llm/')).toBe(true);
    expect(isSarvAIEndpointAllowed('https://jpr1-ai-edge.sarv.com/edge/v1/llm/chat/completions')).toBe(true);
    expect(isSarvAIEndpointAllowed('https://JPR1-AI-EDGE.sarv.com./edge/v1/llm/models')).toBe(true);
  });

  // Changed deliberately (CASA I-2 review): any https host under sarv.com, on
  // any path, used to be allowed — ai.sarv.com and sarv.com among them. Since
  // the renderer names the URL for the AI proxy, that let a compromised window
  // send the Sarv mailbox token to the website (inbox.sarv.com, served by
  // GitHub Pages) or to any Sarv API route and read the answer. Breaks: the
  // token reaches a sarv.com server or path that is not the LLM API.
  it.each([
    'https://ai.sarv.com',
    'https://ai.sarv.com/oauth/v1/zones',
    'https://SARV.com/x',
    'https://inbox.sarv.com/edge/v1/llm/chat/completions',
    'https://oauth.sarv.com/api/oauth/userinfo',
    'https://jpr1-ai-edge.sarv.com/',
    'https://jpr1-ai-edge.sarv.com/edge/v1/other',
    'https://jpr1-ai-edge.sarv.com/edge/v1/llmx',
    'https://jpr1-ai-edge.sarv.com/edge/v1/llm/../../admin',
    'https://jpr1-ai-edge.sarv.com/edge/v1/llm/%2e%2e/%2e%2e/admin',
    'https://jpr1-ai-edge.sarv.com:8443/edge/v1/llm',
    'https://x.jpr1-ai-edge.sarv.com/edge/v1/llm',
    'https://-ai-edge.sarv.com/edge/v1/llm',
    'https://ai-edge.sarv.com/edge/v1/llm',
    // Breaks: an extra host name in front of the zone label passes (CodeQL
    // js/incomplete-url-substring-sanitization), or the bare domain does.
    'https://evil.example-ai-edge.sarv.com/edge/v1/llm',
    'https://sarv.com/edge/v1/llm',
  ])('refuses the non-LLM sarv.com address %j', (url) => {
    expect(isSarvAIEndpointAllowed(url)).toBe(false);
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
    'https://jpr1-ai-edge.sarv.com.evil.example/edge/v1/llm',
    // On the LLM path, so only the host check stands between these and the
    // token: a domain that merely ends in "sarv.com" is not under sarv.com.
    'https://evilsarv.com/edge/v1/llm',
    'https://jpr1-ai-edgesarv.com/edge/v1/llm',
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
    // The configured origin is held to the LLM path too.
    expect(isSarvAIEndpointAllowed('http://localhost:8787/admin')).toBe(false);
  });

  // Breaks: the API base (ai.sarv.com in production) counts as an AI endpoint
  // again just because it is configured. Main fetches the catalog from it at a
  // fixed address; nothing the renderer names may get the token there.
  it('does not treat the configured API base as an AI endpoint', () => {
    setSarvBaseUrl({ apiBase: 'https://api.example.test' });
    expect(isSarvAIEndpointAllowed('https://api.example.test/edge/v1/llm')).toBe(false);
  });
});

describe('sarvReputationOrigin — a Sarv bearer only goes to Sarv’s reputation service', () => {
  // No build has a reputation origin (Sarv runs no such service yet), so these
  // tests configure one the way a dev build's override does. `.test` never
  // resolves, so the fixture cannot pass for a real service.
  const PRODUCTION = 'https://reputation.sarv.test';
  beforeEach(() => {
    setSarvBaseUrl({ reputationBase: PRODUCTION });
  });
  afterEach(() => {
    // Back to the shipped state: no origin (the AI block's reset leaves this one alone).
    setSarvBaseUrl({ reputationBase: '' });
  });

  // Breaks: the Sarv reputation service stops being asked for a user who typed
  // its address in another legal spelling, or the request goes to the typed
  // spelling rather than the checked origin.
  it.each([
    'https://reputation.sarv.test',
    'https://reputation.sarv.test/',
    'https://REPUTATION.Sarv.test',
    'https://reputation.sarv.test.',
    'https://reputation.sarv.test:443',
    ' https://reputation.sarv.test/ ',
    'https:\\\\reputation.sarv.test',
    'https://reputation%2Esarv.test',
    'https://reputation.sarv.test?',
  ])('allows %j and answers the canonical origin', (url) => {
    expect(sarvReputationOrigin(url)).toBe(PRODUCTION);
  });

  // Breaks (CASA): the Sarv token, which is also the mailbox's XOAUTH2
  // credential, is POSTed to a host that only looks like Sarv's, or to another
  // Sarv API it must not reach.
  it.each([
    'https://reputation.sarv.test.evil.example',
    'https://reputation.sarv.test@evil.example',
    'https://evilsarv.com',
    'https://sarv.com',
    'https://x.reputation.sarv.test',
    'https://reputation.sarv.test..',
    'https://reputation-sarv.com',
    'https://reputat\u0456on.sarv.com', // Cyrillic і: WHATWG makes it xn--reputaton-19h.sarv.com
    'https://xn--reputaton-19h.sarv.com',
    'https://ai.sarv.com',
    'https://oauth.sarv.com',
    'https://jpr1-ai-edge.sarv.com',
  ])('refuses the lookalike or other Sarv host %j', (url) => {
    expect(sarvReputationOrigin(url)).toBeNull();
  });

  // Breaks: the token goes out in the clear, to another service on the same
  // host, with credentials carried in the URL (whose origin equals the allowed
  // one), or to a path that is not the reputation API.
  it.each([
    'http://reputation.sarv.test',
    'https://reputation.sarv.test:8443',
    'https://user:pw@reputation.sarv.test',
    'https://user@reputation.sarv.test',
    'https://:pw@reputation.sarv.test',
    'https://reputation.sarv.test/v1',
    'https://reputation.sarv.test/v1/reputation/lookup',
    'https://reputation.sarv.test/../admin',
    'https://reputation.sarv.test/%2e%2e/admin',
    'https://reputation.sarv.test?x=1',
    'https://reputation.sarv.test#f',
    'ftp://reputation.sarv.test',
    'not a url',
    '',
    '   ',
  ])('refuses the wrong transport or shape %j', (url) => {
    expect(sarvReputationOrigin(url)).toBeNull();
  });

  // Breaks: a value that is not even a string (a hand-edited settings blob)
  // throws on the ingest path, or passes.
  it.each([undefined, null, 42, {}, ['https://reputation.sarv.test'], new URL('https://reputation.sarv.test')])(
    'refuses the non-string %p',
    (value) => {
      expect(sarvReputationOrigin(value)).toBeNull();
    },
  );

  // Breaks: a dev build cannot reach a local reputation service, or the dev
  // override widens into a neighbouring origin (or keeps production allowed).
  it('allows the configured dev origin exactly and nothing near it', () => {
    setSarvBaseUrl({ reputationBase: 'http://localhost:8787' });
    expect(allowedSarvReputationOrigin()).toBe('http://localhost:8787');
    expect(sarvReputationOrigin('http://localhost:8787')).toBe('http://localhost:8787');
    expect(sarvReputationOrigin('http://LOCALHOST:8787/')).toBe('http://localhost:8787');
    expect(sarvReputationOrigin('http://localhost:8788')).toBeNull();
    expect(sarvReputationOrigin('http://127.0.0.1:8787')).toBeNull();
    expect(sarvReputationOrigin('https://localhost:8787')).toBeNull();
    expect(sarvReputationOrigin(PRODUCTION)).toBeNull();
  });

  // Breaks: a malformed configured base (a path, credentials, another scheme)
  // matches something, or the settings screen names it as Sarv's address.
  it.each([
    'http://localhost:8787/rep',
    'http://user:pw@localhost:8787',
    'file:///tmp/rep',
    'not a url',
  ])('allows nothing when the configured base %j is not a bare origin', (base) => {
    setSarvBaseUrl({ reputationBase: base });
    expect(allowedSarvReputationOrigin()).toBeNull();
    expect(sarvReputationOrigin(base)).toBeNull();
    expect(sarvReputationOrigin('http://localhost:8787')).toBeNull();
  });

  // Breaks: a build sends the Sarv bearer to a reputation address while Sarv
  // runs no such service, whatever the settings name (the made-up default this
  // replaced had no DNS record, so anyone who registered it got the token).
  it('allows nothing once no origin is configured, which is how every build ships', () => {
    setSarvBaseUrl({ reputationBase: '' });
    expect(allowedSarvReputationOrigin()).toBeNull();
    expect(sarvReputationOrigin(PRODUCTION)).toBeNull();
    expect(sarvReputationOrigin('https://reputation.sarv.com')).toBeNull();
    expect(sarvReputationOrigin('')).toBeNull();
  });
});

describe('matchReputationOrigin — the same rule against an origin main reported', () => {
  const REPORTED = 'https://rep.dev.example';

  // Breaks: the Blocklists tab warns about the right address in another legal
  // spelling, or calls a lookalike Sarv's (main would refuse it, so the user
  // would believe blocklists are on while nothing is asked).
  it('accepts the reported origin in any legal spelling and answers it canonically', () => {
    for (const url of [REPORTED, 'https://REP.dev.example/', ' https://rep.dev.example.:443 ']) {
      expect(matchReputationOrigin(url, REPORTED)).toBe(REPORTED);
    }
  });

  it.each([
    'https://rep.dev.example.evil.example',
    'https://x.rep.dev.example',
    'http://rep.dev.example',
    'https://rep.dev.example:8443',
    'https://user:pw@rep.dev.example',
    'https://rep.dev.example/v1',
  ])('refuses %j', (url) => {
    expect(matchReputationOrigin(url, REPORTED)).toBeNull();
  });

  // Breaks: with no origin reported (the shipped state, or main could not be
  // asked) the tab treats some typed address as Sarv's.
  it.each([null, undefined, '', 'not a url', 'https://rep.dev.example/path', 42])(
    'allows nothing when the reported origin is %j',
    (allowed) => {
      expect(matchReputationOrigin(REPORTED, allowed)).toBeNull();
    },
  );

  it('refuses a typed value that is not a string', () => {
    expect(matchReputationOrigin(42, REPORTED)).toBeNull();
    expect(matchReputationOrigin(new URL(REPORTED), REPORTED)).toBeNull();
  });
});

describe('describeEndpointOrigin — a refused destination in a log line', () => {
  // Breaks: app.log records credentials typed into the URL, the path or query
  // (which may carry anything), or a forged line from a raw value.
  it('keeps the origin and drops credentials, path, query and fragment', () => {
    expect(describeEndpointOrigin('https://user:secret@evil.example:8443/a/b?token=x#f')).toBe('https://evil.example:8443');
    expect(describeEndpointOrigin(' https://Evil.Example/ ')).toBe('https://evil.example');
  });

  // Breaks: a missing or garbled address is logged raw, or throws.
  it('names a missing or unparseable value without quoting it', () => {
    expect(describeEndpointOrigin(undefined)).toBe('(none)');
    expect(describeEndpointOrigin('  ')).toBe('(none)');
    expect(describeEndpointOrigin(42)).toBe('(none)');
    expect(describeEndpointOrigin('not a url\nFAKE LOG LINE')).toBe('(not a URL)');
  });
});
