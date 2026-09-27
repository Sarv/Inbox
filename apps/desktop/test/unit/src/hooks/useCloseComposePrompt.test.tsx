// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';

import {
  CLOSE_COMPOSE_PROMPT,
  closeOutcomeOf,
  useCloseComposePrompt,
} from '../../../../src/hooks/useCloseComposePrompt';
import type { CloseAction } from '../../../../src/hooks/useDraftAutosave';
import { act, fire, render } from '../../../helpers/render';

// What breaks if this suite goes red: pressing X on a compose box either
// throws the mail away without asking, or saves when the user said Discard —
// the mail silently fails to reach Drafts, or a discarded one keeps coming back.

type Api = ReturnType<typeof useCloseComposePrompt>;

function Probe({ action, onSave, onDiscard, onApi }: {
  action: CloseAction; onSave: () => void; onDiscard: () => void; onApi: (api: Api) => void;
}) {
  const api = useCloseComposePrompt({ closeAction: () => action, onSave, onDiscard });
  onApi(api);
  return <>{api.closePromptDialog}</>;
}

const mount = (action: CloseAction) => {
  const onSave = vi.fn();
  const onDiscard = vi.fn();
  let api!: Api;
  const view = render(<Probe action={action} onSave={onSave} onDiscard={onDiscard} onApi={a => { api = a; }} />);
  let closing!: Promise<void>;
  const close = () => act(() => { closing = api.requestClose(); });
  const settle = () => act(async () => { await closing; });
  const button = (label: string) =>
    [...view.container.querySelectorAll('button')].find(b => b.textContent === label) ?? null;
  return { view, onSave, onDiscard, close, settle, button, api: () => api };
};

describe('closeOutcomeOf', () => {
  // Breaks: the buttons would do each other's job.
  it('maps the dialog buttons to save / discard / stay', () => {
    expect(closeOutcomeOf('confirm')).toBe('save');
    expect(closeOutcomeOf('secondary')).toBe('discard');
    expect(closeOutcomeOf('cancel')).toBe('stay');
  });

  // Breaks: Enter (the dialog's primary) would destroy mail instead of keeping it.
  it('makes Save the safe, non-destructive default', () => {
    expect(CLOSE_COMPOSE_PROMPT.confirmLabel).toBe('Save draft');
    expect(CLOSE_COMPOSE_PROMPT.destructive).toBe(false);
  });
});

describe('useCloseComposePrompt', () => {
  // Breaks: THE report — X with work in the box closed without a word.
  it('asks, and Save draft closes keeping the mail', async () => {
    const t = mount('ask');
    t.close();
    expect(t.view.container.textContent).toContain('Save this draft?');
    expect(t.onSave).not.toHaveBeenCalled();
    act(() => t.button('Save draft')!.click());
    await t.settle();
    expect(t.onSave).toHaveBeenCalledTimes(1);
    expect(t.onDiscard).not.toHaveBeenCalled();
  });

  // Breaks: choosing Discard would leave the mail in Drafts.
  it('Discard throws the mail away', async () => {
    const t = mount('ask');
    t.close();
    act(() => t.button('Discard')!.click());
    await t.settle();
    expect(t.onDiscard).toHaveBeenCalledTimes(1);
    expect(t.onSave).not.toHaveBeenCalled();
  });

  // Breaks: an X pressed by mistake would close the compose either way.
  it('Keep editing and Escape close the question, not the compose', async () => {
    const t = mount('ask');
    t.close();
    act(() => t.button('Keep editing')!.click());
    await t.settle();
    t.close();
    fire(document.body, 'keydown', { key: 'Escape' });
    await t.settle();
    expect(t.onSave).not.toHaveBeenCalled();
    expect(t.onDiscard).not.toHaveBeenCalled();
    expect(t.view.container.textContent).not.toContain('Save this draft?');
  });

  // Breaks: the composer's own Escape handler would fire a second close under
  // the open question (and Cmd+Enter could send behind it).
  it('reports that it is asking, and ignores a second close meanwhile', async () => {
    const t = mount('ask');
    t.close();
    expect(t.api().isAsking()).toBe(true);
    await act(async () => { await t.api().requestClose(); });
    act(() => t.button('Save draft')!.click());
    await t.settle();
    expect(t.onSave).toHaveBeenCalledTimes(1);
    expect(t.api().isAsking()).toBe(false);
  });

  // Breaks: an empty compose would nag instead of just going away.
  it('discards without asking when there is nothing to keep', async () => {
    const t = mount('discard');
    t.close();
    await t.settle();
    expect(t.onDiscard).toHaveBeenCalledTimes(1);
    expect(t.view.container.textContent).not.toContain('Save this draft?');
  });

  // Breaks: an opened, untouched draft would nag — or be discarded.
  it('closes an untouched draft without asking, keeping it', async () => {
    const t = mount('keep');
    t.close();
    await t.settle();
    expect(t.onSave).toHaveBeenCalledTimes(1);
    expect(t.onDiscard).not.toHaveBeenCalled();
  });
});
