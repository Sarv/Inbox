import { describe, expect, it } from 'vitest';

import { LINK_DOMAINS_MAX, extractLinkDomains } from '../../../src/utils/link-domains';

/**
 * The domains a message links to — what the spam filter's body stage looks up.
 *
 * What this protects: a phish links to its site rather than sending from it,
 * so missing the href behind an innocent anchor text misses the phish; and a
 * blast with a thousand links must cost a bounded number of lookups. Parsed,
 * not pattern-matched, so a split or oddly quoted href still counts.
 */
describe('extractLinkDomains', () => {
  it('reduces anchor hrefs to registrable domains, in document order, deduplicated', () => {
    const html = `<p>Hi <a href="https://mail.paypal.com/x">PayPal</a>,
      <a href='http://cdn.paypal.com/img'>again</a> and <a href="https://evil.ru/login?x=1">click</a>
      <a href="mailto:a@b.c">mail</a> <a href="#top">top</a> <a href="javascript:alert(1)">js</a></p>`;
    expect(extractLinkDomains(html)).toEqual(['paypal.com', 'evil.ru']);
  });

  it('reads <area> and <form action> targets too', () => {
    expect(extractLinkDomains('<map><area href="https://a.example/"></map><form action="https://b.example/login"></form>')).toEqual(['a.example', 'b.example']);
  });

  // The href is what matters, however the text reads and however it is quoted.
  it('survives entity-split and oddly quoted hrefs', () => {
    expect(extractLinkDomains('<a href="https://evil.example/a&amp;b">paypal.com</a>')).toEqual(['evil.example']);
    expect(extractLinkDomains('<a href=https://bare.example/path>x</a>')).toEqual(['bare.example']);
  });

  it('finds URLs in a plain-text body', () => {
    expect(extractLinkDomains('See https://docs.example.org/guide and http://tracker.example/x?y=1 today.')).toEqual(['example.org', 'tracker.example']);
  });

  it('skips the excluded (sender) domain and caps the count', () => {
    const many = Array.from({ length: LINK_DOMAINS_MAX + 5 }, (_, i) => `<a href="https://d${i}.example/">l</a>`).join('');
    expect(extractLinkDomains(many)).toHaveLength(LINK_DOMAINS_MAX);
    expect(extractLinkDomains('<a href="https://news.brand.example/a">a</a><a href="https://other.example/b">b</a>', { exclude: ['brand.example'] })).toEqual(['other.example']);
    expect(extractLinkDomains('<a href="https://x.example/">x</a>', { max: 0 })).toEqual([]);
  });

  it('returns nothing for an empty or link-free body, or hosts with no registrable domain', () => {
    expect(extractLinkDomains(null)).toEqual([]);
    expect(extractLinkDomains('   ')).toEqual([]);
    expect(extractLinkDomains('<p>no links</p>')).toEqual([]);
    expect(extractLinkDomains('<a href="https://localhost/x">l</a><a href="https://10.0.0.1/">ip</a>')).toEqual([]);
  });
});
