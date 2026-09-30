// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PgpComposeControls } from '../../../../src/hooks/usePgpCompose';
import { fire, render, type Mounted } from '../../../helpers/render';

// What breaks if this suite goes red: the composer's OpenPGP lock and pen —
// toggles shown to users who cannot use them, a lock whose state is invisible
// to a screen reader, or an encrypted send that will be refused with nothing
// on the lock to warn about it.
vi.mock('../../../../src/components/Tooltip', () => ({
  Tooltip: ({ children, content, delayMs }: { children: React.ReactNode; content: string; delayMs?: number }) => (
    <span data-tooltip={content} data-tooltip-delay={delayMs}>
      {children}
    </span>
  ),
}));

const { ComposeToolbar } = await import('../../../../src/components/ComposeToolbar');

const props = {
  sending: false,
  hasAIProvider: false,
  plainBody: 'hello',
  hasRecipients: true,
  onSend: vi.fn(),
  onAttach: vi.fn(),
  onPolish: vi.fn(),
  onDiscard: vi.fn(),
};

const controls = (over: Partial<PgpComposeControls['state']> = {}): PgpComposeControls => ({
  state: { available: true, encrypt: false, sign: false, missing: [], resolving: false, request: { encrypt: false, sign: false }, ...over },
  toggleEncrypt: vi.fn(),
  toggleSign: vi.fn(),
});

let mounted: Mounted | null = null;
afterEach(() => {
  mounted?.unmount();
  mounted = null;
});
const toggle = (which: 'encrypt' | 'sign') => mounted!.find(`[data-pgp-toggle="${which}"]`);

describe('ComposeToolbar OpenPGP toggles', () => {
  // Breaks: users with no key (or composers that never pass pgp) see toggles that can only fail.
  it('shows no toggles without a key of your own', () => {
    mounted = render(<ComposeToolbar {...props} pgp={controls({ available: false })} />);
    expect(toggle('encrypt')).toBeNull();
    mounted.rerender(<ComposeToolbar {...props} />);
    expect(toggle('sign')).toBeNull();
  });

  // Breaks: the lock's state is invisible to assistive tech, or its tooltip lags (UI convention).
  it('labels both toggles, reports their state and uses the instant tooltip', () => {
    const pgp = controls({ encrypt: true, sign: false });
    mounted = render(<ComposeToolbar {...props} pgp={pgp} />);
    expect(toggle('encrypt')?.getAttribute('aria-pressed')).toBe('true');
    expect(toggle('encrypt')?.getAttribute('aria-label')).toBe('Encrypted — only the recipients can read it');
    expect(toggle('sign')?.getAttribute('aria-pressed')).toBe('false');
    expect(mounted.find('[data-tooltip="Sign with your OpenPGP key"]')?.getAttribute('data-tooltip-delay')).toBe('40');
    fire(toggle('encrypt'), 'click');
    fire(toggle('sign'), 'click');
    expect(pgp.toggleEncrypt).toHaveBeenCalledTimes(1);
    expect(pgp.toggleSign).toHaveBeenCalledTimes(1);
  });

  // Breaks: an encrypted send that main will refuse looks exactly like one that will go through.
  it('warns on the lock when a recipient has no key', () => {
    mounted = render(<ComposeToolbar {...props} pgp={controls({ encrypt: true, missing: ['b@x.org'] })} />);
    expect(toggle('encrypt')?.className).toContain('amber');
    expect(toggle('encrypt')?.getAttribute('aria-label')).toContain('b@x.org');
  });
});
