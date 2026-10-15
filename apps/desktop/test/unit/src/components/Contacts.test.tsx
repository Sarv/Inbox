// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Contacts } from '../../../../src/components/Contacts';
import { act, cleanup, fire, render, settle } from '../../../helpers/render';

const enrichment = vi.hoisted(() => ({
  enrichContact: vi.fn(),
  status: { running: false, processed: 0, total: 0, pausedReason: 'ai_disabled' },
}));
vi.mock('../../../../src/services/contact-enrichment-service', () => ({
  enrichContact: enrichment.enrichContact,
  getEnrichmentStatus: () => enrichment.status,
  subscribeEnrichmentStatus: () => () => {},
}));
vi.mock('../../../../src/components/Avatar', () => ({ Avatar: () => <span aria-hidden="true" /> }));

const alice = {
  id: 'alice-id', email: 'alice@acme.example', name: 'Alice McDonald', displayName: null,
  avatarUrl: null, avatarStatus: null, organization: 'Acme', title: 'Engineering Lead', phone: null,
  firstSeen: 1700000000, lastSeen: 1700000000, emailCount: 5, sentCount: 2, receivedCount: 3,
  isFavorite: false, notes: null, tags: [], createdAt: 1700000000, updatedAt: 1700000000,
  contactType: 'colleague', contactTypeSource: 'rule', contactTypeConfidence: 0.9,
  enrichment: { designation: 'Engineering Lead', linkedinUrl: 'https://linkedin.com/in/alice' },
};
const bob = { ...alice, id: 'bob-id', email: 'bob@example.com', name: 'Bob Smith', title: 'Designer', enrichment: { designation: 'Designer' } };
let records: Array<typeof bob>;
let onContactsUpdated: () => void;
const api = {
  contacts: {
    list: vi.fn(), get: vi.fn(), scan: vi.fn(), update: vi.fn(), delete: vi.fn(),
    getRelatedByPerson: vi.fn(), onAvatarsUpdated: vi.fn(), onUpdated: vi.fn(),
  },
  sender: { getStats: vi.fn(), listVip: vi.fn() },
  agent: { getNotes: vi.fn(), getContactTypeCounts: vi.fn(), autoClassifyContacts: vi.fn(), setContactType: vi.fn() },
};

beforeEach(() => {
  records = [structuredClone(alice), structuredClone(bob)];
  localStorage.clear();
  vi.clearAllMocks();
  api.contacts.list.mockImplementation(async (options) => {
    const matches = records.filter((contact) => (!options.contactType || contact.contactType === options.contactType)
      && (!options.search || contact.email.includes(options.search) || contact.name.includes(options.search)));
    return { success: true, data: { contacts: matches.slice(options.offset, options.offset + options.limit), total: matches.length } };
  });
  api.contacts.get.mockImplementation(async (id) => ({ success: true, data: records.find((contact) => contact.id === id) }));
  api.contacts.getRelatedByPerson.mockResolvedValue({ success: true, data: [] });
  api.contacts.onAvatarsUpdated.mockReturnValue(() => {});
  api.contacts.onUpdated.mockImplementation((listener) => { onContactsUpdated = listener; return () => {}; });
  api.sender.getStats.mockResolvedValue({ success: false });
  api.sender.listVip.mockResolvedValue({ success: true, data: [] });
  api.agent.getNotes.mockResolvedValue({ success: true, data: [] });
  api.agent.getContactTypeCounts.mockResolvedValue({ success: true, data: { colleague: 2 } });
  api.agent.autoClassifyContacts.mockResolvedValue({ success: true, data: { classified: 0 } });
  api.agent.setContactType.mockResolvedValue({ success: false, error: 'Could not save category' });
  enrichment.enrichContact.mockResolvedValue({ ok: true });
  window.electronAPI = api as unknown as typeof window.electronAPI;
});
afterEach(cleanup);

const openContact = (view: ReturnType<typeof render>, name: string) => {
  const row = view.all('button').find((button) => button.textContent?.includes(name));
  fire(row!, 'click');
};

describe('Contacts profile and automatic updates', () => {
  it('shows every category, filters from overview tiles, and reviews without a manually configured profile email', async () => {
    const view = render(<Contacts />);
    await settle();
    expect(view.all('button[aria-pressed]')).toHaveLength(10);
    expect(view.container.textContent).toContain('Automatic AI enrichment is paused');
    fire(view.byLabel('Filter Automated contacts'), 'click');
    await settle();
    expect(api.contacts.list).toHaveBeenCalledWith(expect.objectContaining({ contactType: 'automated' }));
    fire(view.all('button').find((button) => button.textContent === 'Review categories')!, 'click');
    await settle();
    expect(api.agent.autoClassifyContacts).toHaveBeenCalledWith();
    expect(view.container.textContent).not.toContain('Set your email in Settings');
  });

  it('presents profile sections before engagement data and keeps email navigation', async () => {
    const onSearchMail = vi.fn();
    const view = render(<Contacts onSearchMail={onSearchMail} />);
    await settle();
    openContact(view, 'Alice McDonald');
    await settle();
    expect(view.container.textContent).toContain('Engineering Lead');
    expect(view.container.textContent).toContain('Online profiles');
    expect(view.container.textContent).toContain('Not found yet');
    fire(view.all('button').find((button) => button.textContent === alice.email)!, 'click');
    expect(onSearchMail).toHaveBeenCalledWith(alice.email);
    expect(view.all('a').some((link) => link.getAttribute('href')?.includes('linkedin.com/in/alice'))).toBe(true);
  });

  it('updates the selected profile after background signature enrichment without another click', async () => {
    const view = render(<Contacts />);
    await settle();
    openContact(view, 'Alice McDonald');
    await settle();
    records[0] = { ...records[0]!, title: 'Platform Director', enrichment: { designation: 'Platform Director' } };
    act(() => document.dispatchEvent(new CustomEvent('sarvinbox:contact-enriched', { detail: { contactId: alice.id } })));
    await settle();
    expect(view.container.textContent).toContain('Platform Director');
  });

  it('ignores a late enrichment response for a profile the user has left', async () => {
    const view = render(<Contacts />);
    await settle();
    openContact(view, 'Alice McDonald');
    await settle();
    let resolve!: (value: unknown) => void;
    api.contacts.get.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    act(() => document.dispatchEvent(new CustomEvent('sarvinbox:contact-enriched', { detail: { contactId: alice.id } })));
    await settle();
    openContact(view, 'Bob Smith');
    await settle();
    await act(async () => resolve({ success: true, data: alice }));
    expect(view.byLabel('Contact category')).not.toBeNull();
    const profile = view.find('#contact-profile-heading')?.closest('section');
    expect(profile?.textContent).toContain('Bob Smith');
    expect(profile?.textContent).not.toContain('Alice McDonald');
  });

  it('updates categories in the selected profile when the background classifier reports changes', async () => {
    const view = render(<Contacts />);
    await settle();
    openContact(view, 'Alice McDonald');
    await settle();
    records[0] = { ...records[0]!, contactType: 'vendor', contactTypeSource: 'behavior' };
    act(() => onContactsUpdated());
    await settle();
    expect((view.byLabel('Contact category') as HTMLSelectElement).value).toBe('vendor');
  });

  it('keeps the saved category and reports errors when an update fails', async () => {
    const view = render(<Contacts />);
    await settle();
    openContact(view, 'Alice McDonald');
    await settle();
    const select = view.byLabel('Contact category') as HTMLSelectElement;
    select.value = 'vendor';
    fire(select, 'change');
    await settle();
    expect(view.container.textContent).toContain('Could not save category');
    expect((view.byLabel('Contact category') as HTMLSelectElement).value).toBe('colleague');
  });

  it('hydrates VIPs with real contact IDs and complete profiles', async () => {
    api.sender.listVip.mockResolvedValue({ success: true, data: [{ email: alice.email }] });
    const view = render(<Contacts />);
    await settle();
    const vipCard = view.all('div').find((element) => element.textContent?.startsWith('VIPsPeople you have marked as important'));
    const row = vipCard?.querySelector('button');
    fire(row!, 'click');
    await settle();
    fire(view.all('button').find((button) => button.textContent === 'Review signatures now')!, 'click');
    await settle();
    expect(enrichment.enrichContact).toHaveBeenCalledWith({ contactId: alice.id, force: true });
    expect(view.container.textContent).toContain('Engineering Lead');
  });
});
