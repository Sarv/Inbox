/**
 * The OpenPGP keyring: the user's own key pairs and everybody else's public
 * keys, and the decisions made from them — which key opens a message, which
 * key a recipient's mail is encrypted to, which key signs.
 *
 * PRIVATE KEYS. Sealed by the OS keychain where there is one, so they open
 * without a prompt (pgp-secret-seal.ts). Where there is none (Linux without a
 * Secret Service) the key stays passphrase-protected on disk and is unlocked
 * once per session, in memory only. A key imported WITH a passphrase is
 * unlocked once, then re-sealed by the keychain.
 *
 * WHICH KEY FOR A RECIPIENT. By where it came from, most trusted first:
 * imported by the user, the recipient's own domain (WKD), keys.openpgp.org
 * (which verifies the address), then Autocrypt (a header anyone who can send
 * mail as that address could have written). Within a tier the newest usable
 * key wins; for Autocrypt, the most recently SEEN one, as the spec says.
 *
 * NETWORK. Only `resolveRecipients({ discover: true })` looks anything up, and
 * only as far as the user's settings allow; an unreadable settings store asks
 * nobody. Answers are remembered for the session — "no key" for an hour, a
 * failed lookup for five minutes — so typing in the To field does not hammer
 * anybody's server.
 */
import {
  generateKeyPair,
  inspectKey,
  parseAutocryptHeader,
  PgpKeyError,
  pickEncryptionKey,
  protectPrivateKey,
  publicKeyOf,
  readAllKeys,
  readAnyKey,
  readUnlockedPrivateKey,
  unlockPrivateKey,
  type PgpKeyInfo,
  type PgpKeySource,
  type PgpOpenKeys,
  type PgpPrefs,
} from '@sarvinbox/core/pgp';

import type { KeyLookupPolicy, KeyLookupResult } from './pgp-key-lookup';
import {
  normalizeEmail,
  type AutocryptPreferEncrypt,
  type ContactKeyRow,
  type OwnKeyProtection,
  type OwnKeyRow,
  type PgpKeyStore,
} from './pgp-key-store';
import { sealWithKeychain, sealWithPassphrase, unseal, type Keychain } from './pgp-secret-seal';

type PublicKey = Awaited<ReturnType<typeof readAnyKey>>;
type PrivateKey = Awaited<ReturnType<typeof readUnlockedPrivateKey>>;

export const NO_KEY_TTL_MS = 60 * 60 * 1000;
export const FAILED_LOOKUP_TTL_MS = 5 * 60 * 1000;

/** Source tiers, most trusted first. */
const SOURCE_ORDER: readonly PgpKeySource[] = ['manual', 'wkd', 'keyserver', 'autocrypt'];

export type PgpKeyringErrorCode = 'passphrase-required' | 'not-found' | 'locked' | 'address-mismatch';

export class PgpKeyringError extends Error {
  constructor(
    message: string,
    public readonly code: PgpKeyringErrorCode,
  ) {
    super(message);
    this.name = 'PgpKeyringError';
  }
}

export interface OwnKeySummary extends PgpKeyInfo {
  email: string;
  protection: OwnKeyProtection;
  signByDefault: boolean;
  /** False only for a passphrase-protected key not yet unlocked this session. */
  unlocked: boolean;
  addedAt: string;
}

export interface ContactKeySummary extends PgpKeyInfo {
  email: string;
  source: PgpKeySource;
  preferEncrypt: AutocryptPreferEncrypt | null;
  firstSeen: string;
  lastSeen: string;
}

export type RecipientKeyStatus =
  | { email: string; status: 'key'; source: PgpKeySource | 'own'; fingerprint: string }
  | { email: string; status: 'none' };

export interface PgpKeyringDeps {
  store: PgpKeyStore;
  keychain: Keychain;
  /** Network lookup for one address. */
  lookup: (email: string, policy: KeyLookupPolicy) => Promise<KeyLookupResult>;
  /** The user's preferences. THROWS when they cannot be read. */
  prefs: () => PgpPrefs;
  /** Wall clock, ms since the epoch. */
  now: () => number;
}

interface LookupMemo {
  until: number;
}

export class PgpKeyring {
  /** Opened private keys, by fingerprint. Session memory only. */
  private readonly opened = new Map<string, PrivateKey>();
  private readonly infoCache = new Map<string, PgpKeyInfo>();
  private readonly lookupMemo = new Map<string, LookupMemo>();
  /** address → the Autocrypt keydata last recorded this session, to skip re-parsing it on every message. */
  private readonly autocryptSeen = new Map<string, string>();

  constructor(private readonly deps: PgpKeyringDeps) {}

  keychainAvailable(): boolean {
    return this.deps.keychain.isAvailable();
  }

  private iso(): string {
    return new Date(this.deps.now()).toISOString();
  }

  private async infoOf(fingerprint: string, armored: string): Promise<PgpKeyInfo> {
    const cached = this.infoCache.get(fingerprint);
    if (cached) return cached;
    const info = await inspectKey(armored);
    this.infoCache.set(fingerprint, info);
    return info;
  }

  // =============================================================== own keys

  async listOwnKeys(): Promise<OwnKeySummary[]> {
    return Promise.all(this.deps.store.listOwnKeys().map((row) => this.summarizeOwn(row)));
  }

  private async summarizeOwn(row: OwnKeyRow): Promise<OwnKeySummary> {
    const info = await this.infoOf(row.fingerprint, row.publicKey);
    return {
      ...info,
      // The row's own flags describe how it is STORED; the public half says nothing about that.
      isPrivate: true,
      isPassphraseProtected: row.protection === 'passphrase',
      email: row.email,
      protection: row.protection,
      signByDefault: row.signByDefault,
      unlocked: row.protection === 'keychain' || this.opened.has(row.fingerprint),
      addedAt: row.addedAt,
    };
  }

  async generateOwnKey(input: { name: string; email: string; passphrase?: string }): Promise<OwnKeySummary> {
    const useKeychain = this.keychainAvailable();
    if (!useKeychain && !input.passphrase) {
      throw new PgpKeyringError('A passphrase is needed: this system has no keychain to protect the key', 'passphrase-required');
    }
    const generated = await generateKeyPair({
      name: input.name,
      email: input.email,
      passphrase: useKeychain ? undefined : input.passphrase,
    });
    if (useKeychain) return this.storeOwn(generated.armoredPrivateKey, null);
    const unlocked = await unlockPrivateKey(generated.armoredPrivateKey, input.passphrase as string);
    return this.storeOwn(unlocked, generated.armoredPrivateKey);
  }

  /**
   * Import one or more private keys. A protected key needs its passphrase once;
   * where a keychain exists it is then stored keychain-sealed. Where none
   * exists the key must end up passphrase-protected: a protected key is kept
   * as it came, an unprotected one is protected with the passphrase given.
   */
  async importOwnKey(armored: string, passphrase?: string): Promise<OwnKeySummary[]> {
    const keys = (await readAllKeys(armored)).filter((key) => key.isPrivate());
    if (keys.length === 0) {
      throw new PgpKeyError('This is a public key; importing your own key needs the private key', 'not-private');
    }
    const useKeychain = this.keychainAvailable();
    const imported: OwnKeySummary[] = [];
    for (const key of keys) {
      const original = key.armor();
      const protectedOnDisk = (await inspectKey(original)).isPassphraseProtected;
      if (protectedOnDisk && !passphrase) {
        throw new PgpKeyringError('This key is protected by a passphrase', 'passphrase-required');
      }
      const unlocked = protectedOnDisk ? await unlockPrivateKey(original, passphrase as string) : original;
      if (useKeychain) {
        imported.push(await this.storeOwn(unlocked, null));
        continue;
      }
      if (!passphrase) {
        throw new PgpKeyringError('A passphrase is needed: this system has no keychain to protect the key', 'passphrase-required');
      }
      const lockedCopy = protectedOnDisk ? original : await protectPrivateKey(unlocked, passphrase);
      imported.push(await this.storeOwn(unlocked, lockedCopy));
    }
    return imported;
  }

  /**
   * Persist an own key. `lockedCopy` null = keychain-seal `unlockedArmored`;
   * otherwise store the protected copy and keep the unlocked key in memory.
   */
  private async storeOwn(unlockedArmored: string, lockedCopy: string | null): Promise<OwnKeySummary> {
    const privateKey = await readUnlockedPrivateKey(unlockedArmored);
    const info = await inspectKey(privateKey);
    const publicArmored = await publicKeyOf(unlockedArmored);
    const existing = this.deps.store.getOwnKey(info.fingerprint);
    const row: OwnKeyRow = {
      fingerprint: info.fingerprint,
      email: info.emails[0] ?? '',
      publicKey: publicArmored,
      secret: lockedCopy === null ? sealWithKeychain(this.deps.keychain, unlockedArmored) : sealWithPassphrase(lockedCopy),
      protection: lockedCopy === null ? 'keychain' : 'passphrase',
      signByDefault: existing?.signByDefault ?? false,
      createdAt: info.createdAt,
      addedAt: existing?.addedAt ?? this.iso(),
    };
    this.deps.store.putOwnKey(row);
    this.infoCache.delete(info.fingerprint);
    this.opened.set(info.fingerprint, privateKey);
    return this.summarizeOwn(row);
  }

  private requireOwn(fingerprint: string): OwnKeyRow {
    const row = this.deps.store.getOwnKey(fingerprint);
    if (!row) throw new PgpKeyringError('No such key', 'not-found');
    return row;
  }

  /** Unlock a passphrase-protected own key for the rest of this session. */
  async unlockOwnKey(fingerprint: string, passphrase: string): Promise<void> {
    const row = this.requireOwn(fingerprint);
    const sealed = unseal(this.deps.keychain, row.secret);
    if (sealed.protection === 'keychain') return;
    const unlocked = await unlockPrivateKey(sealed.armoredProtectedKey, passphrase);
    this.opened.set(fingerprint, await readUnlockedPrivateKey(unlocked));
  }

  /** The private key, opened, or null when it is passphrase-locked and not yet unlocked. */
  private async openOwn(row: OwnKeyRow): Promise<PrivateKey | null> {
    const cached = this.opened.get(row.fingerprint);
    if (cached) return cached;
    const sealed = unseal(this.deps.keychain, row.secret);
    if (sealed.protection === 'passphrase') return null;
    const privateKey = await readUnlockedPrivateKey(sealed.armoredPrivateKey);
    this.opened.set(row.fingerprint, privateKey);
    return privateKey;
  }

  /** A backup of an own key, protected with `passphrase` whatever it is protected with here. */
  async exportOwnKey(fingerprint: string, passphrase: string): Promise<string> {
    if (!passphrase) throw new PgpKeyringError('A backup needs a passphrase', 'passphrase-required');
    const row = this.requireOwn(fingerprint);
    const privateKey = await this.openOwn(row);
    if (!privateKey) throw new PgpKeyringError('Unlock this key before backing it up', 'locked');
    return protectPrivateKey(privateKey.armor(), passphrase);
  }

  exportOwnPublicKey(fingerprint: string): string {
    return this.requireOwn(fingerprint).publicKey;
  }

  deleteOwnKey(fingerprint: string): boolean {
    this.opened.delete(fingerprint);
    this.infoCache.delete(fingerprint);
    return this.deps.store.deleteOwnKey(fingerprint);
  }

  setSignByDefault(fingerprint: string, on: boolean): boolean {
    return this.deps.store.setSignByDefault(fingerprint, on);
  }

  /** Own keys whose user IDs carry `email`, newest first. */
  private async ownRowsFor(email: string): Promise<OwnKeyRow[]> {
    const wanted = normalizeEmail(email);
    const rows = this.deps.store.listOwnKeys();
    const infos = await Promise.all(rows.map((row) => this.infoOf(row.fingerprint, row.publicKey)));
    return rows
      .filter((_, index) => infos[index].emails.includes(wanted) && !infos[index].isRevoked && !infos[index].isExpired)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** The newest own public key for `email`, for Autocrypt and for encrypting the Sent copy. */
  async ownPublicKeyFor(email: string): Promise<PublicKey | null> {
    const [row] = await this.ownRowsFor(email);
    return row ? readAnyKey(row.publicKey) : null;
  }

  /** Whether signing is on by default for mail sent as `email`. */
  async signsByDefault(email: string): Promise<boolean> {
    const [row] = await this.ownRowsFor(email);
    return row?.signByDefault ?? false;
  }

  /**
   * The key to sign mail from `email` with. Null when the user has no key for
   * that address; THROWS `locked` when the only one is locked, so the send
   * fails with "unlock your key" rather than going out unsigned.
   */
  async signingKeyFor(email: string): Promise<PrivateKey | null> {
    const rows = await this.ownRowsFor(email);
    if (rows.length === 0) return null;
    for (const row of rows) {
      const key = await this.openOwn(row);
      if (key) return key;
    }
    throw new PgpKeyringError(`The key for ${normalizeEmail(email)} is locked`, 'locked');
  }

  /**
   * Keys to open a message with. Every own key: a message may be encrypted to
   * any of them, whichever account it arrived in. Verification keys are the
   * user's own plus every key held for the sender's address.
   */
  async openingKeys(senderEmail: string | null): Promise<PgpOpenKeys> {
    const decryptionKeys: PrivateKey[] = [];
    const lockedKeys: PrivateKey[] = [];
    const verificationKeys: PublicKey[] = [];
    for (const row of this.deps.store.listOwnKeys()) {
      verificationKeys.push(await readAnyKey(row.publicKey));
      const opened = await this.openOwn(row);
      if (opened) decryptionKeys.push(opened);
      else lockedKeys.push(await this.readLocked(row));
    }
    if (senderEmail) {
      for (const contact of this.deps.store.contactKeysFor(senderEmail)) {
        verificationKeys.push(await readAnyKey(contact.publicKey));
      }
    }
    return { decryptionKeys, lockedKeys, verificationKeys };
  }

  private async readLocked(row: OwnKeyRow): Promise<PrivateKey> {
    const sealed = unseal(this.deps.keychain, row.secret);
    const armored = sealed.protection === 'passphrase' ? sealed.armoredProtectedKey : sealed.armoredPrivateKey;
    return (await readAnyKey(armored)) as PrivateKey;
  }

  // =========================================================== contact keys

  async listContactKeys(): Promise<ContactKeySummary[]> {
    return Promise.all(this.deps.store.listContactKeys().map((row) => this.summarizeContact(row)));
  }

  private async summarizeContact(row: ContactKeyRow): Promise<ContactKeySummary> {
    const info = await this.infoOf(row.fingerprint, row.publicKey);
    return {
      ...info,
      email: row.email,
      source: row.source,
      preferEncrypt: row.preferEncrypt,
      firstSeen: row.firstSeen,
      lastSeen: row.lastSeen,
    };
  }

  /** Import other people's public keys by hand — one row per key and address. */
  async importContactKeys(armored: string): Promise<ContactKeySummary[]> {
    const keys = await readAllKeys(armored);
    const added: ContactKeySummary[] = [];
    for (const key of keys) {
      const publicArmored = key.isPrivate() ? key.toPublic().armor() : key.armor();
      const info = await inspectKey(publicArmored);
      for (const email of info.emails) {
        this.storeContact(email, info.fingerprint, publicArmored, 'manual', null);
        added.push(...(await this.contactSummariesFor(email, info.fingerprint)));
      }
    }
    return added;
  }

  private async contactSummariesFor(email: string, fingerprint: string): Promise<ContactKeySummary[]> {
    const rows = this.deps.store.contactKeysFor(email).filter((row) => row.fingerprint === fingerprint);
    return Promise.all(rows.map((row) => this.summarizeContact(row)));
  }

  private storeContact(
    email: string,
    fingerprint: string,
    publicKey: string,
    source: PgpKeySource,
    preferEncrypt: AutocryptPreferEncrypt | null,
    seenAt: string = this.iso(),
  ): void {
    this.deps.store.upsertContactKey({ email, fingerprint, publicKey, source, preferEncrypt, lastSeen: seenAt });
    this.infoCache.delete(fingerprint);
    this.lookupMemo.delete(normalizeEmail(email));
  }

  deleteContactKey(email: string, fingerprint: string): boolean {
    this.autocryptSeen.delete(normalizeEmail(email));
    return this.deps.store.deleteContactKey(email, fingerprint);
  }

  /**
   * Record the key an incoming message's Autocrypt header offers. Only the
   * header for the message's own From address counts (the spec's rule — a
   * header naming anyone else is ignored), and only a key that can encrypt.
   * Returns whether a key was recorded.
   */
  async recordAutocrypt(input: { fromAddress: string; header: string; sentAt: string }): Promise<boolean> {
    const parsed = parseAutocryptHeader(input.header);
    const from = normalizeEmail(input.fromAddress);
    if (!parsed || parsed.addr !== from) return false;
    const digest = parsed.keydata.toString('base64');
    if (this.autocryptSeen.get(from) === digest) return true;
    let key: PublicKey;
    try {
      key = await readAnyKey(parsed.keydata);
    } catch {
      return false;
    }
    const info = await inspectKey(key);
    if (!info.canEncrypt || info.isRevoked || info.isExpired) return false;
    const publicArmored = key.isPrivate() ? key.toPublic().armor() : key.armor();
    this.storeContact(from, info.fingerprint, publicArmored, 'autocrypt', parsed.preferEncrypt, input.sentAt);
    this.autocryptSeen.set(from, digest);
    return true;
  }

  // ============================================================ recipients

  /** The key mail to `email` is encrypted to, by source tier. */
  private async contactKeyFor(email: string): Promise<{ key: PublicKey; source: PgpKeySource } | null> {
    const rows = this.deps.store.contactKeysFor(email);
    for (const source of SOURCE_ORDER) {
      const tier = rows.filter((row) => row.source === source);
      if (tier.length === 0) continue;
      const keys = await Promise.all(tier.map((row) => readAnyKey(row.publicKey)));
      const picked =
        source === 'autocrypt'
          ? await this.firstUsable(keys, email)
          : await pickEncryptionKey(keys, email);
      if (picked) return { key: picked, source };
    }
    return null;
  }

  /** The first usable key in the order given (Autocrypt rows come most-recently-seen first). */
  private async firstUsable(keys: PublicKey[], email: string): Promise<PublicKey | null> {
    for (const key of keys) {
      const picked = await pickEncryptionKey([key], email);
      if (picked) return picked;
    }
    return null;
  }

  /** Where each recipient stands, looking keys up on the network only when asked and allowed. */
  async resolveRecipients(emails: string[], options: { discover: boolean }): Promise<RecipientKeyStatus[]> {
    const unique = [...new Set(emails.map(normalizeEmail).filter(Boolean))];
    return Promise.all(unique.map((email) => this.resolveOne(email, options.discover)));
  }

  private async resolveOne(email: string, discover: boolean): Promise<RecipientKeyStatus> {
    const own = await this.ownPublicKeyFor(email);
    if (own) return { email, status: 'key', source: 'own', fingerprint: own.getFingerprint().toUpperCase() };
    const held = await this.contactKeyFor(email);
    if (held) return { email, status: 'key', source: held.source, fingerprint: held.key.getFingerprint().toUpperCase() };
    if (!discover) return { email, status: 'none' };
    const found = await this.discover(email);
    return found ? { email, status: 'key', source: found.source, fingerprint: found.fingerprint } : { email, status: 'none' };
  }

  private async discover(email: string): Promise<{ source: PgpKeySource; fingerprint: string } | null> {
    const memo = this.lookupMemo.get(email);
    if (memo && memo.until > this.deps.now()) return null;
    let prefs: PgpPrefs;
    try {
      prefs = this.deps.prefs();
    } catch {
      // Fail closed: nothing leaves the machine on settings nobody can read.
      return null;
    }
    const policy = { wkd: prefs.wkdLookup, keyserver: prefs.keyserverLookup };
    if (!policy.wkd && !policy.keyserver) return null;
    const result = await this.deps.lookup(email, policy);
    if (!result.key) {
      this.lookupMemo.set(email, { until: this.deps.now() + (result.failed ? FAILED_LOOKUP_TTL_MS : NO_KEY_TTL_MS) });
      return null;
    }
    this.storeContact(email, result.key.fingerprint, result.key.armoredPublicKey, result.key.source, null);
    return { source: result.key.source, fingerprint: result.key.fingerprint };
  }

  /**
   * The keys an outgoing message is encrypted to: every recipient's, plus the
   * sender's own (so the Sent copy stays readable). `missing` lists the
   * recipients with no usable key — the caller must refuse to send, never
   * drop to plaintext.
   */
  async encryptionKeysFor(
    senderEmail: string,
    recipients: string[],
  ): Promise<{ keys: PublicKey[]; missing: string[] }> {
    const unique = [...new Set(recipients.map(normalizeEmail).filter(Boolean))];
    const keys: PublicKey[] = [];
    const missing: string[] = [];
    for (const email of unique) {
      const own = await this.ownPublicKeyFor(email);
      const key = own ?? (await this.contactKeyFor(email))?.key ?? null;
      if (key) keys.push(key);
      else missing.push(email);
    }
    const self = await this.ownPublicKeyFor(senderEmail);
    if (self) keys.push(self);
    return { keys, missing };
  }
}
