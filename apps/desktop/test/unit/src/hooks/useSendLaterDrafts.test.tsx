// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';

import {
  EMPTY_SEND_LATER_DRAFT,
  useSendLaterDraft,
  useSendLaterDrafts,
  type SendLaterDraft,
} from '../../../../src/hooks/useSendLaterDrafts';
import { fire, render } from '../../../helpers/render';

// What breaks if this suite goes red: a delivery time typed into one Send-later
// menu turning up in another's fields, or being wiped by it. Both are silent —
// the menu looks fine, and the message goes out at a time nobody chose for it.

/** Renders one owner's draft as text and edits it on click. */
function Owner({ owner, patch }: { owner: string; patch: Partial<SendLaterDraft> }) {
  const { draftFor, updateDraft } = useSendLaterDrafts();
  return (
    <>
      <button aria-label={`edit ${owner}`} onClick={() => updateDraft(owner, patch)} />
      <span data-owner="a">{JSON.stringify(draftFor('a'))}</span>
      <span data-owner="b">{JSON.stringify(draftFor('b'))}</span>
    </>
  );
}

function SoleOwner() {
  const { draft, update } = useSendLaterDraft();
  return (
    <>
      <button aria-label="set date" onClick={() => update({ date: '2026-09-28' })} />
      <button aria-label="set time" onClick={() => update({ time: '18:30' })} />
      <span data-owner="sole">{JSON.stringify(draft)}</span>
    </>
  );
}

const read = (view: ReturnType<typeof render>, owner: string): SendLaterDraft =>
  JSON.parse(view.find(`[data-owner="${owner}"]`)?.textContent ?? 'null');

afterEach(() => {
  document.body.innerHTML = '';
});

describe('useSendLaterDrafts', () => {
  it('reads an untouched owner as an empty draft rather than undefined', () => {
    const view = render(<Owner owner="a" patch={{}} />);
    expect(read(view, 'a')).toEqual(EMPTY_SEND_LATER_DRAFT);
    view.unmount();
  });

  it('merges a patch into one owner, leaving its other fields intact', () => {
    const view = render(<Owner owner="a" patch={{ date: '2026-09-28' }} />);
    fire(view.byLabel('edit a'), 'click');

    expect(read(view, 'a')).toEqual({ showCustom: false, date: '2026-09-28', time: '' });
    view.unmount();
  });

  // Regression: two composers open at once. Writing one owner's draft must not
  // touch another's — the bug this guards is a delivery time appearing in a
  // composer it was never typed into.
  it('never lets one owner write over another', () => {
    const view = render(<Owner owner="a" patch={{ date: '2026-09-28', showCustom: true }} />);
    fire(view.byLabel('edit a'), 'click');

    expect(read(view, 'b')).toEqual(EMPTY_SEND_LATER_DRAFT);
    view.unmount();
  });
});

describe('useSendLaterDraft', () => {
  it('accumulates patches for its single owner', () => {
    const view = render(<SoleOwner />);
    fire(view.byLabel('set date'), 'click');
    fire(view.byLabel('set time'), 'click');

    expect(read(view, 'sole')).toEqual({ showCustom: false, date: '2026-09-28', time: '18:30' });
    view.unmount();
  });

  // Each mount is its own store: two toolbars, two drafts, no shared module state.
  it('gives every mount its own draft', () => {
    const first = render(<SoleOwner />);
    fire(first.byLabel('set date'), 'click');
    const second = render(<SoleOwner />);

    const drafts = second.all('[data-owner="sole"]').map((node) => JSON.parse(node.textContent ?? 'null'));
    expect(drafts).toEqual([
      { showCustom: false, date: '2026-09-28', time: '' },
      EMPTY_SEND_LATER_DRAFT,
    ]);
    first.unmount();
    second.unmount();
  });
});
