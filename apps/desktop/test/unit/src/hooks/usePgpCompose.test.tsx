// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RECIPIENT_LOOKUP_DEBOUNCE_MS, usePgpCompose } from '../../../../src/hooks/usePgpCompose';
import { act, fire, render, settle, type Mounted } from '../../../helpers/render';

/**
 * The composer's OpenPGP state over the bridge. What this protects: a WKD
 * lookup (a network request to the recipient's domain) made for a user who
 * never set up encryption; a lookup per keystroke; keys found for an old
 * recipient list being trusted for the new one; and a failed lookup reading
 * as "everyone has a key".
 */
const api = {
  composeDefaults: vi.fn(),
  resolveRecipients: vi.fn(),
};

function Probe({ from, recipients, reply = false }: { from?: string; recipients: string[]; reply?: boolean }) {
  const { state, toggleEncrypt, toggleSign } = usePgpCompose(from, recipients, reply);
  return (
    <div data-state={JSON.stringify(state)}>
      <button aria-label="encrypt" onClick={toggleEncrypt} />
      <button aria-label="sign" onClick={toggleSign} />
    </div>
  );
}

let mounted: Mounted | null = null;
const stateOf = () => JSON.parse(mounted!.find('[data-state]')!.getAttribute('data-state')!);
const afterDebounce = () => act(async () => {
  await vi.advanceTimersByTimeAsync(RECIPIENT_LOOKUP_DEBOUNCE_MS);
});

const withKey = { hasOwnKey: true, signByDefault: false, autoEncrypt: true };
const key = (email: string) => ({ email, status: 'key', source: 'wkd', fingerprint: 'F' });

beforeEach(() => {
  vi.useFakeTimers();
  api.composeDefaults.mockReset().mockResolvedValue({ success: true, data: withKey });
  api.resolveRecipients.mockReset().mockImplementation(async (emails: string[]) => ({ success: true, data: emails.map(key) }));
  (window as unknown as { electronAPI: unknown }).electronAPI = { pgp: api };
});
afterEach(() => {
  mounted?.unmount();
  mounted = null;
  vi.useRealTimers();
});

describe('usePgpCompose', () => {
  // Breaks: auto-encrypt never engages from a real composer.
  it('loads the defaults, looks the recipients up once typing pauses, and encrypts', async () => {
    mounted = render(<Probe from="me@x.org" recipients={['A@x.org', 'a@x.org ', 'b@x.org']} />);
    await settle();
    expect(api.composeDefaults).toHaveBeenCalledWith('me@x.org');
    expect(stateOf()).toMatchObject({ available: true, resolving: true, encrypt: false });
    expect(api.resolveRecipients).not.toHaveBeenCalled();

    await afterDebounce();
    expect(api.resolveRecipients).toHaveBeenCalledWith(['a@x.org', 'b@x.org']);
    expect(stateOf()).toMatchObject({ resolving: false, encrypt: true, request: { encrypt: true, sign: false } });
  });

  // Breaks: the privacy promise — a network key lookup for someone who never set up OpenPGP.
  it('never looks recipients up without a key of your own', async () => {
    api.composeDefaults.mockResolvedValue({ success: true, data: { hasOwnKey: false, signByDefault: false, autoEncrypt: true } });
    mounted = render(<Probe from="me@x.org" recipients={['a@x.org']} />);
    await settle();
    await afterDebounce();
    expect(api.resolveRecipients).not.toHaveBeenCalled();
    expect(stateOf().available).toBe(false);
    expect(stateOf().request).toBeUndefined();
  });

  // Breaks: a composer with no sender (or a broken bridge) offers toggles that can only fail.
  it('treats no sender, a refused request and a rejected one as "no OpenPGP"', async () => {
    mounted = render(<Probe recipients={['a@x.org']} />);
    await settle();
    expect(api.composeDefaults).not.toHaveBeenCalled();
    expect(stateOf().available).toBe(false);

    api.composeDefaults.mockResolvedValueOnce({ success: false, error: 'x' });
    mounted.rerender(<Probe from="one@x.org" recipients={['a@x.org']} />);
    await settle();
    expect(stateOf().available).toBe(false);

    api.composeDefaults.mockRejectedValueOnce(new Error('bridge gone'));
    mounted.rerender(<Probe from="two@x.org" recipients={['a@x.org']} />);
    await settle();
    expect(stateOf().available).toBe(false);
  });

  // Breaks: a failed lookup reads as "everyone has a key", and auto-encrypt sends what main then refuses.
  it('reads a failed or rejected lookup as nobody having a key', async () => {
    api.resolveRecipients.mockResolvedValueOnce({ success: false, error: 'x' });
    mounted = render(<Probe from="me@x.org" recipients={['a@x.org']} />);
    await settle();
    await afterDebounce();
    expect(stateOf()).toMatchObject({ encrypt: false, missing: ['a@x.org'] });

    api.resolveRecipients.mockRejectedValueOnce(new Error('offline'));
    mounted.rerender(<Probe from="me@x.org" recipients={['b@x.org']} />);
    await afterDebounce();
    expect(stateOf()).toMatchObject({ encrypt: false, missing: ['b@x.org'] });
  });

  // Breaks: keys found for the old list are trusted for a new recipient who has none.
  it('forgets the keys the moment the recipients change, and looks up once per pause', async () => {
    mounted = render(<Probe from="me@x.org" recipients={['a@x.org']} />);
    await settle();
    await afterDebounce();
    expect(stateOf().encrypt).toBe(true);

    mounted.rerender(<Probe from="me@x.org" recipients={['a@x.org', 'b']} />);
    mounted.rerender(<Probe from="me@x.org" recipients={['a@x.org', 'b@x.org']} />);
    expect(stateOf()).toMatchObject({ resolving: true, encrypt: false });
    await afterDebounce();
    expect(api.resolveRecipients).toHaveBeenCalledTimes(2);
    expect(api.resolveRecipients).toHaveBeenLastCalledWith(['a@x.org', 'b@x.org']);
  });

  // Breaks: an empty To field sits on "resolving" for ever.
  it('resolves an empty recipient list at once, without a lookup', async () => {
    mounted = render(<Probe from="me@x.org" recipients={[]} />);
    await settle();
    expect(stateOf()).toMatchObject({ resolving: false, encrypt: false });
    expect(api.resolveRecipients).not.toHaveBeenCalled();
  });

  // Breaks: the toolbar's lock and pen do nothing.
  it('flips encryption and signing from their current state', async () => {
    mounted = render(<Probe from="me@x.org" recipients={['a@x.org']} reply />);
    await settle();
    expect(stateOf().encrypt).toBe(true);
    fire(mounted.byLabel('encrypt'), 'click');
    fire(mounted.byLabel('sign'), 'click');
    expect(stateOf()).toMatchObject({ encrypt: false, sign: true });
  });
});
