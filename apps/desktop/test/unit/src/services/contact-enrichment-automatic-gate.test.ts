// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_AGENT_SETTINGS, saveAgentSettings } from '../../../../src/services/agent-settings';

const ai = vi.hoisted(() => ({ getDefaultProvider: vi.fn(), makeAICompletion: vi.fn() }));
vi.mock('../../../../src/services/ai-service', () => ai);

type Batch = { contactIds: string[]; accountId?: string };
let listener: (payload: Batch) => Promise<void>;
const contact = { email: 'alice@acme.example', displayName: 'Alice Doe', enrichedThroughEmailAt: 0 };
const contacts = {
  get: vi.fn(), recentInbound: vi.fn(), applyEnrichment: vi.fn(),
};
const reportBatchDone = vi.fn();
const reportProgress = vi.fn();

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); localStorage.clear();
  ai.getDefaultProvider.mockReturnValue({ id: 'retained-provider' });
  ai.makeAICompletion.mockResolvedValue('{"fullName":"Alice Doe","designation":"Product Manager","companyName":"Acme"}');
  contacts.get.mockResolvedValue({ success: true, data: contact });
  contacts.recentInbound.mockResolvedValue({ success: true, data: [{ id: 'email-fixture', date: 1700000000,
    fromAddress: 'alice@acme.example', cleanBody: 'Hello, here is our update.\n\nRegards,\nAlice Doe\nProduct Manager\nAcme\n+1 212 555 0123\nhttps://www.linkedin.com/in/alice-doe' }] });
  contacts.applyEnrichment.mockResolvedValue({ success: true });
  reportBatchDone.mockResolvedValue({ success: true }); reportProgress.mockResolvedValue({ success: true });
  window.electronAPI = { contacts, contactEnrichment: {
    onRunBatch: (callback: typeof listener) => { listener = callback; return () => {}; }, reportBatchDone, reportProgress,
  } } as unknown as typeof window.electronAPI;
});

describe('automatic contact enrichment opt-in', () => {
  // Regression: retained provider credentials after onboarding Skip must not
  // cause the scheduler to transmit signatures or advance skipped watermarks.
  it('skips disabled automatic batches and releases the scheduler lock', async () => {
    saveAgentSettings({ ...DEFAULT_AGENT_SETTINGS, enabled: false });
    const service = await import('../../../../src/services/contact-enrichment-service');
    service.installEnrichmentBatchListener();
    await listener({ contactIds: ['contact-a', 'contact-b'], accountId: 'account-a' });
    expect(contacts.get).not.toHaveBeenCalled(); expect(ai.makeAICompletion).not.toHaveBeenCalled();
    expect(contacts.applyEnrichment).not.toHaveBeenCalled(); expect(reportBatchDone).toHaveBeenCalledOnce();
  });

  // Regression: the master automatic switch must preserve a user's deliberate
  // per-contact Enrich action rather than blocking all access to saved providers.
  it('allows explicit manual Enrich while automatic AI is off', async () => {
    saveAgentSettings({ ...DEFAULT_AGENT_SETTINGS, enabled: false });
    const service = await import('../../../../src/services/contact-enrichment-service');
    await service.enrichContact({ contactId: 'contact-a', accountId: 'account-a', force: true });
    expect(ai.makeAICompletion).toHaveBeenCalledOnce();
    expect(contacts.get).toHaveBeenCalledWith('contact-a', 'account-a');
  });

  // Regression: a user can switch AI off while contact/body reads are pending;
  // the final send guard must recheck before any signature reaches a provider.
  it('rechecks the choice after asynchronous contact reads', async () => {
    saveAgentSettings({ ...DEFAULT_AGENT_SETTINGS, enabled: true });
    let resolve!: (value: { success: boolean; data: typeof contact }) => void;
    contacts.get.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    const service = await import('../../../../src/services/contact-enrichment-service');
    const pending = service.enrichContact({ contactId: 'contact-a', automatic: true });
    saveAgentSettings({ ...DEFAULT_AGENT_SETTINGS, enabled: false });
    resolve({ success: true, data: contact });
    await expect(pending).resolves.toEqual({ ok: false, reason: 'ai_disabled' });
    expect(ai.makeAICompletion).not.toHaveBeenCalled(); expect(contacts.applyEnrichment).not.toHaveBeenCalled();
  });

  // Regression: turning AI off mid-batch must stop subsequent contacts, while
  // completion acknowledgement still releases the native in-flight lock.
  it('stops later contacts when AI is turned off during a running batch', async () => {
    saveAgentSettings({ ...DEFAULT_AGENT_SETTINGS, enabled: true });
    ai.makeAICompletion.mockImplementationOnce(async () => {
      saveAgentSettings({ ...DEFAULT_AGENT_SETTINGS, enabled: false });
      return '{"fullName":"Alice Doe"}';
    });
    const service = await import('../../../../src/services/contact-enrichment-service');
    service.installEnrichmentBatchListener();
    await listener({ contactIds: ['contact-a', 'contact-b'] });
    expect(contacts.get).toHaveBeenCalledOnce(); expect(ai.makeAICompletion).toHaveBeenCalledOnce();
    expect(reportBatchDone).toHaveBeenCalledOnce();
  });
});
