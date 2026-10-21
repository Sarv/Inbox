// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AppSidebar } from '../../../../src/components/AppSidebar';
import { cleanup, fire, render } from '../../../helpers/render';

afterEach(cleanup);

const labelOf = (button: HTMLButtonElement) =>
  button.getAttribute('aria-label') ?? button.getAttribute('title') ?? button.textContent?.trim();

describe('AppSidebar AI navigation', () => {
  it.each([false, true])('offers one AI destination and preserves navigation (expanded: %s)', (expanded) => {
    const onSectionChange = vi.fn();
    const view = render(<AppSidebar activeSection="ai-settings" onSectionChange={onSectionChange} />);
    if (expanded) fire(view.byLabel('Expand sidebar'), 'click');

    const navigation = [...view.container.querySelectorAll<HTMLButtonElement>('button')]
      .filter((button) => !button.querySelector('img') && !labelOf(button)?.includes('sidebar'));
    expect(navigation.map(labelOf)).toEqual(['Mail', 'Inbox Agent', 'Calendar', 'Contacts', 'Extensions', 'AI', 'Settings', 'Security']);

    const ai = navigation.filter((button) => labelOf(button) === 'AI');
    expect(ai).toHaveLength(1);
    fire(ai[0], 'click');
    expect(onSectionChange).toHaveBeenCalledExactlyOnceWith('ai-settings');

    onSectionChange.mockClear();
    for (const item of navigation.filter((button) => labelOf(button) !== 'AI')) fire(item, 'click');
    expect(onSectionChange.mock.calls.map(([section]) => section)).toEqual([
      'mail', 'assistant', 'calendar', 'contacts', 'extensions', 'settings', 'security',
    ]);
  });
});
