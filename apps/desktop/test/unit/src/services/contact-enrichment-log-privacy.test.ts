// @vitest-environment happy-dom
import { getLogLevel, setLogLevel, setLogSink } from '@sarvinbox/core/logger';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { captureLogs, type CapturedLogs } from '../../../../../../packages/core/src/test-support/log-capture';

/**
 * What the renderer's contact-enrichment batch writes when a contact fails.
 * The failure can be a provider's error, which carries its response body, and
 * that body can quote the prompt: the contact's own signatures and mail. The
 * renderer forwards its log lines to app.log, a release build included.
 *
 * What breaks if this file fails: a failed enrichment writes the error's text
 * (mail, a contact's details) into app.log, or a failure stops being reported.
 */

const ai = vi.hoisted(() => ({ getDefaultProvider: vi.fn(), makeAICompletion: vi.fn() }));
vi.mock('../../../../src/services/ai-service', () => ai);

const SENTINEL = 'SENTINEL-Jane-Doe-signature-+1-212-555-0123';
type Batch = { contactIds: string[]; accountId?: string; batchId?: string };
let runBatch: (payload: Batch) => Promise<void>;
const contacts = { get: vi.fn(), recentInbound: vi.fn(), applyEnrichment: vi.fn(), recordEnrichmentWatermark: vi.fn() };
const reportProgress = vi.fn();
const reportBatchDone = vi.fn();

let logs: CapturedLogs;
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  localStorage.clear();
  ai.getDefaultProvider.mockReturnValue({ id: 'provider' });
  contacts.recentInbound.mockResolvedValue({ success: true, data: [] });
  reportProgress.mockResolvedValue({ success: true });
  reportBatchDone.mockResolvedValue({ success: true });
  window.electronAPI = {
    contacts,
    contactEnrichment: {
      onRunBatch: (callback: typeof runBatch) => { runBatch = callback; return () => {}; },
      reportProgress,
      reportBatchDone,
      setReady: vi.fn(async () => ({ success: true })),
    },
  } as unknown as typeof window.electronAPI;
  logs = captureLogs({ setLogSink, setLogLevel, getLogLevel });
});
afterEach(() => { logs.stop(); });

async function installed() {
  const service = await import('../../../../src/services/contact-enrichment-service');
  service.installEnrichmentBatchListener();
  return service;
}

describe('contact enrichment batch — what reaches the log', () => {
  // Breaks: 'Contact enrichment failed: <id> <error>' prints the error whole
  // (its message and stack), and a provider's response body with it.
  it('logs a failed contact by its id and the error class and code, and still reports it', async () => {
    await installed();
    contacts.get.mockRejectedValue(Object.assign(new Error(`API request failed: 400 - ${SENTINEL}`), { code: 'invalid_request', status: 400 }));

    await runBatch({ contactIds: ['contact-7'], batchId: 'b1' });

    expect(logs.containing(SENTINEL)).toEqual([]);
    const [line] = logs.containing('Contact enrichment failed:');
    expect(line).toContain('contact-7');
    expect(line).toContain("code: 'invalid_request'");
    expect(line).toContain('status: 400');
    expect(reportProgress).toHaveBeenCalledWith({ contactId: 'contact-7', batchId: 'b1', ok: false, reason: 'llm_failed' });
    expect(reportBatchDone).toHaveBeenCalledWith({ batchId: 'b1', continue: true });
  });

  // Breaks: 'Enrichment batch failed: <error>' prints the error whole.
  it('logs a failed batch by the error class only', async () => {
    const service = await installed();
    service.subscribeEnrichmentStatus(() => { throw new TypeError(`listener choked on ${SENTINEL}`); });

    await runBatch({ contactIds: ['contact-7'] });

    expect(logs.containing(SENTINEL)).toEqual([]);
    const [line] = logs.containing('Enrichment batch failed:');
    expect(line).toContain("name: 'TypeError'");
  });
});
