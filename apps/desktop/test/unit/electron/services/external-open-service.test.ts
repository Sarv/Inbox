import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ExternalOpenService, MAX_EXTERNAL_ICS_BYTES, MAX_EXTERNAL_OPEN_QUEUE, parseExternalMailto, readExternalCalendarFile } from '../../../../electron/services/external-open-service';

const ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n';

describe('untrusted mailto links', () => {
  it('keeps plus addressing, UTF-8, recipients and plain-text line breaks', () => {
    expect(parseExternalMailto('mailto:one+sales@example.com?cc=two%2Btag%40example.com&bcc=three%40example.com&subject=Hello%20%E2%9C%93&body=Line%201%0D%0ALine+2')).toEqual({
      kind: 'compose', to: ['one+sales@example.com'], cc: ['two+tag@example.com'], bcc: ['three@example.com'], subject: 'Hello ✓', body: 'Line 1\nLine+2',
    });
  });

  it('allows a blank new message and explicitly supplied to query recipients', () => {
    expect(parseExternalMailto('mailto:?to=a%40example.com&to=b%40example.com').to).toEqual(['a@example.com', 'b@example.com']);
    expect(parseExternalMailto('MAILTO:')).toMatchObject({ to: [], subject: '', body: '' });
  });

  it('ignores unsafe sender, attachment, send and arbitrary header parameters', () => {
    expect(parseExternalMailto('mailto:a@example.com?from=admin@example.com&attachment=file:///secret&send=true&X-Test=evil')).toEqual({ kind: 'compose', to: ['a@example.com'], cc: [], bcc: [], subject: '', body: '' });
  });

  it.each([
    'https://example.com', 'mailto:a@example.com?subject=Hello%0ABcc:evil@example.com',
    'mailto:a@example.com%0D%0ABcc:evil@example.com', 'mailto:invalid',
    'mailto:a@example.com?cc=not-an-email', 'mailto:a@example.com?body=%00',
    'mailto:a@example.com?subject=%zz', 'mailto:a@example.com#fragment',
    `mailto:a@example.com?subject=${'x'.repeat(1_001)}`, `mailto:a@example.com?body=${'x'.repeat(50_001)}`,
    `mailto:${Array.from({ length: 101 }, (_, index) => `user${index}@example.com`).join(',')}`,
  ])('rejects invalid, injected or oversized input %s', raw => { expect(() => parseExternalMailto(raw)).toThrow(); });
});

describe('bounded local .ics reading', () => {
  let directory: string;
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'inbox-external-open-')); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it('returns UTF-8 iCalendar text and basename without exposing its full path', async () => {
    const path = join(directory, 'meeting.ICS'); await writeFile(path, `\uFEFF${ics}`);
    expect(await readExternalCalendarFile(path)).toEqual({ text: ics, filename: 'meeting.ICS' });
  });

  it('rejects oversized files before reading their contents', async () => {
    const path = join(directory, 'large.ics'); await writeFile(path, Buffer.alloc(MAX_EXTERNAL_ICS_BYTES + 1));
    await expect(readExternalCalendarFile(path)).rejects.toThrow('smaller than 1 MB');
  });

  it.each(['not a calendar', 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\0', 'BEGIN:VCALENDAR\r\n', 'BEGIN:VEVENT\r\nEND:VEVENT\r\n'])('rejects invalid documents %s', async text => {
    const path = join(directory, 'invalid.ics'); await writeFile(path, text);
    await expect(readExternalCalendarFile(path)).rejects.toThrow('not an iCalendar');
  });

  it('rejects invalid UTF-8', async () => {
    const path = join(directory, 'invalid.ics'); await writeFile(path, Buffer.from([0xff, 0xfe, 0x80]));
    await expect(readExternalCalendarFile(path)).rejects.toThrow('UTF-8');
  });

  it('rejects symlinks and directories rather than following attacker-controlled special files', async () => {
    const source = join(directory, 'source.ics'); const link = join(directory, 'link.ics'); const child = join(directory, 'directory.ics');
    await writeFile(source, ics); await symlink(source, link); await mkdir(child);
    await expect(readExternalCalendarFile(link)).rejects.toThrow('regular local');
    await expect(readExternalCalendarFile(child)).rejects.toThrow('regular local');
  });

  it.each(['relative.ics', '//server/share/meeting.ics', '\\\\server\\share\\meeting.ics', '/tmp/file.txt', '/tmp/line\n.ics'])('rejects remote, relative or invalid paths %s', async path => {
    await expect(readExternalCalendarFile(path)).rejects.toThrow('local .ics');
  });
});

describe('OS launch request queue', () => {
  let next: number;
  const create = () => new ExternalOpenService({ createId: () => `request-${++next}`, readCalendarFile: vi.fn().mockResolvedValue({ text: ics, filename: 'meeting.ics' }) });
  beforeEach(() => { next = 0; });

  it('retains early requests until acknowledged and safely notifies when a renderer arrives', () => {
    const service = create(); service.enqueueUrl('mailto:a@example.com');
    const notify = vi.fn(); service.setNotifier(notify); expect(notify).toHaveBeenCalledOnce();
    const first = service.getPendingOpen(); expect(first).toMatchObject({ id: 'request-1', kind: 'compose', to: ['a@example.com'] });
    expect(service.getPendingOpen()).toEqual(first);
    service.acknowledgeOpen(first!.id); expect(service.getPendingOpen()).toBeNull(); expect(notify).toHaveBeenCalledTimes(2);
  });

  it('returns detached values, deduplicates pending launches and permits opening again after acknowledgement', () => {
    const service = create(); expect(service.enqueueUrl('mailto:a@example.com')).toBe(true); expect(service.enqueueUrl('mailto:a@example.com')).toBe(false);
    const intent = service.getPendingOpen(); if (intent?.kind === 'compose') intent.to.push('injected@example.com');
    expect(service.getPendingOpen()).toMatchObject({ to: ['a@example.com'] });
    service.acknowledgeOpen(intent!.id); expect(service.enqueueUrl('mailto:a@example.com')).toBe(true);
  });

  it('keeps the request if a closed/loading renderer cannot receive notification', () => {
    const service = create(); service.setNotifier(() => { throw new Error('Closed'); });
    expect(() => service.enqueueUrl('mailto:a@example.com')).not.toThrow(); expect(service.getPendingOpen()?.kind).toBe('compose');
  });

  it('does not fetch or silently subscribe to webcal links', () => {
    const service = create(); service.enqueueUrl('webcal://calendar.example.com/team.ics');
    expect(service.getPendingOpen()).toEqual({ id: 'request-1', kind: 'calendar-link', url: 'webcal://calendar.example.com/team.ics' });
  });

  it.each(['webcal://user:secret@example.com/a.ics', 'webcal:///a.ics', 'https://example.com/a.ics', 'webcal://example.com/a\n.ics'])('rejects unsafe or unsupported links %s', raw => {
    expect(() => create().enqueueUrl(raw)).toThrow();
  });

  it('bounds queued requests without discarding an earlier one', () => {
    const service = create(); for (let index = 0; index < MAX_EXTERNAL_OPEN_QUEUE; index++) service.enqueueUrl(`mailto:user${index}@example.com`);
    expect(() => service.enqueueUrl('mailto:overflow@example.com')).toThrow('Too many');
    expect(service.getPendingOpen()).toMatchObject({ to: ['user0@example.com'] });
  });

  it('queues .ics launches from argv without treating flags, relative files or other documents as commands', async () => {
    const service = create();
    expect(await service.enqueueArgv(['/Applications/Inbox', '--evil=mailto:bad@example.com', 'relative.ics', '/tmp/a.txt', 'mailto:a@example.com', pathToFileURL('/tmp/meeting.ics').href])).toEqual({ accepted: 2, rejected: 0 });
    service.acknowledgeOpen(service.getPendingOpen()!.id);
    expect(service.getPendingOpen()).toMatchObject({ kind: 'calendar-import', filename: 'meeting.ics', text: ics });
  });

  it('reports rejected argument counts without exposing raw URL or path content', async () => {
    const service = create(); expect(await service.enqueueArgv(['mailto:invalid', 'file://server/secret.ics', 'mailto:valid@example.com'])).toEqual({ accepted: 1, rejected: 2 });
    expect(service.getPendingOpen()).toMatchObject({ to: ['valid@example.com'] });
  });

  it('deduplicates overlapping async file opens before reading another copy', async () => {
    let finish!: (value: { text: string; filename: string }) => void;
    const read = vi.fn(() => new Promise<{ text: string; filename: string }>(resolve => { finish = resolve; }));
    const service = new ExternalOpenService({ createId: () => 'file', readCalendarFile: read });
    const first = service.enqueueFile('/tmp/meeting.ics'); expect(await service.enqueueFile('/tmp/meeting.ics')).toBe(false);
    finish({ text: ics, filename: 'meeting.ics' }); expect(await first).toBe(true); expect(read).toHaveBeenCalledOnce();
  });

  it('retains original links and in-flight calendar paths during a Keychain restart', async () => {
    let finish!: (value: { text: string; filename: string }) => void;
    const service = new ExternalOpenService({ createId: () => 'request', readCalendarFile: () => new Promise(resolve => { finish = resolve; }) });
    service.enqueueUrl('mailto:person@example.test?body=synthetic-private-text');
    const reading = service.enqueueFile('/tmp/meeting.ics');
    const inputs = service.getPendingLaunchInputs();
    expect(inputs).toEqual(['mailto:person@example.test?body=synthetic-private-text', '/tmp/meeting.ics']);
    inputs.length = 0;
    expect(service.getPendingLaunchInputs()).toHaveLength(2);
    finish({ text: ics, filename: 'meeting.ics' }); await reading;
    expect(service.getPendingLaunchInputs()).toEqual(['mailto:person@example.test?body=synthetic-private-text', '/tmp/meeting.ics']);
  });
});
