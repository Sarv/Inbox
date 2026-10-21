import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { basename, extname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

import emailAddresses from 'email-addresses';

import type { ExternalOpenIntent } from '../../src/types/default-apps';

export const MAX_EXTERNAL_ICS_BYTES = 1_048_576;
export const MAX_EXTERNAL_OPEN_QUEUE = 20;
type PendingIntent = { key: string; intent: ExternalOpenIntent };

function hasControl(value: string, allowBodyWhitespace = false): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if ((code < 32 || code === 127) && !(allowBodyWhitespace && [9, 10, 13].includes(code))) return true;
  }
  return false;
}

function decode(value: string): string {
  try { return decodeURIComponent(value); } catch { throw new Error('The email link contains invalid text encoding.'); }
}

function addresses(value: string): string[] {
  if (!value.trim()) return [];
  if (hasControl(value) || value.length > 16_384) throw new Error('The email link contains invalid recipients.');
  const parsed = emailAddresses.parseAddressList({ input: value, partial: false, strict: true, rfc6532: true });
  if (!parsed?.length || parsed.some(address => address.type !== 'mailbox' || address.address.length > 320)) {
    throw new Error('The email link contains invalid recipients.');
  }
  return parsed.map(address => address.type === 'mailbox' ? address.address : '');
}

export function parseExternalMailto(raw: string): Omit<Extract<ExternalOpenIntent, { kind: 'compose' }>, 'id'> {
  if (typeof raw !== 'string' || raw.length > 65_536 || hasControl(raw) || !/^mailto:/i.test(raw) || raw.includes('#')) {
    throw new Error('The email link is invalid or too large.');
  }
  const content = raw.slice(7);
  const split = content.indexOf('?');
  const recipients = split < 0 ? content : content.slice(0, split);
  const query = split < 0 ? '' : content.slice(split + 1);
  const values = new Map<string, string[]>();
  for (const field of query.split('&')) {
    if (!field) continue;
    const equal = field.indexOf('=');
    const key = decode(equal < 0 ? field : field.slice(0, equal)).toLowerCase();
    // No sender, attachments, arbitrary headers, or automatic send commands may enter the composer.
    if (!['to', 'cc', 'bcc', 'subject', 'body'].includes(key)) continue;
    const value = decode(equal < 0 ? '' : field.slice(equal + 1));
    values.set(key, [...(values.get(key) || []), value]);
  }
  const to = addresses([decode(recipients), ...(values.get('to') || [])].filter(Boolean).join(','));
  const cc = addresses((values.get('cc') || []).join(','));
  const bcc = addresses((values.get('bcc') || []).join(','));
  if (to.length + cc.length + bcc.length > 100) throw new Error('The email link contains too many recipients.');
  const subject = values.get('subject')?.[0] || '';
  const body = values.get('body')?.[0] || '';
  if (subject.length > 1_000 || hasControl(subject) || body.length > 50_000 || hasControl(body, true)) {
    throw new Error('The email link contains invalid or oversized message text.');
  }
  // '+' is intentionally preserved: mailto uses percent encoding, not HTML form encoding.
  return { kind: 'compose', to, cc, bcc, subject, body: body.replace(/\r\n?/g, '\n') };
}

export async function readExternalCalendarFile(path: string): Promise<{ text: string; filename: string }> {
  if (typeof path !== 'string' || !isAbsolute(path) || path.length > 4_096 || hasControl(path) || /^(?:\\\\|\/\/)/.test(path) || extname(path).toLowerCase() !== '.ics') {
    throw new Error('Choose a local .ics calendar file.');
  }
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_EXTERNAL_ICS_BYTES) throw new Error('Calendar imports must be regular local .ics files smaller than 1 MB.');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_EXTERNAL_ICS_BYTES || stat.dev !== before.dev || stat.ino !== before.ino) {
      throw new Error('The calendar file changed while it was being opened. Please open it again.');
    }
    const bytes = Buffer.alloc(MAX_EXTERNAL_ICS_BYTES + 1);
    let total = 0;
    while (total < bytes.length) {
      const result = await handle.read(bytes, total, bytes.length - total, null);
      if (result.bytesRead === 0) break;
      total += result.bytesRead;
    }
    if (total > MAX_EXTERNAL_ICS_BYTES) throw new Error('Calendar imports must be smaller than 1 MB.');
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, total)).replace(/^\uFEFF/, ''); }
    catch { throw new Error('The calendar file must contain valid UTF-8 text.'); }
    if (text.includes('\0') || !/^\s*BEGIN:VCALENDAR\r?\n/i.test(text) || !/\r?\nEND:VCALENDAR\s*$/i.test(text)) {
      throw new Error('The selected file is not an iCalendar document.');
    }
    return { text, filename: basename(path) };
  } finally { await handle.close(); }
}

export interface ExternalOpenDeps {
  readCalendarFile: typeof readExternalCalendarFile;
  createId: () => string;
}

/** OS launch input only. The renderer can read/acknowledge this queue but cannot enqueue files or URLs. */
export class ExternalOpenService {
  private readonly queue: PendingIntent[] = [];
  private notifier: (() => void) | undefined;
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: ExternalOpenDeps = { readCalendarFile: readExternalCalendarFile, createId: randomUUID }) {}

  setNotifier(notifier: (() => void) | undefined): void {
    this.notifier = notifier;
    if (this.queue.length) this.notify();
  }

  getPendingOpen(): ExternalOpenIntent | null {
    const intent = this.queue[0]?.intent;
    return intent ? JSON.parse(JSON.stringify(intent)) as ExternalOpenIntent : null;
  }

  acknowledgeOpen(id: unknown): null {
    if (typeof id !== 'string' || !id || id.length > 200) throw new Error('Choose a valid pending application request.');
    const index = this.queue.findIndex(item => item.intent.id === id);
    if (index >= 0) { this.queue.splice(index, 1); this.notify(); }
    return null;
  }

  enqueueUrl(raw: string): boolean {
    if (typeof raw !== 'string') throw new Error('The application link is invalid.');
    if (/^mailto:/i.test(raw)) return this.enqueue(raw, parseExternalMailto(raw));
    if (!/^webcals?:/i.test(raw) || raw.length > 8_192 || hasControl(raw)) throw new Error('This application link is not supported.');
    let url: URL;
    try { url = new URL(raw); } catch { throw new Error('The calendar link is invalid.'); }
    if (!url.hostname || url.username || url.password || !['webcal:', 'webcals:'].includes(url.protocol)) throw new Error('The calendar link is invalid.');
    // A subscription URL remains a visible, explicit user choice. Never fetch an external calendar on launch.
    return this.enqueue(url.href, { kind: 'calendar-link', url: url.href });
  }

  async enqueueFile(path: string): Promise<boolean> {
    if (this.queue.some(item => item.key === path) || this.inFlight.has(path)) return false;
    if (this.queue.length + this.inFlight.size >= MAX_EXTERNAL_OPEN_QUEUE) throw new Error('Too many application requests are waiting. Finish an open request before opening another.');
    this.inFlight.add(path);
    try {
      const file = await this.deps.readCalendarFile(path);
      return this.enqueue(path, { kind: 'calendar-import', ...file });
    } finally { this.inFlight.delete(path); }
  }

  async enqueueArgv(argv: readonly string[]): Promise<{ accepted: number; rejected: number }> {
    let accepted = 0; let rejected = 0;
    for (const argument of argv.slice(0, 100)) {
      if (typeof argument !== 'string' || argument.startsWith('-')) continue;
      try {
        if (/^(?:mailto|webcals?):/i.test(argument)) { if (this.enqueueUrl(argument)) accepted++; }
        else if (/^file:/i.test(argument)) {
          const url = new URL(argument);
          if (url.hostname) throw new Error('Remote calendar files are not supported.');
          const path = fileURLToPath(url);
          if (extname(path).toLowerCase() === '.ics' && await this.enqueueFile(path)) accepted++;
        } else if (isAbsolute(argument) && extname(argument).toLowerCase() === '.ics' && await this.enqueueFile(argument)) accepted++;
      } catch { rejected++; }
    }
    return { accepted, rejected };
  }

  private enqueue(key: string, payload: Omit<Extract<ExternalOpenIntent, { kind: 'compose' }>, 'id'> | Omit<Extract<ExternalOpenIntent, { kind: 'calendar-import' }>, 'id'> | Omit<Extract<ExternalOpenIntent, { kind: 'calendar-link' }>, 'id'>): boolean {
    if (this.queue.some(item => item.key === key)) return false;
    if (this.queue.length >= MAX_EXTERNAL_OPEN_QUEUE) throw new Error('Too many application requests are waiting. Finish an open request before opening another.');
    this.queue.push({ key, intent: { id: this.deps.createId(), ...payload } });
    this.notify(); return true;
  }

  private notify(): void { try { this.notifier?.(); } catch { /* A closed renderer must not discard a launch request. */ } }
}

let externalOpenService: ExternalOpenService | undefined;
export function getExternalOpenService(): ExternalOpenService {
  return externalOpenService ??= new ExternalOpenService();
}
