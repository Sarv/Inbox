// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_AGENT_SETTINGS, saveAgentSettings } from '../../../../src/services/agent-settings';

const ai = vi.hoisted(() => ({ getDefaultProvider: vi.fn(), makeAICompletion: vi.fn() }));
vi.mock('../../../../src/services/ai-service', () => ai);

type Batch = { contactIds: string[]; accountId?: string };
let listener: (payload: Batch) => Promise<void>;
const contact = { email: 'alice@acme.example', displayName: 'Alice Doe', enrichedThroughEmailAt: 0 };
const contacts = {
  get: vi.fn(), recentInbound: vi.fn(), applyEnrichment: vi.fn(), recordEnrichmentWatermark: vi.fn(),
};
const setReady = vi.fn();
const reportBatchDone = vi.fn();
const reportProgress = vi.fn();

beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); localStorage.clear();
  vi.useFakeTimers();
  ai.getDefaultProvider.mockReturnValue({ id: 'retained-provider' });
  ai.makeAICompletion.mockResolvedValue('{"fullName":"Alice Doe","designation":"Product Manager","companyName":"Acme"}');
  contacts.get.mockResolvedValue({ success: true, data: contact });
  contacts.recentInbound.mockResolvedValue({ success: true, data: [{ id: 'email-fixture', date: 1700000000,
    fromAddress: 'alice@acme.example', cleanBody: 'Hello, here is our update.\n\nRegards,\nAlice Doe\nProduct Manager\nAcme\n+1 212 555 0123\nhttps://www.linkedin.com/in/alice-doe' }] });
  contacts.applyEnrichment.mockResolvedValue({ success: true });
  reportBatchDone.mockResolvedValue({ success: true }); reportProgress.mockResolvedValue({ success: true });
  contacts.recordEnrichmentWatermark.mockResolvedValue({ success: true }); setReady.mockResolvedValue({ success: true });
  window.electronAPI = { contacts, contactEnrichment: {
    onRunBatch: (callback: typeof listener) => { listener = callback; return () => {}; }, reportBatchDone, reportProgress, setReady,
  } } as unknown as typeof window.electronAPI;
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe('automatic contact enrichment opt-in', () => {
  it('properly reviews a legacy incomplete contact with an already-consumed watermark only once', async () => {
    const state = { ...contact, enrichedThroughEmailAt: 1700000000, enrichment: null as unknown, metadata: {} as Record<string, unknown> };
    contacts.get.mockImplementation(async () => ({ success: true, data: state }));
    contacts.applyEnrichment.mockImplementation(async input => {
      state.enrichment = input.enrichment; state.enrichedThroughEmailAt = input.enrichedThroughEmailAt;
      state.metadata.contactEnrichmentReview = input.review;
      return { success: true };
    });
    const service = await import('../../../../src/services/contact-enrichment-service');
    await expect(service.enrichContact({ contactId: 'legacy', automatic: true })).resolves.toMatchObject({ ok: true });
    expect(contacts.applyEnrichment).toHaveBeenCalledWith(expect.objectContaining({ review: { version: 1, signatureFingerprint: expect.any(String), throughEmailAt: 1700000000 } }));
    await expect(service.enrichContact({ contactId: 'legacy', automatic: true })).resolves.toEqual({ ok: false, reason: 'unchanged_signature' });
    expect(ai.makeAICompletion).toHaveBeenCalledOnce();
  });

  it('marks terminal signal-less recovery reviewed and does not keep re-buying an attempt', async () => {
    const state = { ...contact, enrichedThroughEmailAt: 1700000000, enrichment: null, metadata: {} as Record<string, unknown> };
    contacts.get.mockImplementation(async () => ({ success: true, data: state }));
    contacts.recentInbound.mockResolvedValue({ success: true, data: [{ id: 'unsigned', date: 1700000000, cleanBody: 'done.' }] });
    contacts.recordEnrichmentWatermark.mockImplementation(async (_id, through, _account, review) => {
      state.enrichedThroughEmailAt = through; state.metadata.contactEnrichmentReview = review;
      return { success: true };
    });
    const service = await import('../../../../src/services/contact-enrichment-service');
    await expect(service.enrichContact({ contactId: 'legacy-unsigned', automatic: true })).resolves.toEqual({ ok: false, reason: 'no_signals' });
    await expect(service.enrichContact({ contactId: 'legacy-unsigned', automatic: true })).resolves.toEqual({ ok: false, reason: 'unchanged_signature' });
    expect(ai.makeAICompletion).not.toHaveBeenCalled();
    expect(state.metadata.contactEnrichmentReview).toMatchObject({ version: 1 });
  });

  it('does not announce a completed review when its durable marker could not be saved', async () => {
    contacts.recentInbound.mockResolvedValueOnce({ success: true, data: [{ id: 'unsigned', date: 1700000000, cleanBody: 'done.' }] });
    contacts.recordEnrichmentWatermark.mockResolvedValueOnce({ success: false });
    const updates = vi.fn(); document.addEventListener('sarvinbox:contact-enriched', updates);
    const service = await import('../../../../src/services/contact-enrichment-service');
    await expect(service.enrichContact({ contactId: 'unsigned', automatic: true })).resolves.toMatchObject({ reason: 'llm_failed' });
    expect(updates).not.toHaveBeenCalled(); document.removeEventListener('sarvinbox:contact-enriched', updates);
  });

  it('notifies native work when a ready provider changes without repeating the notification on polls', async () => {
    const service = await import('../../../../src/services/contact-enrichment-service');
    service.installEnrichmentBatchListener();
    const before = setReady.mock.calls.at(-1)![2];
    ai.getDefaultProvider.mockReturnValue({ id: 'different-provider', model: 'new-model' });
    window.dispatchEvent(new Event('sarvinbox:ai-provider-changed'));
    expect(setReady).toHaveBeenLastCalledWith(true, expect.any(String), expect.any(String));
    expect(setReady.mock.calls.at(-1)![2]).not.toBe(before);
    const count = setReady.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(setReady).toHaveBeenCalledTimes(count);
  });

  it('reviews a changed signature within ninety days while skipping changing message prose and unsigned notes', async () => {
    const state = { ...contact, enrichment: null as unknown, metadata: {} as Record<string, unknown> };
    contacts.get.mockImplementation(async () => ({ success: true, data: state }));
    contacts.applyEnrichment.mockImplementation(async input => {
      state.enrichment = input.enrichment; state.enrichedThroughEmailAt = input.enrichedThroughEmailAt;
      state.metadata.contactEnrichmentReview = input.review;
      return { success: true };
    });
    contacts.recordEnrichmentWatermark.mockImplementation(async (_id, through, _account, review) => {
      state.enrichedThroughEmailAt = through; state.metadata.contactEnrichmentReview = review;
      return { success: true };
    });
    const signature = '\n\nRegards,\nAlice Doe\nProduct Manager\nAcme\nhttps://www.linkedin.com/in/alice-doe';
    contacts.recentInbound.mockResolvedValue({ success: true, data: [{ id: 'one', date: 1700000000, cleanBody: `First message.${signature}` }] });
    const service = await import('../../../../src/services/contact-enrichment-service');
    await service.enrichContact({ contactId: 'changes', automatic: true });
    contacts.recentInbound.mockResolvedValue({ success: true, data: [{ id: 'two', date: 1700000001, cleanBody: `Entirely different message. Reference phone: +91 98765 43210.${signature}` }] });
    await expect(service.enrichContact({ contactId: 'changes', automatic: true })).resolves.toMatchObject({ reason: 'unchanged_signature' });
    expect(ai.makeAICompletion).toHaveBeenCalledOnce();
    contacts.recentInbound.mockResolvedValue({ success: true, data: [{ id: 'three', date: 1700000002, cleanBody: `A new role.${signature.replace('Product Manager', 'Product Director')}` }] });
    ai.makeAICompletion.mockResolvedValueOnce('{"fullName":"Alice Doe","designation":"Product Director","companyName":"Acme"}');
    await expect(service.enrichContact({ contactId: 'changes', automatic: true })).resolves.toMatchObject({ ok: true });
    expect(ai.makeAICompletion).toHaveBeenCalledTimes(2);
    contacts.recentInbound.mockResolvedValue({ success: true, data: [
      { id: 'unsigned', date: 1700000003, cleanBody: 'done.' },
      { id: 'three', date: 1700000002, cleanBody: `A new role.${signature.replace('Product Manager', 'Product Director')}` },
    ] });
    await expect(service.enrichContact({ contactId: 'changes', automatic: true })).resolves.toMatchObject({ reason: 'unchanged_signature' });
    expect(ai.makeAICompletion).toHaveBeenCalledTimes(2);
  });
  it('does not consume source watermarks while bodies, providers, or consent choices are unavailable', async () => {
    const service = await import('../../../../src/services/contact-enrichment-service');
    contacts.recentInbound.mockResolvedValueOnce({ success: true, data: [{ id: 'header', date: 1700000100, cleanBody: null, htmlBody: null }] });
    await expect(service.enrichContact({ contactId: 'waiting', automatic: true })).resolves.toEqual({ ok: false, reason: 'awaiting_body' });
    ai.getDefaultProvider.mockReturnValue(null);
    await expect(service.enrichContact({ contactId: 'no-provider', automatic: true })).resolves.toEqual({ ok: false, reason: 'no_provider' });
    ai.getDefaultProvider.mockReturnValue({ id: 'provider' });
    localStorage.setItem('sarvinbox-onboarding-pending', 'true');
    await expect(service.enrichContact({ contactId: 'choice-pending', automatic: true })).resolves.toEqual({ ok: false, reason: 'onboarding' });
    expect(contacts.recordEnrichmentWatermark).not.toHaveBeenCalled();
    expect(contacts.applyEnrichment).not.toHaveBeenCalled(); expect(ai.makeAICompletion).not.toHaveBeenCalled();
  });

  it('leaves temporary provider and persistence failures retryable', async () => {
    const service = await import('../../../../src/services/contact-enrichment-service');
    ai.makeAICompletion.mockRejectedValueOnce(new Error('temporary rate limit'));
    await expect(service.enrichContact({ contactId: 'provider-failure', automatic: true })).resolves.toMatchObject({ ok: false, reason: 'llm_failed' });
    contacts.applyEnrichment.mockResolvedValueOnce({ success: false, error: 'temporary database failure' });
    await expect(service.enrichContact({ contactId: 'apply-failure', automatic: true })).resolves.toMatchObject({ ok: false, reason: 'llm_failed' });
    expect(contacts.recordEnrichmentWatermark).not.toHaveBeenCalled();
  });

  it('shares a pending manual and automatic contact request to prevent duplicate charges', async () => {
    let finish!: (raw: string) => void;
    ai.makeAICompletion.mockReturnValueOnce(new Promise<string>(resolve => { finish = resolve; }));
    const service = await import('../../../../src/services/contact-enrichment-service');
    const automatic = service.enrichContact({ contactId: 'shared', automatic: true });
    const manual = service.enrichContact({ contactId: 'shared', force: true });
    await vi.waitFor(() => expect(ai.makeAICompletion).toHaveBeenCalledOnce());
    finish('{"fullName":"Alice Doe"}');
    await Promise.all([automatic, manual]);
    expect(contacts.applyEnrichment).toHaveBeenCalledOnce();
  });

  it('exposes truthful batch progress and resumes when a provider becomes available', async () => {
    ai.getDefaultProvider.mockReturnValue(null);
    const service = await import('../../../../src/services/contact-enrichment-service');
    const observed: ReturnType<typeof service.getEnrichmentStatus>[] = [];
    const unsubscribe = service.subscribeEnrichmentStatus(() => observed.push(service.getEnrichmentStatus()));
    service.installEnrichmentBatchListener();
    expect(service.getEnrichmentStatus()).toMatchObject({ running: false, pausedReason: 'no_provider' });
    expect(setReady).toHaveBeenLastCalledWith(false, expect.any(String), undefined);
    ai.getDefaultProvider.mockReturnValue({ id: 'ready-provider' });
    window.dispatchEvent(new Event('sarvinbox:ai-provider-changed'));
    expect(setReady).toHaveBeenLastCalledWith(true, expect.any(String), expect.any(String));
    const pending = listener({ contactIds: ['a', 'b'], accountId: 'owning-account' });
    await vi.advanceTimersByTimeAsync(2000);
    await pending;
    expect(observed.some(status => status.running && status.contactId === 'a' && status.total === 2)).toBe(true);
    expect(service.getEnrichmentStatus()).toMatchObject({ running: false, processed: 2, total: 2, contactId: undefined, pausedReason: undefined });
    expect(contacts.get).toHaveBeenCalledWith('b', 'owning-account');
    unsubscribe();
  });

  it('preserves user-authored fields and emits profile updates after applying signature evidence', async () => {
    contacts.get.mockResolvedValueOnce({ success: true, data: { ...contact, enrichmentSource: 'user', title: 'Chosen title', organization: 'Chosen employer',
      enrichment: { fullName: 'Chosen name', designation: 'Chosen title', companyName: 'Chosen employer', notes: 'Keep my note', department: 'Chosen department' } } });
    const updates = vi.fn(); document.addEventListener('sarvinbox:contact-enriched', updates);
    const service = await import('../../../../src/services/contact-enrichment-service');
    await service.enrichContact({ contactId: 'manual-profile', automatic: true });
    expect(contacts.applyEnrichment).toHaveBeenCalledWith(expect.objectContaining({ source: 'llm', enrichment: expect.objectContaining({
      fullName: 'Chosen name', designation: 'Chosen title', companyName: 'Chosen employer', department: 'Chosen department', notes: 'Keep my note',
    }) }));
    expect(updates).toHaveBeenCalledOnce(); document.removeEventListener('sarvinbox:contact-enriched', updates);
  });

  it('never binds person identity from a fresh model phone or WhatsApp guess', async () => {
    ai.makeAICompletion.mockResolvedValueOnce('{"fullName":"Alice Doe","personalPhone":"+1 212 555 0123","whatsappNumber":"+1 212 555 0123"}');
    const service = await import('../../../../src/services/contact-enrichment-service');
    await service.enrichContact({ contactId: 'shared-switchboard', automatic: true });
    expect(contacts.applyEnrichment).toHaveBeenCalledWith(expect.objectContaining({ mobileE164: null }));
  });

  it('emits a profile update from the deterministic no-provider path without retiring future AI work', async () => {
    ai.getDefaultProvider.mockReturnValue(null);
    const updates = vi.fn(); document.addEventListener('sarvinbox:contact-enriched', updates);
    const service = await import('../../../../src/services/contact-enrichment-service');
    await service.enrichContact({ contactId: 'local-profile', force: true });
    expect(contacts.applyEnrichment).toHaveBeenCalledWith(expect.objectContaining({ enrichedThroughEmailAt: 0 }));
    expect(updates).toHaveBeenCalledOnce(); expect(ai.makeAICompletion).not.toHaveBeenCalled();
    document.removeEventListener('sarvinbox:contact-enriched', updates);
  });

  it('uses HTML mining evidence for icon-only profiles even when the clean body is long', async () => {
    ai.getDefaultProvider.mockReturnValue(null);
    contacts.recentInbound.mockResolvedValueOnce({ success: true, data: [{ id: 'icon-link', date: 1700000000,
      cleanBody: 'The cleaned message lacks all signature hyperlinks. '.repeat(4),
      miningText: 'Hello.\n\nRegards,\nAlice Doe\nEngineering Lead\nAcme Ltd\nhttps://www.linkedin.com/in/alice-doe' }] });
    const service = await import('../../../../src/services/contact-enrichment-service');
    await service.enrichContact({ contactId: 'icon-owner', force: true });
    expect(contacts.applyEnrichment).toHaveBeenCalledWith(expect.objectContaining({ enrichment: expect.objectContaining({ linkedinUrl: 'https://www.linkedin.com/in/alice-doe' }) }));
  });
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
