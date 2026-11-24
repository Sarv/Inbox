// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PolishModal } from '../../../../src/components/PolishModal';
import type { PolishContext } from '../../../../src/services/ai-service';
import { cleanup, render, settle } from '../../../helpers/render';

/**
 * The Polish dialog shows the user their rewritten draft; the log gets none of it.
 *
 * What breaks if this file fails: the polished draft (`[PolishModal] Received
 * result: {subject, body}`) or a failure message that quotes it is written to
 * app.log, which the renderer forwards in release builds — or the dialog stops
 * showing the result or the error to the user.
 */

const SENTINEL = 'SENTINEL-DRAFT-4d0a';
const h = vi.hoisted(() => ({ polishText: vi.fn() }));
vi.mock('../../../../src/services/ai-service', () => ({
  polishText: h.polishText,
  getDefaultProvider: () => null,
}));
vi.mock('../../../../src/components/SandboxedEmailBody', () => ({
  SandboxedEmailBody: ({ html }: { html: string }) => <div data-testid="polished">{html}</div>,
}));

const context: PolishContext = { mode: 'new', polishMode: 'full' };
const consoleLines = (): string[] => (['log', 'info', 'warn', 'error', 'debug'] as const)
  .flatMap((method) => vi.mocked(console[method]).mock.calls)
  .map((args) => args.map((arg) => (typeof arg === 'string' ? arg : arg instanceof Error ? `${arg.stack} ${arg.message}` : JSON.stringify(arg))).join(' '));

beforeEach(() => {
  h.polishText.mockReset();
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('PolishModal logging', () => {
  // Breaks: the polished draft is logged when it arrives.
  it('shows the polished draft and logs nothing of it', async () => {
    h.polishText.mockResolvedValue({ subject: `Re: ${SENTINEL}`, body: `<p>${SENTINEL} body</p>` });
    const mounted = render(<PolishModal originalText={`draft ${SENTINEL}`} originalSubject={SENTINEL} context={context} onAccept={vi.fn()} onClose={vi.fn()} />);
    await settle();
    expect(mounted.find('[data-testid="polished"]')?.textContent).toBe(`<p>${SENTINEL} body</p>`);
    expect(mounted.container.textContent).toContain(`Re: ${SENTINEL}`);
    for (const line of consoleLines()) expect(line).not.toContain(SENTINEL);
  });

  // Breaks: a failure is logged with its message — which the user still sees —
  // instead of only what it was.
  it('shows a failure to the user and logs only its class and status', async () => {
    h.polishText.mockRejectedValue(Object.assign(new Error(`API request failed: 400 - near "${SENTINEL}"`), { status: 400 }));
    const mounted = render(<PolishModal originalText={`draft ${SENTINEL}`} context={context} onAccept={vi.fn()} onClose={vi.fn()} />);
    await settle();
    expect(mounted.container.textContent).toContain(`near "${SENTINEL}"`);
    const lines = consoleLines();
    expect(lines.some((line) => line.includes('polish failed {"name":"Error","status":400}'))).toBe(true);
    for (const line of lines) expect(line).not.toContain(SENTINEL);
  });
});
