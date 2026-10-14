import { afterEach, describe, expect, it, vi } from 'vitest';

import { isLocalSentMirror, needsAttachmentMetadata } from '../../../../src/utils/attachment-metadata';

vi.mock('../../../../src/components/email-list/CategoryBadges', () => ({
  clearCategoryBadgeCache: vi.fn(), applyEmailCategories: vi.fn(),
  getCachedCategorySlugs: vi.fn(() => []), warmCategoryDefs: vi.fn(),
}));

const legacy = {
  id: 'sent@example.test', messageId: '<sent@example.test>', tags: '|Sent|read|',
  rawBody: '<p>Forwarded message.</p>', hasAttachments: false,
  attachmentNames: '', attachmentSizes: null,
};

afterEach(() => vi.unstubAllGlobals());

describe('attachment metadata recovery', () => {
  it('rechecks an old local Sent mirror even when its flag incorrectly says no files', () => {
    expect(isLocalSentMirror(legacy)).toBe(true);
    expect(needsAttachmentMetadata(legacy)).toBe(true);
  });

  it('does not recheck a send that has already been verified attachment-free', () => {
    expect(needsAttachmentMetadata({ ...legacy, attachmentSizes: '[]' })).toBe(false);
  });

  it('leaves received messages and local drafts with no files alone', () => {
    expect(needsAttachmentMetadata({ ...legacy, id: 'generated-received-id', tags: '|INBOX|' })).toBe(false);
    expect(needsAttachmentMetadata({ ...legacy, tags: '|Drafts|draft|' })).toBe(false);
  });

  it.each([null, '[]', '[1,2]', '[null]', 'invalid'])('repairs a declared file with incomplete size metadata %s', (attachmentSizes) => {
    expect(needsAttachmentMetadata({
      ...legacy, hasAttachments: true, attachmentNames: '["report.docx"]', attachmentSizes,
    })).toBe(true);
  });

  it('repairs a paperclip with missing names even when the size field contains a truthy empty array', () => {
    expect(needsAttachmentMetadata({ ...legacy, hasAttachments: true, attachmentSizes: '[]' })).toBe(true);
  });

  it('keeps complete attachment metadata, including an empty file, without refetching', () => {
    expect(needsAttachmentMetadata({
      ...legacy, hasAttachments: true, attachmentNames: '["empty.txt"]', attachmentSizes: '[0]',
    })).toBe(false);
  });

  it('lets the real store fetch metadata for a cached legacy Sent body', async () => {
    const repaired = {
      ...legacy, hasAttachments: true, attachmentNames: '["report.docx"]', attachmentSizes: '[14336]',
    };
    const fetchBody = vi.fn(async () => ({ success: true, data: repaired }));
    vi.stubGlobal('window', { electronAPI: { emails: { fetchBody } } });
    const { createEmailsSlice } = await import('../../../../src/store/slices/emails-slice');
    const state: Record<string, any> = {
      loadingBodies: new Set(), failedBodies: new Set(), emails: [legacy],
      threadEmails: [], searchResults: [], sectionData: {}, folders: [], viewAccountId: 'account-a',
    };
    const set = (patch: Record<string, any>) => { Object.assign(state, patch); };
    const slice = createEmailsSlice(set as any, (() => state) as any, {} as any);

    await slice.fetchEmailBody(legacy.id);

    expect(fetchBody).toHaveBeenCalledWith(legacy.id, 'account-a');
    expect(state.emails[0]).toMatchObject(repaired);
    expect(state.failedBodies.size).toBe(0);
  });
});
