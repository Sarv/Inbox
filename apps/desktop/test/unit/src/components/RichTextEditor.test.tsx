// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';

import { EMPTY_EDITOR_HTML, RichTextEditor } from '../../../../src/components/RichTextEditor';
import { render, settle } from '../../../helpers/render';

/**
 * The compose body's placeholder.
 *
 * What breaks if this file goes red: a new message opens on a blank, unlabeled
 * body with stray empty lines above the cursor. TipTap only draws the
 * placeholder while the whole document is empty, so any seed body with more
 * than one empty paragraph silently hides it.
 */

let mounted: ReturnType<typeof render> | null = null;

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

const mountEditor = async (content: string) => {
  mounted = render(
    <RichTextEditor content={content} onChange={() => {}} placeholder="Compose your message..." />,
  );
  await settle();
  return mounted;
};

describe('RichTextEditor placeholder', () => {
  // Regression: new-message seed was three empty paragraphs, which hid the placeholder.
  it('shows the placeholder for the empty seed body a new message opens with', async () => {
    const view = await mountEditor(EMPTY_EDITOR_HTML);
    const paragraphs = view.all('.ProseMirror p');
    expect(paragraphs).toHaveLength(1);
    expect(paragraphs[0].classList.contains('is-editor-empty')).toBe(true);
    expect(paragraphs[0].getAttribute('data-placeholder')).toBe('Compose your message...');
  });

  // Guards the other direction: the placeholder must not overlay text the user wrote.
  it('hides the placeholder once the body has content', async () => {
    const view = await mountEditor('<p>Hello</p>');
    expect(view.find('.ProseMirror p.is-editor-empty')).toBeNull();
  });
});
