// @vitest-environment happy-dom
import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { render } from '../../../helpers/render';

// What breaks if this suite goes red: a reopened draft (Drafts list, or Undo on
// a send) shows its body but Send stays disabled, because the plain-text copy
// that gates Send was never filled in — the user can't send what they wrote.

vi.mock('../../../../src/store/email-store', () => ({
  useEmailStore: () => ({ sendEmail: vi.fn() }),
}));

const { useCompose } = await import('../../../../src/components/useCompose');

type Api = ReturnType<typeof useCompose>;

function Probe({ htmlContent, onApi }: { htmlContent?: string; onApi?: (api: Api) => void }) {
  const api = useCompose({ initialDraft: htmlContent === undefined ? undefined : { htmlContent } });
  onApi?.(api);
  return <span data-plain={api.plainBody} data-html={api.htmlBody} />;
}

const span = (view: ReturnType<typeof render>) => view.container.querySelector('span')!;

describe('useCompose body state', () => {
  // Regression: plainBody started '' for a restored draft → Send disabled.
  it('seeds plainBody from a restored draft body', () => {
    const view = render(<Probe htmlContent="<p>hi</p>" />);
    expect(span(view).getAttribute('data-plain')).toBe('hi');
  });

  // Regression: a brand-new message must still start empty, so Send is
  // disabled until the user writes something.
  it('starts empty with no draft', () => {
    const view = render(<Probe />);
    expect(span(view).getAttribute('data-plain')).toBe('');
  });

  // Regression: an AI rewrite / draft restore that set only the HTML left the
  // Send gate reading the old text.
  it('setBody keeps the HTML and plain text in step', () => {
    let api: Api | undefined;
    const view = render(<Probe onApi={a => { api = a; }} />);
    act(() => api!.setBody('<p>new <em>text</em></p>'));
    expect(span(view).getAttribute('data-html')).toBe('<p>new <em>text</em></p>');
    expect(span(view).getAttribute('data-plain')).toBe('new text');
  });
});
