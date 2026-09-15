// IMAP client interface for Sarv Inbox

/**
 * IMAP client interface - platform-agnostic
 */
export interface IIMAPClient {
  // ========== Connection ==========

  /**
   * Host this client last connected to (e.g. `imap.sarv.com`). Lets
   * provider-specific logic (label-strategy) resolve the server without the
   * caller having to thread the host through every call. Null before connect.
   */
  readonly host?: string | null;

  /**
   * Connect to IMAP server
   */
  connect(config: IMAPConfig): Promise<void>;

  /**
   * Disconnect from IMAP server
   */
  disconnect(): Promise<void>;

  /**
   * Check if connected
   */
  isConnected(): boolean;

  /**
   * Liveness probe: send an IMAP NOOP and resolve true if the server answered,
   * false if the connection is dead. Optional — callers must branch on its
   * presence. Used to VALIDATE a pooled connection before reuse (a silently
   * dropped idle socket still reads `isConnected() === true`).
   */
  noop?(): Promise<boolean>;

  /**
   * Total bytes read off this connection's socket since it was opened. Only
   * whether it CHANGES matters — it is the progress signal that tells a slow
   * transfer apart from a hung one, so a long body download is not killed by a
   * fixed timeout (see `withStallTimeout`). Optional: callers must branch on
   * its presence, and an implementation that cannot report it should omit it
   * rather than return a constant, which would read as a permanent stall.
   */
  bytesReceived?(): number;

  // ========== Folder Operations ==========

  /**
   * List all folders
   */
  listFolders(): Promise<IMAPFolder[]>;

  /**
   * Select a folder (mailbox)
   */
  selectFolder(folderPath: string): Promise<FolderStatus>;

  /**
   * Cheapest "ensure this mailbox is selected" for latency-sensitive flag ops:
   * no-ops when already open on the mailbox and skips the STATUS(unseen)
   * round-trip. Optional — callers must fall back to selectFolder when absent.
   */
  ensureFolderSelected?(folderPath: string): Promise<void>;

  /**
   * Run `fn` with `folderPath` selected AND held selected for its whole
   * duration, so a concurrent user of the same connection cannot re-select in
   * between two of `fn`'s commands. Any operation that issues more than one
   * command against a mailbox must use this rather than `selectFolder` + work.
   * Optional on the interface — use the `withFolderSelected` helper, which
   * falls back to a plain select for clients that don't implement it.
   */
  withFolder?<T>(
    folderPath: string,
    fn: () => Promise<T>,
    opts?: { select?: boolean },
  ): Promise<T>;

  /**
   * Get current selected folder
   */
  getCurrentFolder(): string | null;

  /**
   * Get folder status using IMAP STATUS command (always fresh from server).
   *
   * `highestModseq` is present only on CONDSTORE servers. It is the one field
   * that moves on ANY flag change (\Flagged included), which is what lets the
   * non-INBOX drift sweep notice a star removed in webmail — `unseen` and
   * `messages` cannot see that at all.
   */
  getFolderStatus(folderPath: string): Promise<{ uidNext: number; messages: number; uidValidity: number; unseen: number; highestModseq?: number }>;

  /**
   * Mailbox storage quota (RFC 2087), in BYTES. Resolves to null when the server
   * doesn't advertise QUOTA or reports no meaningful limit. Optional — impls/fakes
   * that omit it are treated as "no quota info".
   */
  getQuota?(path?: string): Promise<{ used: number; limit: number } | null>;

  /**
   * Download a SINGLE MIME part by its part number (BODY[part]) for the given UID,
   * returning the DECODED bytes — so opening one attachment doesn't pull the whole
   * message. Requires the folder to be selected first. Optional (impls/fakes that
   * omit it fall back to the whole-message path). Null when the part can't be read.
   */
  downloadPart?(uid: number, part: string): Promise<Buffer | null>;

  /**
   * The same part, WITHOUT reversing its transfer encoding — the escape hatch for
   * a part whose `Content-Transfer-Encoding` header lies (raw text declared
   * `base64`). Optional; callers only reach for it when the decoded bytes are
   * implausibly short against the size the server declared.
   */
  downloadPartRaw?(uid: number, part: string): Promise<Buffer | null>;

  // ========== Message Fetch ==========

  /**
   * Fetch messages by sequence range
   * @param range - e.g., "1:10" or "1:*"
   */
  fetchMessages(range: string, options?: FetchOptions): Promise<IMAPMessage[]>;

  /**
   * Fetch messages by UIDs
   */
  fetchMessagesByUID(
    uids: number[],
    options?: FetchOptions
  ): Promise<IMAPMessage[]>;

  /**
   * Fetch new messages since last sync
   * @param sinceUID - Last synced UID
   */
  getNewMessages(sinceUID: number, options?: FetchOptions): Promise<IMAPMessage[]>;

  /**
   * Fetch messages in the closed UID range [loUid, hiUid] (inclusive). Bounded,
   * downward counterpart to getNewMessages — used by the historical backfill to
   * page older mail one UID window at a time. Optional: impls that omit it can't
   * be backfilled (the scheduler skips them).
   */
  fetchMessagesByUidRange?(loUid: number, hiUid: number, options?: FetchOptions): Promise<IMAPMessage[]>;

  /**
   * Fetch a single message
   */
  fetchMessage(uid: number, options?: FetchOptions): Promise<IMAPMessage | null>;

  /**
   * Fetch only flags for messages (efficient for flag sync)
   * Returns array of { uid, flags }
   *
   * `expectedPath` ANCHORS the answer to a mailbox. Every whole-mailbox
   * enumeration on this interface accepts it, and callers that attribute the
   * result to a specific folder must pass that folder's path: the answer is a
   * set of bare UIDs with no mailbox in it, so a connection re-selected between
   * SELECT and FETCH (routine — pooled connections are recycled on timeouts)
   * hands back another mailbox's UIDs under this folder's name. On 2026-09-13
   * that enumerated INBOX's 24,662 UIDs as a 917-message folder's, and the
   * deletion reconcile removed 410 live messages that were never missing.
   * Implementations throw `MAILBOX_MISMATCH` rather than return a mis-attributed
   * set.
   *
   * `onBatch` fires after each internal FLAGS sub-batch completes — a progress
   * heartbeat so a caller holding a POOLED connection (the whole-mailbox deletion
   * reconcile) can refresh the pool's stuck-eviction timer and not be reclaimed
   * mid-fetch on a large mailbox (52 batches on 26k UIDs can exceed the 120s
   * stuck timeout in one call).
   */
  fetchFlagsOnly(
    uids: number[],
    onBatch?: () => void,
    expectedPath?: string,
  ): Promise<Array<{ uid: number; flags: string[] }>>;

  /**
   * Fetch flags for all messages in folder (efficient bulk fetch)
   * Returns array of { uid, flags }
   */
  fetchAllFlags(expectedPath?: string): Promise<Array<{ uid: number; flags: string[] }>>;

  /**
   * Check if server supports CONDSTORE extension
   */
  supportsCondstore(): boolean;

  /** True when the server advertises QRESYNC (RFC 7162) — efficient VANISHED-based
   *  deletion detection. */
  supportsQresync?(): boolean;

  /**
   * QRESYNC resynchronising SELECT: opens the folder with a prior
   * (uidValidity, modseq) so the server reports `VANISHED (EARLIER)` for
   * messages expunged while the client was away. Returns the folder status plus
   * those vanished UIDs. Only available when supportsQresync() is true.
   */
  selectFolderWithQresync?(
    folderPath: string,
    uidValidity: number,
    modseq: number,
  ): Promise<{ status: FolderStatus; vanishedUids: number[] }>;

  /**
   * Select folder with CONDSTORE extension enabled
   * Returns folder status including highestModseq
   */
  selectFolderWithCondstore?(folderPath: string): Promise<FolderStatus>;

  /**
   * Fetch flags for messages changed since a MODSEQ value
   * Uses CONDSTORE CHANGEDSINCE modifier for efficient flag sync
   * Only available if supportsCondstore() returns true
   */
  fetchFlagsChangedSince?(modseq: number): Promise<FlagChange[]>;

  /**
   * Gmail labels for every message in the open mailbox (`X-GM-LABELS`), used to
   * REPAIR folder membership for rows downloaded from the All Mail superset
   * before labels were fetched. Labels-only, so it costs a fraction of a
   * re-download. Returns `[]` on a server without the Gmail extension.
   */
  fetchAllLabels?(expectedPath?: string): Promise<Array<{ uid: number; labels: string[] }>>;

  /**
   * Fetch all UIDs in current folder (efficient for deletion detection)
   */
  fetchAllUIDs?(expectedPath?: string): Promise<number[]>;

  /**
   * Fetch UIDs of messages with an internal date on/after `since`
   * (`UID SEARCH SINCE`). The windowed counterpart to fetchAllUIDs — used to
   * reconcile only the recent window on large mailboxes, where enumerating the
   * whole mailbox returns partial lists / times out.
   */
  fetchUidsSince?(since: Date, expectedPath?: string): Promise<number[]>;

  /**
   * CONDSTORE state (highestModseq + uidValidity) of the currently-open mailbox,
   * or null when none is open / the server reported no modseq. Used by the
   * flag-delta path to gate eligibility and to persist the reconciled modseq.
   */
  getCurrentMailboxState?(): { path?: string; highestModseq?: number; uidValidity?: number; exists?: number; uidNext?: number } | null;

  /** Map Message-ID (bracket-stripped, lower-cased) → UID for the current folder,
   *  via envelope fetch. Reliable delete-by-id when HEADER search is unsupported. */
  fetchMessageIdToUidMap?(expectedPath?: string): Promise<Map<string, number>>;

  /** Atomically \Deleted + expunge the given UIDs (no flag-then-purge race). */
  deleteAndExpunge?(uids: number[]): Promise<void>;

  // ========== Append Message ==========

  /**
   * Append a raw RFC822 message to a folder
   */
  appendMessage(folderPath: string, rawMessage: string | Buffer, flags?: string[]): Promise<number | undefined>;

  // ========== Message Flags ==========

  /**
   * Add flags to messages
   */
  addFlags(uids: number[], flags: string[]): Promise<void>;

  /**
   * Remove flags from messages
   */
  removeFlags(uids: number[], flags: string[]): Promise<void>;

  /**
   * Remove Gmail labels in place (STORE -X-GM-LABELS) without deleting the
   * message. Gmail-only (optional); used to strip stale category labels.
   */
  removeGmailLabels?(uids: number[], labels: string[]): Promise<void>;

  /**
   * Set flags (replace existing)
   */
  setFlags(uids: number[], flags: string[]): Promise<void>;

  // ========== Message Operations ==========

  /**
   * Move messages to another folder.
   *
   * Returns the server's source-UID -> destination-UID map (from the COPYUID
   * response) when the server supports MOVE + UIDPLUS, or `null` when the server
   * does not report it. Callers use this map to write the new destination UID
   * onto the local row so `emails.uid` stays consistent with its folder.
   */
  moveMessages(uids: number[], destinationFolder: string): Promise<Map<number, number> | null>;

  /**
   * Copy messages to another folder
   */
  copyMessages(uids: number[], destinationFolder: string): Promise<void>;

  /** Create a mailbox (folder / Gmail label). Idempotent — see impl. */
  createMailbox(path: string): Promise<void>;

  /** Rename a mailbox / label. */
  renameMailbox?(oldPath: string, newPath: string): Promise<void>;

  /** Delete a mailbox / label. Idempotent. */
  deleteMailbox?(path: string): Promise<void>;

  /** Subscribe / unsubscribe a mailbox (LSUB). Optional. */
  subscribeMailbox?(path: string): Promise<void>;
  unsubscribeMailbox?(path: string): Promise<void>;

  /** Flat list of every mailbox path. */
  listMailboxPaths?(): Promise<string[]>;

  /** Server speaks the Gmail IMAP extension (native labels). */
  supportsGmailLabels?(): boolean;

  /** `folderPath` accepts arbitrary custom keywords (`\*` in PERMANENTFLAGS). */
  supportsKeywords?(folderPath?: string): Promise<boolean>;

  /** Mailbox hierarchy delimiter (for nesting `Sarv Inbox/<x>`). */
  getHierarchyDelimiter?(): Promise<string>;

  /**
   * Delete messages (mark as \Deleted)
   */
  deleteMessages(uids: number[]): Promise<void>;

  /**
   * Expunge folder (permanently delete messages marked \Deleted)
   */
  expunge(): Promise<void>;

  // ========== IDLE Support (Push) ==========

  /**
   * Start IDLE mode (if server supports)
   */
  startIdle(callback: (event: IMAPEvent) => void): Promise<void>;

  /**
   * Stop IDLE mode
   */
  stopIdle(): Promise<void>;

  /**
   * Check if IDLE is supported
   */
  supportsIdle(): boolean;

  // ========== Search ==========

  /**
   * Search messages in current folder
   */
  search(criteria: SearchCriteria): Promise<number[]>; // Returns UIDs

  // ========== Server Capabilities ==========

  /**
   * Get server capabilities
   */
  getCapabilities(): Promise<string[]>;

  /**
   * Check if server has specific capability
   */
  hasCapability(capability: string): boolean;
}

/**
 * IMAP configuration
 */
export interface IMAPConfig {
  host: string;
  port: number;
  secure: boolean; // Use TLS/SSL (legacy boolean; `security` is authoritative when set)
  /** First-class connection security. 'ssl' = implicit TLS (993); 'starttls' =
   *  upgrade on 143; 'none' = plain (best-effort STARTTLS if offered). Persisted
   *  so the choice round-trips on reconnect/edit instead of collapsing to `secure`. */
  security?: 'ssl' | 'starttls' | 'none';
  username: string;
  password: string; // ignored when authMethod === 'oauth2'
  authMethod?: 'password' | 'oauth2';
  /** OAuth provider id — lets the main process refresh tokens. */
  oauthProvider?: 'gmail' | 'microsoft' | 'yahoo';
  /** Bearer access token — required when authMethod === 'oauth2'. */
  accessToken?: string;
  /**
   * Optional async bearer resolver. When set (OAuth accounts), it's called
   * IMMEDIATELY BEFORE every `connect()` — including every pooled worker
   * connection and every reconnect — to obtain a FRESH access token, so a
   * connection can never authenticate with a token that expired after the pool
   * was first initialized (the "NO Invalid or expired token" pool failures).
   * `forceRefresh` bypasses the proactive-expiry cache so a 401 can force a new
   * token. Not serializable over IPC / to disk — the main process attaches it
   * right before handing the config to core (see `attachImapBearer`). When set
   * it takes precedence over the static `accessToken`.
   */
  resolveBearer?: (forceRefresh?: boolean) => Promise<string>;
  tlsOptions?: {
    rejectUnauthorized?: boolean;
  };
  /**
   * Opt-in escape hatch for servers with self-signed / untrusted certs.
   * Default (undefined/false) keeps TLS verification ON — disabling it exposes
   * credentials and mail to man-in-the-middle attacks, so it must be an explicit
   * per-account choice, never the default.
   */
  allowInsecureTLS?: boolean;
  connectionTimeout?: number; // Milliseconds
  keepalive?: boolean;
}

/**
 * IMAP folder information
 */
export interface IMAPFolder {
  name: string; // Display name
  path: string; // Full path (e.g., "INBOX" or "Work/Projects")
  delimiter: string; // Path delimiter (usually "/" or ".")
  specialUse: string | null; // e.g., "\\Inbox", "\\Sent", "\\Trash"
  subscribed: boolean;
  selectable: boolean; // Can be selected (some folders are containers only)
  children: IMAPFolder[]; // Nested folders
}

/**
 * Folder status after selecting
 */
export interface FolderStatus {
  path: string;
  uidValidity: number; // Changes if folder structure changes
  uidNext: number; // Next UID to be assigned
  messages: number; // Total message count
  recent: number; // Recent messages
  unseen: number; // Unseen messages
  permanentFlags: string[]; // Flags that can be changed permanently
  readOnly: boolean;
  highestModseq?: number; // CONDSTORE: highest modification sequence number
}

/**
 * Flag change result from CONDSTORE sync
 */
export interface FlagChange {
  uid: number;
  flags: string[];
  modseq: number;
}

/**
 * IMAP message (raw from server)
 */
export interface IMAPMessage {
  uid: number;
  seqNo: number; // Sequence number
  flags: string[]; // e.g., ["\\Seen", "\\Flagged"]
  date: Date; // Internal date
  size: number; // Message size in bytes
  // Carries mailing-list / bulk-mail headers (List-Id / List-Unsubscribe /
  // Precedence: bulk). Drives the "suppress subject-fallback for bulk" threading
  // rule so newsletters/digests don't collapse into one thread.
  isBulk?: boolean;

  /**
   * Gmail labels for this message (`X-GM-LABELS`), when the server advertises
   * `X-GM-EXT-1`. On Gmail these ARE the folder membership: one message lives in
   * every mailbox it is labelled with, so a message downloaded from the All Mail
   * superset needs them to be filed into INBOX / Starred / the user's own labels.
   * Absent on every non-Gmail server. See utils/gmail-labels for the mapping.
   */
  labels?: string[];

  // Headers
  envelope: {
    messageId: string;
    inReplyTo: string | null;
    references: string[];
    subject: string | null;
    from: EmailAddress[];
    replyTo: EmailAddress[];
    to: EmailAddress[];
    cc: EmailAddress[];
    bcc: EmailAddress[];
    date: Date | null;
  };

  // Body structure
  bodyStructure: BodyStructure;

  // Content
  body?: string; // Full message body (if fetched)
  bodyParts?: { [partId: string]: string }; // Individual body parts

  // Attachments
  attachments?: AttachmentInfo[];
}

/**
 * Email address
 */
export interface EmailAddress {
  name: string | null; // Display name
  address: string; // Email address
}

/**
 * MIME body structure
 */
export interface BodyStructure {
  type: string; // e.g., "text", "multipart"
  subtype: string; // e.g., "plain", "html", "mixed"
  params: { [key: string]: string }; // Content-Type parameters
  id: string | null;
  description: string | null;
  encoding: string; // e.g., "7bit", "quoted-printable", "base64"
  size: number;
  lines?: number; // For text/* parts
  disposition: {
    type: string; // "inline" or "attachment"
    params: { [key: string]: string };
  } | null;
  /** IMAP MIME part number (e.g. "2", "1.2") — used to fetch THIS part alone via
   *  BODY[part], instead of downloading the whole message. Absent on the root. */
  part?: string;
  parts?: BodyStructure[]; // For multipart
}

/**
 * Attachment information
 */
export interface AttachmentInfo {
  partId: string; // IMAP part ID
  filename: string;
  contentType: string;
  size: number;
  encoding: string;
  disposition: 'inline' | 'attachment';
}

/**
 * Fetch options
 */
export interface FetchOptions {
  fetchBody?: boolean; // Fetch full body
  fetchHeaders?: boolean; // Fetch headers
  fetchBodyStructure?: boolean; // Fetch MIME structure
  fetchAttachments?: boolean; // Fetch attachment metadata
  markSeen?: boolean; // Mark as seen when fetching
}

/**
 * Search criteria
 */
export interface SearchCriteria {
  all?: boolean;
  answered?: boolean;
  deleted?: boolean;
  draft?: boolean;
  flagged?: boolean;
  new?: boolean;
  old?: boolean;
  recent?: boolean;
  seen?: boolean;
  unanswered?: boolean;
  undeleted?: boolean;
  undraft?: boolean;
  unflagged?: boolean;
  unseen?: boolean;

  // Header search
  from?: string;
  to?: string;
  cc?: string;
  bcc?: string;
  subject?: string;
  body?: string;
  text?: string; // Search entire message
  header?: { name: string; value: string }[];

  // Date search
  before?: Date;
  since?: Date;
  sentBefore?: Date;
  sentSince?: Date;

  // Size
  larger?: number; // Bytes
  smaller?: number;

  // UID
  uid?: number[];
}

/**
 * IMAP events
 */
export interface IMAPEvent {
  type: 'new' | 'update' | 'delete' | 'expunge';
  uid?: number;
  seqNo?: number;
  flags?: string[];
}

/**
 * IMAP error
 */
export class IMAPError extends Error {
  constructor(
    message: string,
    public code: string,
    /** Raw server reply text (ImapFlow responseText), e.g. "[TRYCREATE] no such mailbox". */
    public serverResponse?: string,
    /** The IMAP command we actually sent, e.g. "UID STORE 3085 +FLAGS (\\Seen)". */
    public executedCommand?: string,
    /** Tagged response status: 'NO' | 'BAD'. */
    public responseStatus?: string,
  ) {
    super(message);
    this.name = 'IMAPError';
  }
}

/**
 * Connection state
 */
export type ConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'authenticated'
  | 'selected'
  | 'idle'
  | 'error';
