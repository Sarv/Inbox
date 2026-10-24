import { describe, expect, it, vi } from 'vitest';

const { compile } = vi.hoisted(() => ({ compile: vi.fn() }));

vi.mock('html-to-text', async importOriginal => {
  const actual = await importOriginal<typeof import('html-to-text')>();
  compile.mockImplementation(actual.compile);
  return { ...actual, compile };
});

const { htmlToPlainText } = await import('../../../src/utils/html-text');

describe('htmlToPlainText converter reuse', () => {
  // Regression: `convert()` recompiled html-to-text's selector tree on every
  // body — two thirds of an unread review's time over 2,000 messages, enough to
  // time out CI. Compiling must happen once per option set, not once per mail.
  it('compiles each option set once however many bodies it converts', () => {
    for (let index = 0; index < 50; index += 1) {
      htmlToPlainText(`<p>Message ${index}</p>`);
      htmlToPlainText(`<a href="tel:${index}">call</a>`, { keepLinkHrefs: true });
    }

    expect(compile).toHaveBeenCalledTimes(2);
  });
});
