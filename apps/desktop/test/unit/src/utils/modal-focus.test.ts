// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { dialogControls, trapDialogTab } from '../../../../src/utils/modal-focus';

afterEach(() => { document.body.innerHTML = ''; });

describe('visible dialog focus controls', () => {
  // Regression: Tab must skip hidden stages and closed advanced settings, but keep their visible summaries.
  it('filters invisible and disabled controls without losing advanced section summaries', () => {
    const card = document.createElement('div'); document.body.appendChild(card);
    card.innerHTML = '<button id="enabled">Enabled</button><button disabled>Disabled</button><div hidden><input /></div><div inert><button>Inert</button></div><div aria-hidden="true"><button>Hidden</button></div><details><summary>Advanced</summary><div><input /></div></details><details open><summary>Open</summary><input id="open" /></details>';
    expect(dialogControls(card).map((node) => node.textContent || node.id)).toEqual(['Enabled', 'Advanced', 'Open', 'open']);
  });

  // Regression: an empty loading state must trap Tab while ordinary keys and intermediate controls keep their normal behavior.
  it('handles missing/empty containers and leaves intermediate Tab navigation to the browser', () => {
    const preventDefault = vi.fn(); const card = document.createElement('div'); document.body.appendChild(card);
    trapDialogTab({ key: 'Tab', shiftKey: false, preventDefault }, null);
    trapDialogTab({ key: 'Enter', shiftKey: false, preventDefault }, card);
    expect(preventDefault).not.toHaveBeenCalled();
    trapDialogTab({ key: 'Tab', shiftKey: false, preventDefault }, card); expect(preventDefault).toHaveBeenCalledOnce();
    card.innerHTML = '<button>First</button><input /><button>Last</button>';
    const input = card.querySelector('input')!; input.focus(); preventDefault.mockClear();
    trapDialogTab({ key: 'Tab', shiftKey: false, preventDefault }, card);
    trapDialogTab({ key: 'Tab', shiftKey: true, preventDefault }, card);
    expect(preventDefault).not.toHaveBeenCalled(); expect(document.activeElement).toBe(input);
  });
});
