/**
 * FakeImapServer — an in-memory IMAP server that satisfies `IIMAPClient`.
 *
 * Exists so sync tests can drive the REAL MessageProcessor / FolderSyncer /
 * SyncEngine against a mailbox whose state the test controls, instead of each
 * test hand-rolling another `vi.fn()` client (three of them had drifted apart
 * before this). It models the parts of IMAP our sync logic actually depends on:
 *
 *   - per-folder UID space, UIDVALIDITY and (optionally) MODSEQ/CONDSTORE
 *   - flags, plus \Deleted + expunge semantics
 *   - append / move / copy with the UID map a real server returns
 *   - the SELECT-scoped view: fetches only ever see the selected folder
 *
 * Deliberately NOT modelled: the wire protocol, literals, partial fetches,
 * server-side search beyond simple criteria. Those belong to imapflow, which we
 * don't re-test here.
 *
 * Usage:
 *
 *   const server = new FakeImapServer();
 *   server.addFolder('INBOX', { uidValidity: 1 });
 *   server.addMessage('INBOX', { subject: 'hi', flags: ['\\Seen'] });
 *   await server.selectFolder('INBOX');
 *   // hand `server` anywhere an IIMAPClient is expected
 *
 * Every mutation helper is synchronous so a test can express "the server changed
 * while we weren't looking" without awaiting anything.
 */

import { AsyncLocalStorage } from 'async_hooks';
import { EventEmitter } from 'events';

import type {
  FetchOptions,
  FlagChange,
  FolderStatus,
  IMAPConfig,
  IMAPEvent,
  IMAPFolder,
  IMAPMessage,
  SearchCriteria,
} from '../types/imap';
import { createMutex, type Mutex } from '../utils/mutex';

export interface FakeMessageInit {
  /** Assigned automatically from the folder's uidNext when omitted. */
  uid?: number;
  messageId?: string;
  subject?: string;
  from?: string;
  to?: string[];
  date?: Date;
  flags?: string[];
  /** Raw RFC822 source. Synthesised from the headers above when omitted. */
  body?: string;
  /** Gmail-style labels, surfaced via fetch when the server advertises labels. */
  labels?: string[];
  /** Threading headers, surfaced in the fetched ENVELOPE. */
  inReplyTo?: string | null;
  references?: string[];
}

export interface FakeMessage {
  uid: number;
  messageId: string;
  subject: string;
  from: string;
  to: string[];
  date: Date;
  flags: Set<string>;
  body: string;
  labels: string[];
  modseq: number;
  inReplyTo?: string | null;
  references?: string[];
}

export interface FakeFolderInit {
  uidValidity?: number;
  /** Advertised in listFolders (\\Trash, \\Sent, …). */
  specialUse?: string;
  subscribed?: boolean;
}

interface FakeFolder {
  path: string;
  uidValidity: number;
  uidNext: number;
  specialUse?: string;
  subscribed: boolean;
  messages: FakeMessage[];
  /** Highest MODSEQ handed out in this folder. */
  highestModseq: number;
  /** Expunged UIDs since the folder was created, for QRESYNC vanished reporting. */
  vanished: number[];
}

/**
 * What a NOOP health probe should do. `hang` never settles — that's how a
 * "zombie" socket behaves (looks open, answers nothing) and is what the
 * ConnectionManager health check / verifyConnection timeouts are for.
 */
export type FakeNoopBehavior = 'alive' | 'dead' | 'throw' | 'hang';

/** What disconnect() should do — `hang` models a socket that never closes. */
export type FakeDisconnectBehavior = 'resolve' | 'hang' | 'throw';

/** One scripted connect() outcome: an Error to throw, 'hang' to never settle, null to succeed. */
export type FakeConnectOutcome = Error | 'hang' | null;

export interface FakeImapServerOptions {
  condstore?: boolean;
  qresync?: boolean;
  gmailLabels?: boolean;
  keywords?: boolean;
  idle?: boolean;
  hierarchyDelimiter?: string;
  capabilities?: string[];
  /**
   * Host this server reports while connected. Defaults to a neutral
   * third-party host; pass a sarv.com host to exercise the paths that only run
   * on OUR OWN server (the bare-keyword label strategy and its one-time
   * `Sarv Inbox/*` cleanup).
   */
  host?: string;
  /**
   * Opt-in socket-event support. When true, on/off/once/removeAllListeners
   * delegate to a real EventEmitter so a test can drive the low-level
   * 'end'/'error' events the ConnectionManager listens for (and assert that a
   * torn-down client's listeners were really detached). Off by default so the
   * existing no-op listener behaviour is unchanged.
   */
  events?: boolean;
  /**
   * Opt-in NOOP probe. Absent by default, matching a client that has no
   * `noop()` at all (the ConnectionManager has a separate code path for that).
   */
  noop?: FakeNoopBehavior;
}

let messageIdSeq = 0;

/** Deterministic message-id — tests must not depend on randomness or the clock. */
function nextMessageId(): string {
  messageIdSeq += 1;
  return `<fake-${messageIdSeq}@test.local>`;
}

/** Reset the message-id counter so ids are stable per test file. */
export function resetFakeMessageIds(): void {
  messageIdSeq = 0;
}

function buildRawSource(m: Omit<FakeMessage, 'modseq'>): string {
  return [
    `Message-ID: ${m.messageId}`,
    `Subject: ${m.subject}`,
    `From: ${m.from}`,
    `To: ${m.to.join(', ')}`,
    `Date: ${m.date.toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    '',
    `Body of ${m.subject}`,
    '',
  ].join('\r\n');
}

export class FakeImapServer {
  private folders = new Map<string, FakeFolder>();
  private selected: string | null = null;
  /** Mailbox lock — same contract as the real client's. See `withFolder`. */
  private readonly mailboxMutex: Mutex = createMutex();
  private readonly folderLockHeld = new AsyncLocalStorage<true>();
  private connected = false;
  private idleCallback: ((event: IMAPEvent) => void) | null = null;
  private opts: Required<Omit<FakeImapServerOptions, 'capabilities' | 'noop'>> & {
    capabilities: string[];
    noop?: FakeNoopBehavior;
  };

  /** Backing emitter for the opt-in socket events (see FakeImapServerOptions.events). */
  private readonly socket = new EventEmitter();
  /** Queued connect() outcomes, consumed one per connect (see scriptConnect). */
  private connectOutcomes: FakeConnectOutcome[] = [];
  private disconnectBehavior: FakeDisconnectBehavior = 'resolve';
  private noopBehavior: FakeNoopBehavior | null = null;

  /**
   * NOOP health probe. Deliberately an OPTIONAL property, not a method: a
   * ConnectionManager branches on `typeof client.noop === 'function'`, so the
   * default fake must genuinely not have one. Enable with `{ noop: 'alive' }`
   * or setNoop().
   */
  noop?: () => Promise<boolean>;

  /** Every method call, in order — lets a test assert "we never re-fetched". */
  readonly calls: string[] = [];

  constructor(options: FakeImapServerOptions = {}) {
    this.opts = {
      condstore: options.condstore ?? false,
      qresync: options.qresync ?? false,
      gmailLabels: options.gmailLabels ?? false,
      keywords: options.keywords ?? true,
      idle: options.idle ?? true,
      hierarchyDelimiter: options.hierarchyDelimiter ?? '/',
      capabilities: options.capabilities ?? ['IMAP4rev1'],
      events: options.events ?? false,
      host: options.host ?? 'imap.test.local',
      ...(options.noop ? { noop: options.noop } : {}),
    };
    if (options.noop) this.setNoop(options.noop);
  }

  // ── Test-side control surface ─────────────────────────────────────────

  addFolder(path: string, init: FakeFolderInit = {}): void {
    this.folders.set(path, {
      path,
      uidValidity: init.uidValidity ?? 1,
      uidNext: 1,
      specialUse: init.specialUse,
      subscribed: init.subscribed ?? true,
      messages: [],
      highestModseq: 1,
      vanished: [],
    });
  }

  /** Append a message as the SERVER would, returning its assigned UID. */
  addMessage(path: string, init: FakeMessageInit = {}): number {
    const folder = this.requireFolder(path);
    const uid = init.uid ?? folder.uidNext;
    folder.uidNext = Math.max(folder.uidNext, uid + 1);
    folder.highestModseq += 1;
    const base = {
      uid,
      messageId: init.messageId ?? nextMessageId(),
      subject: init.subject ?? `Message ${uid}`,
      from: init.from ?? 'sender@test.local',
      to: init.to ?? ['me@test.local'],
      date: init.date ?? new Date(Date.UTC(2026, 0, 1, 0, 0, uid % 60)),
      flags: new Set(init.flags ?? []),
      body: '',
      labels: init.labels ?? [],
    };
    const message: FakeMessage = {
      ...base,
      body: init.body ?? buildRawSource(base),
      modseq: folder.highestModseq,
      inReplyTo: init.inReplyTo ?? null,
      references: init.references ?? [],
    };
    folder.messages.push(message);
    return uid;
  }

  /** Bulk helper: append `count` messages and return their UIDs. */
  addMessages(path: string, count: number, init: FakeMessageInit = {}): number[] {
    return Array.from({ length: count }, () => this.addMessage(path, init));
  }

  /** Server-side flag change (as if another client did it). */
  setFlagsOnServer(path: string, uid: number, flags: string[]): void {
    const message = this.requireMessage(path, uid);
    message.flags = new Set(flags);
    const folder = this.requireFolder(path);
    folder.highestModseq += 1;
    message.modseq = folder.highestModseq;
  }

  /** Server-side expunge (as if another client deleted it). */
  expungeOnServer(path: string, uid: number): void {
    const folder = this.requireFolder(path);
    const index = folder.messages.findIndex((m) => m.uid === uid);
    if (index === -1) return;
    folder.messages.splice(index, 1);
    folder.vanished.push(uid);
    folder.highestModseq += 1;
  }

  /**
   * Bump UIDVALIDITY and re-key every message, exactly like a server that lost
   * its UID space — the scenario that must never corrupt local flags.
   */
  bumpUidValidity(path: string, newValidity?: number): void {
    const folder = this.requireFolder(path);
    folder.uidValidity = newValidity ?? folder.uidValidity + 1;
    folder.uidNext = 1;
    folder.messages = folder.messages.map((m) => ({ ...m, uid: folder.uidNext++ }));
  }

  /** Emit an IDLE event to whatever registered via startIdle(). */
  emitIdle(event: IMAPEvent): void {
    this.idleCallback?.(event);
  }

  /**
   * Emit a socket-level event ('end', 'close', 'error') at whoever attached via
   * `on()` — only meaningful with `{ events: true }`. A single real socket drop
   * fires BOTH 'error' and 'end', which is exactly the double-trigger the
   * ConnectionManager must collapse into one reconnect ladder.
   */
  emitSocketEvent(event: string, ...args: unknown[]): void {
    this.socket.emit(event, ...args);
  }

  /** How many listeners are attached for a socket event (leak/stacking checks). */
  socketListenerCount(event: string): number {
    return this.socket.listenerCount(event);
  }

  /**
   * Script the next connect() calls: an Error rejects, 'hang' never settles,
   * null succeeds. Anything past the script succeeds as usual.
   */
  scriptConnect(...outcomes: FakeConnectOutcome[]): void {
    this.connectOutcomes.push(...outcomes);
  }

  /** Sugar over scriptConnect for "the next N connects fail the same way". */
  failNextConnect(error: Error, times = 1): void {
    this.scriptConnect(...Array.from({ length: times }, () => error));
  }

  /** Make disconnect() hang (socket never closes) or throw, instead of resolving. */
  setDisconnectBehavior(behavior: FakeDisconnectBehavior): void {
    this.disconnectBehavior = behavior;
  }

  /** Enable (or change) the NOOP health probe — see the `noop` property. */
  setNoop(behavior: FakeNoopBehavior): void {
    this.noopBehavior = behavior;
    this.noop = async () => {
      this.note('noop');
      switch (this.noopBehavior) {
        case 'dead':
          return false;
        case 'throw':
          throw new Error('NOOP failed: connection ended');
        case 'hang':
          return new Promise<boolean>(() => { /* never settles — zombie socket */ });
        default:
          return true;
      }
    };
  }

  messageCount(path: string): number {
    return this.requireFolder(path).messages.length;
  }

  uidsIn(path: string): number[] {
    return this.requireFolder(path).messages.map((m) => m.uid).sort((a, b) => a - b);
  }

  flagsOf(path: string, uid: number): string[] {
    return [...this.requireMessage(path, uid).flags].sort();
  }

  /** How many times a method was called — for "no redundant fetch" assertions. */
  callCount(method: string): number {
    return this.calls.filter((c) => c === method).length;
  }

  private requireFolder(path: string): FakeFolder {
    const folder = this.folders.get(path);
    if (!folder) throw new Error(`FakeImapServer: no such folder "${path}"`);
    return folder;
  }

  private requireMessage(path: string, uid: number): FakeMessage {
    const message = this.requireFolder(path).messages.find((m) => m.uid === uid);
    if (!message) throw new Error(`FakeImapServer: no UID ${uid} in "${path}"`);
    return message;
  }

  private requireSelected(): FakeFolder {
    if (!this.selected) throw new Error('FakeImapServer: no folder selected');
    return this.requireFolder(this.selected);
  }

  /**
   * Same contract as the real client's `ensureCurrentFolder`: a whole-mailbox
   * enumeration that a caller attributes to a named folder must fail loudly when
   * the connection has some OTHER mailbox open. Keeping the fake honest here is
   * what lets a test reproduce the 2026-09-13 cross-mailbox reconcile without a
   * live server.
   */
  private requireSelectedPath(expectedPath?: string): FakeFolder {
    const folder = this.requireSelected();
    if (expectedPath && this.selected !== expectedPath) {
      throw new Error(
        `Mailbox mismatch: connection has "${this.selected}" selected, not "${expectedPath}"`,
      );
    }
    return folder;
  }

  private note(method: string): void {
    this.calls.push(method);
  }

  private toImapMessage(m: FakeMessage, options?: FetchOptions): IMAPMessage {
    return {
      uid: m.uid,
      seqNo: this.requireSelected().messages.indexOf(m) + 1,
      flags: [...m.flags],
      // A COMPLETE envelope, every list present. MessageProcessor.convertMessage
      // reads `envelope.references.length` and `message.date.getTime()`
      // unguarded (a real fetch always supplies them), so a partial envelope
      // here would make the ingest path throw instead of exercising it.
      envelope: {
        messageId: m.messageId,
        inReplyTo: m.inReplyTo ?? null,
        references: m.references ?? [],
        subject: m.subject,
        from: [{ address: m.from, name: '' }],
        replyTo: [],
        to: m.to.map((address) => ({ address, name: '' })),
        cc: [],
        bcc: [],
        date: m.date,
      },
      date: m.date,
      internalDate: m.date,
      size: m.body.length,
      // Headers-only fetches (fetchBody omitted/false) must NOT carry a body —
      // the backfill and envelope paths rely on that to stay cheap, and a fake
      // that always returns one would hide a regression there.
      ...(options?.fetchBody === false ? {} : { body: m.body }),
      ...(this.opts.gmailLabels && m.labels.length ? { labels: m.labels } : {}),
    } as unknown as IMAPMessage;
  }

  // ── IIMAPClient ───────────────────────────────────────────────────────

  get host(): string | null {
    return this.connected ? (this.opts.host ?? 'imap.test.local') : null;
  }

  async connect(_config?: IMAPConfig): Promise<void> {
    this.note('connect');
    const scripted = this.connectOutcomes.shift();
    if (scripted === 'hang') return new Promise<void>(() => { /* never settles */ });
    if (scripted) throw scripted;
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.note('disconnect');
    if (this.disconnectBehavior === 'hang') {
      return new Promise<void>(() => { /* socket never closes */ });
    }
    this.connected = false;
    this.selected = null;
    if (this.disconnectBehavior === 'throw') throw new Error('disconnect failed');
  }

  isConnected(): boolean {
    return this.connected;
  }

  async listFolders(): Promise<IMAPFolder[]> {
    this.note('listFolders');
    return [...this.folders.values()].map((f) => ({
      name: f.path.split(this.opts.hierarchyDelimiter).pop() ?? f.path,
      path: f.path,
      delimiter: this.opts.hierarchyDelimiter,
      specialUse: f.specialUse,
      subscribed: f.subscribed,
      messageCount: f.messages.length,
      unseenCount: f.messages.filter((m) => !m.flags.has('\\Seen')).length,
    })) as unknown as IMAPFolder[];
  }

  async selectFolder(folderPath: string): Promise<FolderStatus> {
    // Queue behind any in-flight withFolder section, exactly as the real client
    // does — this is what makes a barging re-select wait rather than corrupt.
    if (!this.folderLockHeld.getStore()) {
      return this.mailboxMutex.runExclusive(() =>
        this.folderLockHeld.run(true, () => this.selectFolderUnlocked(folderPath)),
      );
    }
    return this.selectFolderUnlocked(folderPath);
  }

  private async selectFolderUnlocked(folderPath: string): Promise<FolderStatus> {
    this.note('selectFolder');
    const folder = this.requireFolder(folderPath);
    this.selected = folderPath;
    return {
      path: folder.path,
      exists: folder.messages.length,
      // `messages` is the FolderStatus field the sync paths actually read
      // (FolderSyncer uses boxStatus.messages); `exists` is kept as the IMAP
      // spelling some call sites use. Both always agree.
      messages: folder.messages.length,
      recent: 0,
      permanentFlags: ['\\Seen', '\\Flagged', '\\Answered', '\\Draft', '\\Deleted'],
      readOnly: false,
      uidNext: folder.uidNext,
      uidValidity: folder.uidValidity,
      unseen: folder.messages.filter((m) => !m.flags.has('\\Seen')).length,
      ...(this.opts.condstore ? { highestModseq: folder.highestModseq } : {}),
    } as unknown as FolderStatus;
  }

  async ensureFolderSelected(folderPath: string): Promise<void> {
    if (this.selected !== folderPath) await this.selectFolder(folderPath);
  }

  /**
   * Mirror the real client's mailbox lock (see `ImapFlowClient.withFolder`): the
   * section holds the selection, and any concurrent select on this same fake
   * connection queues behind it instead of landing mid-sequence. Without this the
   * fake would let a test pass that the real client would fail — and the whole
   * point of the fake is to reproduce the cross-mailbox race offline.
   */
  async withFolder<T>(
    folderPath: string,
    fn: () => Promise<T>,
    opts?: { select?: boolean },
  ): Promise<T> {
    this.note('withFolder');
    const body = async (): Promise<T> => {
      // `ensureFolderSelected` is the cheap fast path (skip the SELECT when the
      // mailbox is already open), but it is OPTIONAL on IIMAPClient — a lease or
      // a leaner client may not have it, and a test stubs it out to prove the
      // fallback still works. Degrade to a plain SELECT rather than throwing.
      if (opts?.select !== false) {
        if (typeof this.ensureFolderSelected === 'function') await this.ensureFolderSelected(folderPath);
        else await this.selectFolder(folderPath);
      }
      return fn();
    };
    if (this.folderLockHeld.getStore()) return body();
    return this.mailboxMutex.runExclusive(() => this.folderLockHeld.run(true, body));
  }

  getCurrentFolder(): string | null {
    return this.selected;
  }

  async getFolderStatus(folderPath: string) {
    this.note('getFolderStatus');
    const folder = this.requireFolder(folderPath);
    return {
      uidNext: folder.uidNext,
      messages: folder.messages.length,
      uidValidity: folder.uidValidity,
      unseen: folder.messages.filter((m) => !m.flags.has('\\Seen')).length,
      ...(this.opts.condstore ? { highestModseq: folder.highestModseq } : {}),
    };
  }

  async fetchMessages(range: string, options?: FetchOptions): Promise<IMAPMessage[]> {
    this.note('fetchMessages');
    const folder = this.requireSelected();
    // Sequence ranges only ("1:*", "5:20") — that's all the sync paths use.
    const [loRaw, hiRaw] = range.split(':');
    const lo = Number(loRaw) || 1;
    const hi = hiRaw === '*' || hiRaw === undefined ? folder.messages.length : Number(hiRaw);
    return folder.messages.slice(lo - 1, hi).map((m) => this.toImapMessage(m, options));
  }

  async fetchMessagesByUID(uids: number[], options?: FetchOptions): Promise<IMAPMessage[]> {
    this.note('fetchMessagesByUID');
    const folder = this.requireSelected();
    return folder.messages
      .filter((m) => uids.includes(m.uid))
      .map((m) => this.toImapMessage(m, options));
  }

  async fetchMessagesByUidRange(lo: number, hi: number, options?: FetchOptions): Promise<IMAPMessage[]> {
    this.note('fetchMessagesByUidRange');
    const folder = this.requireSelected();
    return folder.messages
      .filter((m) => m.uid >= lo && m.uid <= hi)
      .map((m) => this.toImapMessage(m, options));
  }

  async getNewMessages(sinceUID: number, options?: FetchOptions): Promise<IMAPMessage[]> {
    this.note('getNewMessages');
    const folder = this.requireSelected();
    return folder.messages
      .filter((m) => m.uid > sinceUID)
      .map((m) => this.toImapMessage(m, options));
  }

  async fetchMessage(uid: number, options?: FetchOptions): Promise<IMAPMessage | null> {
    this.note('fetchMessage');
    const folder = this.requireSelected();
    const message = folder.messages.find((m) => m.uid === uid);
    return message ? this.toImapMessage(message, options) : null;
  }

  async fetchFlagsOnly(
    uids: number[],
    onBatch?: () => void,
    expectedPath?: string,
  ): Promise<Array<{ uid: number; flags: string[] }>> {
    this.note('fetchFlagsOnly');
    const folder = this.requireSelectedPath(expectedPath);
    // Mirror the real client's batched fetch (imapflow-client batches in 500s and
    // fires onBatch after each) so a caller relying on the per-batch progress
    // heartbeat exercises the same shape here — otherwise a whole-mailbox re-read
    // would look like one indivisible step and the heartbeat would go untested.
    const BATCH = 500;
    const out: Array<{ uid: number; flags: string[] }> = [];
    for (let i = 0; i < uids.length; i += BATCH) {
      const slice = new Set(uids.slice(i, i + BATCH));
      for (const message of folder.messages) {
        if (slice.has(message.uid)) out.push({ uid: message.uid, flags: [...message.flags] });
      }
      onBatch?.();
    }
    return out;
  }

  async fetchAllFlags(expectedPath?: string): Promise<Array<{ uid: number; flags: string[] }>> {
    this.note('fetchAllFlags');
    return this.requireSelectedPath(expectedPath).messages.map((m) => ({ uid: m.uid, flags: [...m.flags] }));
  }

  /** Labels for every message in the selected folder; empty without the ext. */
  async fetchAllLabels(expectedPath?: string): Promise<Array<{ uid: number; labels: string[] }>> {
    this.note('fetchAllLabels');
    if (!this.opts.gmailLabels) return [];
    return this.requireSelectedPath(expectedPath).messages.map((m) => ({ uid: m.uid, labels: [...m.labels] }));
  }

  async fetchAllUIDs(expectedPath?: string): Promise<number[]> {
    this.note('fetchAllUIDs');
    return this.requireSelectedPath(expectedPath).messages.map((m) => m.uid);
  }

  async fetchUidsSince(since: Date, expectedPath?: string): Promise<number[]> {
    this.note('fetchUidsSince');
    return this.requireSelectedPath(expectedPath)
      .messages.filter((m) => m.date >= since)
      .map((m) => m.uid);
  }

  async fetchMessageIdToUidMap(expectedPath?: string): Promise<Map<string, number>> {
    this.note('fetchMessageIdToUidMap');
    return new Map(this.requireSelectedPath(expectedPath).messages.map((m) => [m.messageId, m.uid]));
  }

  supportsCondstore(): boolean {
    return this.opts.condstore;
  }

  supportsQresync(): boolean {
    return this.opts.qresync;
  }

  async selectFolderWithCondstore(folderPath: string): Promise<FolderStatus> {
    this.note('selectFolderWithCondstore');
    return this.selectFolder(folderPath);
  }

  /**
   * QRESYNC SELECT. Reports VANISHED (EARLIER) only when the caller's
   * (uidValidity, modseq) can be resynchronised from — a validity mismatch means
   * the server's UID space is gone, so it must report NO vanished list and let
   * the caller re-key instead of deleting by stale UID.
   */
  async selectFolderWithQresync(
    folderPath: string,
    uidValidity: number,
    _modseq: number,
  ): Promise<{ status: FolderStatus; vanishedUids: number[] }> {
    this.note('selectFolderWithQresync');
    const status = await this.selectFolder(folderPath);
    const folder = this.requireFolder(folderPath);
    const resyncable = uidValidity === folder.uidValidity;
    return { status, vanishedUids: resyncable ? [...folder.vanished] : [] };
  }

  async fetchFlagsChangedSince(modseq: number): Promise<FlagChange[]> {
    this.note('fetchFlagsChangedSince');
    return this.requireSelected()
      .messages.filter((m) => m.modseq > modseq)
      .map((m) => ({ uid: m.uid, flags: [...m.flags], modseq: m.modseq })) as unknown as FlagChange[];
  }

  getCurrentMailboxState() {
    const folder = this.selected ? this.folders.get(this.selected) : null;
    if (!folder) return null;
    return {
      path: folder.path,
      exists: folder.messages.length,
      uidValidity: folder.uidValidity,
      uidNext: folder.uidNext,
      ...(this.opts.condstore ? { highestModseq: folder.highestModseq } : {}),
    };
  }

  async appendMessage(folderPath: string, rawMessage: string | Buffer, flags?: string[]): Promise<number> {
    this.note('appendMessage');
    const source = typeof rawMessage === 'string' ? rawMessage : rawMessage.toString('utf8');
    const messageId = /^Message-ID:\s*(.+)$/im.exec(source)?.[1]?.trim();
    const subject = /^Subject:\s*(.*)$/im.exec(source)?.[1]?.trim();
    return this.addMessage(folderPath, {
      ...(messageId ? { messageId } : {}),
      ...(subject ? { subject } : {}),
      flags: flags ?? [],
      body: source,
    });
  }

  async addFlags(uids: number[], flags: string[]): Promise<void> {
    this.note('addFlags');
    const folder = this.requireSelected();
    for (const m of folder.messages) {
      if (!uids.includes(m.uid)) continue;
      for (const f of flags) m.flags.add(f);
      folder.highestModseq += 1;
      m.modseq = folder.highestModseq;
    }
  }

  async removeFlags(uids: number[], flags: string[]): Promise<void> {
    this.note('removeFlags');
    const folder = this.requireSelected();
    for (const m of folder.messages) {
      if (!uids.includes(m.uid)) continue;
      for (const f of flags) m.flags.delete(f);
      folder.highestModseq += 1;
      m.modseq = folder.highestModseq;
    }
  }

  async setFlags(uids: number[], flags: string[]): Promise<void> {
    this.note('setFlags');
    const folder = this.requireSelected();
    for (const m of folder.messages) {
      if (uids.includes(m.uid)) m.flags = new Set(flags);
    }
  }

  async removeGmailLabels(uids: number[], labels: string[]): Promise<void> {
    this.note('removeGmailLabels');
    for (const m of this.requireSelected().messages) {
      if (uids.includes(m.uid)) m.labels = m.labels.filter((l) => !labels.includes(l));
    }
  }

  /** Returns the source→destination UID map, like a server with UIDPLUS. */
  async moveMessages(uids: number[], destinationFolder: string): Promise<Map<number, number>> {
    this.note('moveMessages');
    const source = this.requireSelected();
    const map = new Map<number, number>();
    for (const uid of uids) {
      const index = source.messages.findIndex((m) => m.uid === uid);
      if (index === -1) continue;
      const [moved] = source.messages.splice(index, 1);
      source.vanished.push(uid);
      const newUid = this.addMessage(destinationFolder, {
        messageId: moved.messageId,
        subject: moved.subject,
        from: moved.from,
        to: moved.to,
        date: moved.date,
        flags: [...moved.flags],
        body: moved.body,
      });
      map.set(uid, newUid);
    }
    return map;
  }

  async copyMessages(uids: number[], destinationFolder: string): Promise<void> {
    this.note('copyMessages');
    for (const m of this.requireSelected().messages) {
      if (!uids.includes(m.uid)) continue;
      this.addMessage(destinationFolder, {
        messageId: m.messageId,
        subject: m.subject,
        from: m.from,
        to: m.to,
        date: m.date,
        flags: [...m.flags],
        body: m.body,
      });
    }
  }

  async createMailbox(path: string): Promise<void> {
    this.note('createMailbox');
    if (!this.folders.has(path)) this.addFolder(path);
  }

  async renameMailbox(oldPath: string, newPath: string): Promise<void> {
    this.note('renameMailbox');
    const folder = this.requireFolder(oldPath);
    this.folders.delete(oldPath);
    this.folders.set(newPath, { ...folder, path: newPath });
  }

  async deleteMailbox(path: string): Promise<void> {
    this.note('deleteMailbox');
    this.folders.delete(path);
  }

  async listMailboxPaths(): Promise<string[]> {
    return [...this.folders.keys()];
  }

  supportsGmailLabels(): boolean {
    return this.opts.gmailLabels;
  }

  async supportsKeywords(): Promise<boolean> {
    return this.opts.keywords;
  }

  async getHierarchyDelimiter(): Promise<string> {
    return this.opts.hierarchyDelimiter;
  }

  /** \\Deleted only — the message stays until expunge(), as on a real server. */
  async deleteMessages(uids: number[]): Promise<void> {
    this.note('deleteMessages');
    await this.addFlags(uids, ['\\Deleted']);
  }

  async expunge(): Promise<void> {
    this.note('expunge');
    const folder = this.requireSelected();
    const gone = folder.messages.filter((m) => m.flags.has('\\Deleted')).map((m) => m.uid);
    folder.messages = folder.messages.filter((m) => !m.flags.has('\\Deleted'));
    folder.vanished.push(...gone);
    if (gone.length) folder.highestModseq += 1;
  }

  async deleteAndExpunge(uids: number[]): Promise<void> {
    this.note('deleteAndExpunge');
    await this.deleteMessages(uids);
    await this.expunge();
  }

  async startIdle(callback: (event: IMAPEvent) => void): Promise<void> {
    this.note('startIdle');
    this.idleCallback = callback;
  }

  async stopIdle(): Promise<void> {
    this.note('stopIdle');
    this.idleCallback = null;
  }

  supportsIdle(): boolean {
    return this.opts.idle;
  }

  async search(criteria: SearchCriteria): Promise<number[]> {
    this.note('search');
    const folder = this.requireSelected();
    const c = criteria as Record<string, unknown>;
    return folder.messages
      .filter((m) => {
        if (typeof c.subject === 'string' && !m.subject.toLowerCase().includes(c.subject.toLowerCase())) return false;
        if (typeof c.from === 'string' && !m.from.toLowerCase().includes(c.from.toLowerCase())) return false;
        if (c.seen === true && !m.flags.has('\\Seen')) return false;
        if (c.seen === false && m.flags.has('\\Seen')) return false;
        if (c.since instanceof Date && m.date < c.since) return false;
        // HEADER <name> <value>: real servers SUBSTRING-match the raw header
        // value, which is why callers search a message-id WITHOUT its angle
        // brackets. Modelled the same way so that behaviour stays testable.
        if (Array.isArray(c.header)) {
          for (const h of c.header as Array<{ name: string; value: string }>) {
            const line = new RegExp(`^${h.name}:\\s*(.*)$`, 'im').exec(m.body)?.[1] ?? '';
            if (!line.toLowerCase().includes((h.value || '').toLowerCase())) return false;
          }
        }
        return true;
      })
      .map((m) => m.uid);
  }

  async getCapabilities(): Promise<string[]> {
    return [...this.opts.capabilities];
  }

  hasCapability(capability: string): boolean {
    return this.opts.capabilities.includes(capability);
  }

  // Listener plumbing. No-ops unless the fake was built with `{ events: true }`,
  // which routes them to a real EventEmitter so socket events can be driven.
  on(event?: string, listener?: (...args: any[]) => void): this {
    if (this.opts.events && event && listener) this.socket.on(event, listener);
    return this;
  }

  off(event?: string, listener?: (...args: any[]) => void): this {
    if (this.opts.events && event && listener) this.socket.off(event, listener);
    return this;
  }

  once(event?: string, listener?: (...args: any[]) => void): this {
    if (this.opts.events && event && listener) this.socket.once(event, listener);
    return this;
  }

  removeAllListeners(event?: string): this {
    // Node's removeAllListeners keys off arguments.length, so passing an
    // explicit `undefined` would remove NOTHING — callers that detach a stale
    // client call it with no arguments at all.
    if (!this.opts.events) return this;
    if (event === undefined) this.socket.removeAllListeners();
    else this.socket.removeAllListeners(event);
    return this;
  }

  setShuttingDown(): void {
    /* no-op: nothing async to silence in the fake */
  }
}
