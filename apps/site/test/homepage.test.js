// @vitest-environment happy-dom
// inbox.sarv.com is the homepage Google's OAuth reviewers check before they
// verify the Gmail scope. Breaks if: the page stops describing the app or its
// Google data use without JavaScript, drops the Limited Use sentence, or links a
// privacy policy URL other than the one on the consent screen.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CONSENT_SCREEN } from './consent-screen.js';

const siteDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const page = new DOMParser().parseFromString(
  readFileSync(path.join(siteDir, 'index.html'), 'utf8'),
  'text/html'
);

/** Every link under `root`, resolved the way a browser on the live site would. */
const hrefs = (root) =>
  [...root.querySelectorAll('a[href]')].map(
    (a) => new URL(a.getAttribute('href'), CONSENT_SCREEN.homepage).href
  );
const about = () => page.querySelector('section.about');
const text = (node) => node.textContent.replace(/\s+/g, ' ').trim();

describe('the homepage (index.html)', () => {
  // Breaks if the redesign removes the product story from the static homepage.
  it('shows the product, its features and the download area without JavaScript', () => {
    expect([...page.querySelectorAll('h1')].map(text)).toEqual([
      'Email, without the email clutter.',
    ]);
    expect(page.querySelector('[data-product-image]')).not.toBeNull();
    expect(page.querySelectorAll('#features .feature-card')).toHaveLength(5);
    expect([...page.querySelectorAll('#ai .ai-card h3')].map(text)).toEqual([
      'Catch up in seconds',
      'Start with a useful draft',
      'Let the inbox organize itself',
    ]);
    expect(page.getElementById('download')).not.toBeNull();
    expect(hrefs(page.getElementById('app'))).toContain(
      'https://github.com/Sarv/Inbox/releases/latest'
    );
  });

  it('ships the conversation demo with a still image for reduced motion', () => {
    const demo = page.querySelector('.conversation-window picture');
    expect(demo.querySelector('img').getAttribute('src')).toBe('./media/thread-to-chat.gif');
    expect(demo.querySelector('source').getAttribute('media')).toBe(
      '(prefers-reduced-motion: reduce)'
    );
    expect(demo.querySelector('source').getAttribute('srcset')).toBe('./media/before-after.png');
    for (const file of ['thread-to-chat.gif', 'before-after.png', 'email-chat-view-LICENSE.txt']) {
      expect(readFileSync(path.join(siteDir, 'public/media', file)).length).toBeGreaterThan(0);
    }
  });

  // Breaks if GitHub Pages stops serving the domain used by the OAuth consent screen.
  it('keeps the GitHub Pages custom domain aligned with the consent screen', () => {
    expect(readFileSync(path.join(siteDir, 'public/CNAME'), 'utf8').trim()).toBe(
      new URL(CONSENT_SCREEN.homepage).host
    );
  });

  // Google rejects a homepage whose privacy link differs from the consent screen's.
  it('links the privacy policy and terms at the consent-screen URLs', () => {
    expect(hrefs(page.querySelector('footer'))).toEqual(
      expect.arrayContaining([CONSENT_SCREEN.privacyPolicy, CONSENT_SCREEN.terms])
    );
  });

  // The download view replaces #app, and a reviewer's crawler may not run
  // scripts: the description must be static HTML outside it.
  it('describes the app and its Google data use outside the scripted download area', () => {
    expect(about()).not.toBeNull();
    expect(page.getElementById('app').contains(about())).toBe(false);
    expect([...about().querySelectorAll('h2')].map(text)).toEqual([
      'What Sarv Inbox does',
      'How Sarv Inbox uses your Google data',
    ]);
    expect(text(about())).toContain('https://mail.google.com/');
  });

  // Google requires this sentence word for word, next to the policy it cites.
  it('keeps the Limited Use statement and links the policies it relies on', () => {
    expect(text(about())).toContain(
      "Sarv Inbox's use and transfer of information received from Google APIs to any other app will adhere to " +
        'the Google API Services User Data Policy, including the Limited Use requirements.'
    );
    expect(hrefs(about())).toEqual(
      expect.arrayContaining([
        'https://developers.google.com/terms/api-services-user-data-policy',
        CONSENT_SCREEN.privacyPolicy,
      ])
    );
  });
});
