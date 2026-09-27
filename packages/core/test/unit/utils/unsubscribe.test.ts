import { describe, expect, it } from 'vitest';

import {
  ONE_CLICK_BODY,
  canUnsubscribe,
  declaresOneClick,
  mailtoUnsubscribe,
  parseUnsubscribe,
  preferredRoute,
  resolveUnsubscribeAction,
  unsubscribeEntries,
} from '../../../src/utils/unsubscribe';

// What breaks if this suite goes red: the Unsubscribe button. Every failure
// here is silent in a particular way — the button appears and does nothing, or
// worse, it POSTs to a URL the sender never said was a one-click endpoint,
// which is an unauthenticated write on the reader's behalf.

describe('unsubscribeEntries', () => {
  it('reads a single bracketed URI', () => {
    expect(unsubscribeEntries('<https://brand.example/u>')).toEqual(['https://brand.example/u']);
  });

  it('reads several entries in order', () => {
    expect(unsubscribeEntries('<mailto:u@x.example>, <https://x.example/u>')).toEqual([
      'mailto:u@x.example',
      'https://x.example/u',
    ]);
  });

  // Regression: splitting on ',' first cuts this entry in half and the mailto
  // loses its subject — the very thing some list managers key on.
  it('keeps a comma that belongs to the URI', () => {
    expect(unsubscribeEntries('<mailto:u@x.example?subject=stop,now>')).toEqual([
      'mailto:u@x.example?subject=stop,now',
    ]);
  });

  it('ignores anything outside the brackets', () => {
    expect(unsubscribeEntries('(comment) <https://x.example/u> please')).toEqual(['https://x.example/u']);
  });

  // A header folded across lines arrives with the newline unfolded to a space.
  it('reads a folded header', () => {
    expect(unsubscribeEntries('<mailto:u@x.example>,\r\n <https://x.example/u>')).toHaveLength(2);
  });

  // Partial input must degrade to what IS readable, never throw and never
  // invent an entry from an unterminated bracket.
  it('drops an unterminated entry and keeps the complete ones', () => {
    expect(unsubscribeEntries('<https://x.example/u>, <https://x.example/tru')).toEqual([
      'https://x.example/u',
    ]);
  });

  it('returns nothing for absent, empty or bracket-free values', () => {
    expect(unsubscribeEntries(undefined)).toEqual([]);
    expect(unsubscribeEntries(null)).toEqual([]);
    expect(unsubscribeEntries('')).toEqual([]);
    expect(unsubscribeEntries('https://x.example/u')).toEqual([]);
    expect(unsubscribeEntries('<>')).toEqual([]);
  });
});

describe('declaresOneClick', () => {
  it('recognises the RFC 8058 token', () => {
    expect(declaresOneClick('List-Unsubscribe=One-Click')).toBe(true);
  });

  it('is case- and whitespace-tolerant', () => {
    expect(declaresOneClick('list-unsubscribe = one-click')).toBe(true);
    expect(declaresOneClick('  LIST-UNSUBSCRIBE=ONE-CLICK  ')).toBe(true);
  });

  it('is false for an absent or unrelated value', () => {
    expect(declaresOneClick(undefined)).toBe(false);
    expect(declaresOneClick(null)).toBe(false);
    expect(declaresOneClick('')).toBe(false);
    expect(declaresOneClick('List-Unsubscribe=Whatever')).toBe(false);
  });
});

describe('parseUnsubscribe', () => {
  it('picks the https entry and the mailto entry out of one header', () => {
    const target = parseUnsubscribe('<mailto:u@x.example>, <https://x.example/u>');
    expect(target).toEqual({ httpUrl: 'https://x.example/u', mailtoUri: 'mailto:u@x.example', oneClick: false });
  });

  it('marks one-click when the sender declared it alongside an https entry', () => {
    const target = parseUnsubscribe('<https://x.example/u>', ONE_CLICK_BODY);
    expect(target.oneClick).toBe(true);
  });

  // Regression, and the important one: without the POST header the https entry
  // is a page to OPEN. Posting to it is an unauthenticated write to a URL that
  // never agreed to receive one.
  it('does not mark one-click without the POST header', () => {
    expect(parseUnsubscribe('<https://x.example/u>').oneClick).toBe(false);
  });

  // Regression: a one-click declaration with only a mailto has nothing to POST
  // to. Reporting it as one-click is a button that says "done" having done
  // nothing at all.
  it('does not mark one-click when there is no https entry to post to', () => {
    const target = parseUnsubscribe('<mailto:u@x.example>', ONE_CLICK_BODY);
    expect(target.oneClick).toBe(false);
    expect(target.mailtoUri).toBe('mailto:u@x.example');
  });

  // Regression: an http one-click POST replays the unsubscribe token over a
  // cleartext hop. It degrades to a page the reader opens, never to silence.
  it('refuses one-click over plain http and offers the page instead', () => {
    const target = parseUnsubscribe('<http://x.example/u>', ONE_CLICK_BODY);
    expect(target.oneClick).toBe(false);
    expect(target.httpUrl).toBe('http://x.example/u');
    expect(preferredRoute(target)).toBe('page');
  });

  it('prefers the first entry of each kind', () => {
    const target = parseUnsubscribe('<https://a.example/u>, <https://b.example/u>, <mailto:a@x.example>, <mailto:b@x.example>');
    expect(target.httpUrl).toBe('https://a.example/u');
    expect(target.mailtoUri).toBe('mailto:a@x.example');
  });

  it('ignores a scheme it will not act on', () => {
    const target = parseUnsubscribe('<ftp://x.example/u>, <javascript:alert(1)>');
    expect(target).toEqual({ httpUrl: null, mailtoUri: null, oneClick: false });
  });

  it('reads nothing out of an absent header', () => {
    expect(parseUnsubscribe(null)).toEqual({ httpUrl: null, mailtoUri: null, oneClick: false });
  });
});

describe('canUnsubscribe', () => {
  it('is true when either route exists and false when neither does', () => {
    expect(canUnsubscribe(parseUnsubscribe('<https://x.example/u>'))).toBe(true);
    expect(canUnsubscribe(parseUnsubscribe('<mailto:u@x.example>'))).toBe(true);
    expect(canUnsubscribe(parseUnsubscribe(null))).toBe(false);
  });
});

describe('mailtoUnsubscribe', () => {
  it('uses the conventional subject and body when the URI carries none', () => {
    expect(mailtoUnsubscribe('mailto:u@x.example')).toEqual({
      to: 'u@x.example',
      subject: 'unsubscribe',
      body: 'unsubscribe',
    });
  });

  // Regression: some list managers only act on the subject they asked for.
  // Overriding it sends a mail that is ignored, and the reader stays subscribed.
  it('honours the subject and body the sender asked for', () => {
    expect(mailtoUnsubscribe('mailto:u@x.example?subject=unsub%20abc123&body=go%20away')).toEqual({
      to: 'u@x.example',
      subject: 'unsub abc123',
      body: 'go away',
    });
  });

  it('accepts an upper-case scheme', () => {
    expect(mailtoUnsubscribe('MAILTO:u@x.example')?.to).toBe('u@x.example');
  });

  it('returns null for a missing or address-free URI', () => {
    expect(mailtoUnsubscribe(null)).toBeNull();
    expect(mailtoUnsubscribe('mailto:')).toBeNull();
    expect(mailtoUnsubscribe('mailto:not-an-address')).toBeNull();
  });

  // A percent sequence the decoder rejects is a malformed header, not a reason
  // to throw out of a click handler.
  it('falls back to the raw address when decoding fails', () => {
    expect(mailtoUnsubscribe('mailto:u%ZZ@x.example')?.to).toBe('u%ZZ@x.example');
  });
});


describe('unsubscribe routes', () => {
  const ONE_CLICK_HEADER = '<https://brand.example/u/abc>, <mailto:u@brand.example>';

  // One-click is the only route that finishes without leaving the app, so it
  // outranks the page; the page outranks mailto, which a list manager may take
  // days to act on. A wrong order here is a reader sent to a browser for
  // something the app could have finished.
  it('ranks one-click over a page and a page over mailto', () => {
    expect(preferredRoute(parseUnsubscribe(ONE_CLICK_HEADER, ONE_CLICK_BODY))).toBe('one-click');
    expect(preferredRoute(parseUnsubscribe(ONE_CLICK_HEADER))).toBe('page');
    expect(preferredRoute(parseUnsubscribe('<mailto:u@brand.example>'))).toBe('mailto');
    expect(preferredRoute(parseUnsubscribe(null))).toBe(null);
  });

  it('resolves each route to the address the sender themselves published', () => {
    expect(resolveUnsubscribeAction(ONE_CLICK_HEADER, ONE_CLICK_BODY, 'one-click')).toEqual({
      kind: 'one-click',
      url: 'https://brand.example/u/abc',
      body: ONE_CLICK_BODY,
    });
    expect(resolveUnsubscribeAction(ONE_CLICK_HEADER, null, 'page')).toEqual({
      kind: 'page',
      url: 'https://brand.example/u/abc',
    });
    expect(resolveUnsubscribeAction(ONE_CLICK_HEADER, null, 'mailto')).toEqual({
      kind: 'mailto',
      mail: { to: 'u@brand.example', subject: 'unsubscribe', body: 'unsubscribe' },
    });
  });

  // THE regression this layer exists for: the renderer names a route, never a
  // URL. Asking for one-click on a message that never declared it must resolve
  // to nothing, or the main process makes an unauthenticated write, from the
  // reader's network, to an address a crafted message chose.
  it('refuses a route the message does not offer', () => {
    expect(resolveUnsubscribeAction(ONE_CLICK_HEADER, null, 'one-click')).toBe(null);
    expect(resolveUnsubscribeAction('<mailto:u@brand.example>', ONE_CLICK_BODY, 'page')).toBe(null);
    expect(resolveUnsubscribeAction('<https://brand.example/u>', ONE_CLICK_BODY, 'mailto')).toBe(null);
  });

  // A message with no headers at all — the common case — resolves to nothing
  // for every route rather than throwing on a user action.
  it('resolves to nothing when the message carries no unsubscribe header', () => {
    for (const route of ['one-click', 'page', 'mailto'] as const) {
      expect(resolveUnsubscribeAction(null, null, route)).toBe(null);
      expect(resolveUnsubscribeAction('', '', route)).toBe(null);
    }
  });

  // A mailto whose address will not parse is not a route: sending "unsubscribe"
  // to a malformed recipient bounces, and the reader was told they had left.
  it('refuses a mailto entry with no usable address', () => {
    expect(resolveUnsubscribeAction('<mailto:not-an-address>', null, 'mailto')).toBe(null);
  });
});
