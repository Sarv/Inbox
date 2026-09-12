/**
 * Contacts IPC Handlers
 *
 * Handles contact management operations.
 */

import { classifyDomainPhones, classifyDomainUrls, htmlMiningWindow, htmlToPlainText, mineAttributedPhones, mineContactSignals, phoneDomainOf, parseAddresses, type SenderPhones, type SenderUrls, createLogger } from '@sarvinbox/core';
import { ipcMain } from 'electron';

import { requireStorage, getStorageFor, getAllAccountRuntimes } from '../shared';
const logger = createLogger('contacts-handlers');

/**
 * Resolve the storage for an optional accountId. When `accountId` is omitted the
 * ACTIVE account is used (unchanged legacy behavior). When it IS given (the
 * background-account enrichment path), we resolve that specific account and
 * THROW if its runtime isn't available — we must never silently fall back to the
 * active account, which would read/write the wrong account's contacts.
 */
function storageForAccount(accountId?: string | null): ReturnType<typeof requireStorage> {
  if (accountId) {
    const s = getStorageFor(accountId);
    if (!s) throw new Error(`storage not available for account ${accountId}`);
    return s as ReturnType<typeof requireStorage>;
  }
  return requireStorage();
}

// Cap the per-email body length fed to signal extraction (see usage below).
const MAX_MINE_BODY_CHARS = 64 * 1024;
// How much of a raw body is converted for mining. html-to-text is CPU-bound and
// synchronous: converting 64KB x 120 emails x every contact froze the main
// process for the length of a scan (the spinning cursor). The budget is spent
// on BOTH ENDS of the body (htmlMiningWindow) rather than the tail alone, so a
// top-posted reply's signature -- which sits above the quoted chain, not below
// it -- is inside the window. 12KB comfortably covers two signature blocks.
const MAX_CONVERT_CHARS = 12 * 1024;
// Give up on a contact only once we have FOUND something. Signatures repeat, so
// four hits is plenty and the rest is wasted work — but a contact that has
// yielded nothing yet is precisely the one worth reading further into, so the
// budget only applies after success. The hard ceiling exists solely to bound a
// pathological sender (thousands of mails, no signature anywhere).
const ENOUGH_SIGNATURE_HITS = 4;
const MAX_CONVERSIONS_AFTER_HIT = 25;
const HARD_CONVERSION_CEILING = 120;
// Hand the event loop back this often. better-sqlite3 and html-to-text are both
// synchronous, so without this the whole scan runs as one uninterruptible block
// and every IPC reply — i.e. the entire UI — waits for it.
// Yield after EVERY contact, and again partway through one contact's own
// conversion loop. A signature-less sender reads up to HARD_CONVERSION_CEILING
// emails, so yielding only every 5 contacts could still block ~300ms at a
// stretch — long enough to show the spinner. Slices are cheap; long ones aren't.
const YIELD_EVERY_CONTACTS = 1;
const YIELD_EVERY_CONVERSIONS = 20;
// How much of a contact's inbound mail mining looks at. Sampled generously (not
// just the last few): a high-volume sender's own signature may sit in older mail
// while the recent ones are content-heavy. Applied per account AND to the merged
// result, so connecting a second account widens what is searched without
// multiplying what is converted.
const RECENT_MAIL_PER_CONTACT = 120;

/**
 * Somewhere a contact's mail can be read from. The contact DIRECTORY is shared
 * by every account, but `emails` is not — a person who writes to two of the
 * user's addresses is one row here and two mailboxes' worth of mail, and their
 * signature may only ever have been sent to one of them.
 */
type MailSource = {
  getRecentInboundEmailsForContact: (email: string, limit?: number) => Promise<unknown[]>;
  getNewestEmailDateBySender?: () => Map<string, number>;
};

/**
 * Every mailbox whose mail can be mined, newest-first per source.
 *
 * Before the directory was unified, a scan's contacts and a scan's mail came
 * from the same database and reading one account was self-consistent. Now the
 * contact list is everyone's and the mail is one account's: mining only the
 * active account leaves every contact who writes to a different address of the
 * user's looking like a contact with no signature at all. Falls back to the
 * caller's own storage when no runtimes are registered (the pre-multi-account
 * default slot), which is exactly the old behaviour.
 */
function mailSourcesFor(storage: ReturnType<typeof requireStorage>): MailSource[] {
  const runtimes = getAllAccountRuntimes();
  const sources = runtimes.map(([, rt]) => rt.storage as unknown as MailSource).filter(Boolean);
  return sources.length > 0 ? sources : [storage as unknown as MailSource];
}

/**
 * Newest inbound mail per sender across every mailbox, taking the MAX.
 *
 * This is the watermark the incremental skip compares against, and the numbers
 * it guards are stored once in the shared directory. Reading it from one
 * account would park the watermark at that account's newest mail while another
 * account holds newer mail from the same person — whose signature would then
 * never be re-read.
 */
function newestBySenderAcross(sources: MailSource[]): Map<string, number> {
  const merged = new Map<string, number>();
  for (const source of sources) {
    let one: Map<string, number>;
    try {
      one = source.getNewestEmailDateBySender?.() ?? new Map();
    } catch {
      continue; // no fast path for this account — its contacts are simply re-mined
    }
    for (const [email, newest] of one) {
      if ((merged.get(email) ?? 0) < newest) merged.set(email, newest);
    }
  }
  return merged;
}

/**
 * Deterministic cross-domain phone classification. Mines phones from each
 * contact's own recent inbound signatures, groups by domain, and splits shared
 * office lines from personal/direct numbers (see @sarvinbox/core phone-classifier).
 * Writes companyPhone/personalPhone into each contact's enrichment. Runs at the
 * end of a scan; returns how many contacts were updated.
 *
 * `storage` owns the contact list and every write (all of it shared, so any
 * account's connection reaches the same rows); the MAIL is read from every
 * account.
 */
async function classifyContactPhones(storage: ReturnType<typeof requireStorage>): Promise<number> {
  const contacts = await storage.getContacts({ limit: 20000, offset: 0 });
  const mailSources = mailSourcesFor(storage);
  const senders: SenderPhones[] = [];
  const urlSenders: SenderUrls[] = [];
  const linkedinByEmail = new Map<string, string>();
  // Contacts whose mail we actually examined this run. A contact that mined to
  // ZERO phones must still be written back — otherwise a stale value (a number
  // that a previous, buggier pass wrongly attributed to them) survives every
  // future scan, because they never enter `classified` and nothing clears them.
  const minedEmails = new Set<string>();
  // author -> phones seen in blocks they wrote but someone else forwarded.
  const quotedEvidence = new Map<string, Map<string, { display: string; count: number }>>();

  // INCREMENTAL: what mining already saw, and how fresh each contact's mail is.
  // Re-reading every contact's mail on every scan is the bulk of the cost and
  // rediscovers numbers that have not changed. Their stored numbers are still
  // fed to the classifier, so the domain-wide switchboard test is unaffected.
  const priorState = (storage as any).getPhoneMiningState?.() as
    Map<string, { through: number; phones: Record<string, number> }> | undefined;
  const newestBySender = newestBySenderAcross(mailSources);
  let skipped = 0;
  let scanned = 0;
  for (const c of contacts) {
    if (!c.email) continue;
    // Yield periodically so the UI stays responsive for the whole scan.
    if (++scanned % YIELD_EVERY_CONTACTS === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    // NB: getRecentInboundEmailsForContact returns RAW rows (snake_case
    // clean_body/raw_body), not camelCase EmailRecords — read both to be safe.
    // Sample generously (not just the last few): a high-volume sender's own
    // signature may sit in older mail while recent ones are content-heavy (e.g.
    // a recruiter's latest emails are candidate lists). A recurring signature
    // number then out-counts one-off content numbers.
    // Nothing newer than last time? Reuse the stored numbers and skip the read.
    const key0 = c.email.toLowerCase();
    const prior = priorState?.get(key0);
    const newest = newestBySender.get(key0) ?? 0;
    if (prior && newest > 0 && newest <= prior.through) {
      const reused = new Map(Object.entries(prior.phones).map(([k, v]) => [k, { display: k, count: v }]));
      if (reused.size > 0) {
        senders.push({ email: key0, domain: phoneDomainOf(c.email), phones: reused });
      }
      minedEmails.add(key0);
      skipped += 1;
      continue;
    }

    // Newest first ACROSS accounts, not newest-first within each: the
    // conversion budget below is spent in order, so an unmerged concatenation
    // would spend it all on the first account and never reach the mailbox the
    // signature actually arrived in.
    const perSource = await Promise.all(
      mailSources.map((source) => source
        .getRecentInboundEmailsForContact(c.email, RECENT_MAIL_PER_CONTACT)
        .catch(() => [] as unknown[])),
    );
    const emails = (perSource.flat() as Array<{
      date?: number | null;
      clean_body?: string | null; raw_body?: string | null; cleanBody?: string | null; rawBody?: string | null;
    }>)
      .sort((a, b) => (b.date ?? 0) - (a.date ?? 0))
      .slice(0, RECENT_MAIL_PER_CONTACT);
    if (!emails.length) continue;
    minedEmails.add(c.email.toLowerCase());
    let converted = 0;
    let signatureHits = 0;
    // A plain loop, not .map(): conversion is synchronous CPU work and the event
    // loop has to be handed back partway through a single contact's mail — a
    // sender with no signature reads up to HARD_CONVERSION_CEILING emails.
    const bodies: string[] = [];
    for (const e of emails) {
      if (converted > 0 && converted % YIELD_EVERY_CONVERSIONS === 0) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      const clean = e.clean_body ?? e.cleanBody ?? '';
      const raw = e.raw_body ?? e.rawBody ?? '';

      // MINE THE RAW BODY, NOT THE CLEAN ONE. `clean_body` is stored with the
      // signature deliberately REMOVED (parser/content-cleaner.ts strips from
      // the sign-off down), so searching it for signatures is self-defeating —
      // we only ever succeeded on the malformed html-to-text shapes the cleaner
      // also failed to detect. Measured here: raw_body is populated for 100% of
      // rows, and senders with ZERO signatures in clean have several in raw.
      //
      // Raw is HTML, and mining it directly scrapes numeric junk out of
      // attributes (one sender yielded 7 bogus numbers), so convert to text
      // first. Both ends, not the tail: html-to-text is CPU-bound so the body
      // is still capped, but a reply is top-posted and the sender's own
      // signature is at the TOP -- a tail-only window kept the last signature
      // of the quoted chain, which belongs to somebody else.
      const rawCapped = htmlMiningWindow(raw, MAX_CONVERT_CHARS);
      let fromRaw = '';
      const budgetLeft = signatureHits === 0
        ? converted < HARD_CONVERSION_CEILING
        : (signatureHits < ENOUGH_SIGNATURE_HITS && converted < MAX_CONVERSIONS_AFTER_HIT);
      if (rawCapped && budgetLeft) {
        try {
          if (/<[a-z][\s\S]*>/i.test(rawCapped)) {
            converted += 1;
            // keepLinkHrefs: a mailto:/tel: href IS the signal being mined here,
            // unlike the snippet path where a bare URL is noise.
            fromRaw = htmlToPlainText(rawCapped, { keepLinkHrefs: true });
          } else {
            fromRaw = rawCapped;
          }
          if (/^\s*--\s*$/m.test(fromRaw)) signatureHits += 1;
        } catch {
          fromRaw = ''; // fall through to clean_body
        }
      }
      const body = fromRaw.length > 50 ? fromRaw : (clean || rawCapped);
      bodies.push(body.length > MAX_MINE_BODY_CHARS ? body.slice(0, MAX_MINE_BODY_CHARS) : body);
    }
    // Single extraction pass over the bodies: mineContactSignals runs
    // extractSignals ONCE per body and returns both phones and LinkedIn (the
    // old minePhones + mineLinkedIn pair parsed every body twice). The /in/
    // URL in someone's own signature is theirs (vs a /company/ page, ignored).
    const { phones, scores, linkedin, twitter, websites, socials } = mineContactSignals(bodies, c.email);
    const key = c.email.toLowerCase();
    try {
      (storage as any).setPhoneMiningState?.(
        key,
        newest || Math.floor(Date.now() / 1000),
        Object.fromEntries([...phones.entries()].map(([k, v]) => [k, v.count])),
      );
    } catch { /* watermark is an optimisation; never fail a scan over it */ }
    if (linkedin.personal) linkedinByEmail.set(key, linkedin.personal);
    if (phones.size > 0) senders.push({ email: key, domain: phoneDomainOf(c.email), phones, scores });
    if (twitter.size > 0 || websites.size > 0 || socials.size > 0) {
      urlSenders.push({ email: key, domain: phoneDomainOf(c.email), twitter, websites, socials });
    }

    // Credit quoted reply chains to the people who actually wrote them. A
    // signature quoted inside this contact's mail belongs to the author named
    // in the quote header, not to this contact — and it is real evidence for
    // that author. Without it, someone who is quoted more often than they send
    // loses their own number to whoever quoted them.
    for (const [author, authorPhones] of mineAttributedPhones(bodies, c.email)) {
      if (author === key) continue; // own writing already counted above
      let bucket = quotedEvidence.get(author);
      if (!bucket) { bucket = new Map(); quotedEvidence.set(author, bucket); }
      for (const [phoneKey, v] of authorPhones) {
        const cur = bucket.get(phoneKey) || { display: v.display, count: 0 };
        cur.count += v.count;
        bucket.set(phoneKey, cur);
      }
    }
  }

  // Fold the quoted evidence into each author's own tally before classifying,
  // so ownership reflects everything we saw of that person's signature — their
  // own mail AND every chain that quoted them.
  for (const [author, evidence] of quotedEvidence) {
    const existing = senders.find((x) => x.email === author);
    const target = existing ?? { email: author, domain: phoneDomainOf(author), phones: new Map() };
    for (const [phoneKey, v] of evidence) {
      const cur = target.phones.get(phoneKey) || { display: v.display, count: 0 };
      cur.count += v.count;
      target.phones.set(phoneKey, cur);
    }
    if (!existing && target.phones.size > 0) senders.push(target);
  }

  logger.info(`[Contacts] Phone mining: ${senders.length} senders (${skipped} reused from a previous scan)`);
  const classified = classifyDomainPhones(senders);
  let updated = 0;
  const handled = new Set<string>();
  // Apply for every mined contact (not just those we could classify) so a stale
  // comma-joined value from the old enricher gets cleared even when the new
  // classification is empty. Pass the mined LinkedIn alongside (additive).
  let written = 0;
  for (const [email, { officePhone, directPhone }] of classified) {
    if (++written % 25 === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const linkedin = linkedinByEmail.get(email) ?? null;
    await storage.applyPhoneClassification(email, officePhone, directPhone, linkedin);
    handled.add(email);
    if (officePhone || directPhone || linkedin) updated += 1;
  }
  // Everything we examined but could not classify: clear the phones explicitly.
  // The classifier owns these fields, so "found nothing" must be recorded as
  // null rather than left at whatever was there before. LinkedIn is additive
  // inside applyPhoneClassification, so a mined profile still lands.
  let cleared = 0;
  for (const email of minedEmails) {
    if (handled.has(email)) continue;
    if (++cleared % 25 === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const linkedin = linkedinByEmail.get(email) ?? null;
    await storage.applyPhoneClassification(email, null, null, linkedin);
    if (linkedin) updated += 1;
  }

  // Same org-vs-personal split, generalized to Twitter / website / socials: a
  // URL shared across ≥2 of a domain's senders is the COMPANY's (stored once on
  // the per-domain company record); one unique to a sender is theirs (stored on
  // the contact). LinkedIn already self-distinguishes (/in/ vs /company/) and is
  // handled above, so it's excluded here.
  const { perEmail: urlPerEmail, perDomain: urlPerDomain } = classifyDomainUrls(urlSenders);
  let urlWrites = 0;
  for (const [email, u] of urlPerEmail) {
    if (++urlWrites % 25 === 0) await new Promise((resolve) => setImmediate(resolve));
    if (u.twitter || u.website || u.socials.length) {
      await storage.applyPersonalUrls(email, { twitter: u.twitter, website: u.website, socials: u.socials });
    }
  }
  for (const [domain, u] of urlPerDomain) {
    if (u.twitter || u.website || u.socials.length) {
      await storage.applyCompanyUrls(domain, { twitter: u.twitter, website: u.website, socials: u.socials });
    }
  }
  logger.info(`[Contacts] URL classification: ${urlPerEmail.size} contacts, ${urlPerDomain.size} company domains`);

  return updated;
}

/**
 * Extract contacts from every email in ONE mailbox and record that mailbox's
 * sender stats, returning how many emails were read.
 *
 * Split out of the scan handler so a scan can walk EVERY connected account. The
 * contact directory is shared, but `emails` and `sender_stats` are not: a scan
 * that read only the active account left every correspondent of the user's
 * other addresses missing from a list that is supposed to be one list, and they
 * only appeared if the user happened to switch accounts and scan again.
 *
 * Stats stay per-mailbox deliberately. They are counts of THIS mailbox's mail
 * and are written absolutely, so tallying them across accounts would attribute
 * one account's mail to another and make the totals disagree with the folder.
 */
async function scanMailbox(
  storage: ReturnType<typeof requireStorage>,
  label: string,
): Promise<number> {
  const folders = await storage.getFolders();
  let scanned = 0;

  // address -> absolute counts observed during THIS scan.
  type Tally = {
    receivedCount: number; readCount: number; deletedCount: number;
    repliedCount: number; sentToCount: number;
  };
  const tallies = new Map<string, Tally>();
  const tallyFor = (addr: string): Tally => {
    const key = addr.toLowerCase().trim();
    let t = tallies.get(key);
    if (!t) {
      t = { receivedCount: 0, readCount: 0, deletedCount: 0, repliedCount: 0, sentToCount: 0 };
      tallies.set(key, t);
    }
    return t;
  };

  for (const folder of folders) {
    const folderPath = folder.path?.toLowerCase() || '';
    const isSentFolder = folderPath.includes('sent') || folderPath.includes('[gmail]/sent');
    const isTrashFolder = folderPath.includes('trash') || folderPath.includes('deleted');
    const direction = isSentFolder ? 'sent' : 'received';

    let offset = 0;
    let inFolder = 0;
    const batchSize = 500;
    let hasMore = true;

    while (hasMore) {
      const emails = await storage.getEmailsByFolder(folder.id, { limit: batchSize, offset });

      if (emails.length === 0) {
        hasMore = false;
        break;
      }

      let inBatch = 0;
      for (const email of emails) {
        // Same reason as the contact loop: these awaits resolve as
        // microtasks over synchronous SQLite, so nothing returns to the
        // event loop until the whole folder is done.
        if (++inBatch % 100 === 0) {
          await new Promise((resolve) => setImmediate(resolve));
        }
        await storage.extractContactsFromEmail(email, direction);

        // Counts are TALLIED here and written once at the end, not upserted
        // per email. `upsertSenderStats` ADDS to the stored value, so doing
        // it inline meant every press of "Scan" stacked a fresh full pass on
        // top of the previous totals — counters drifted upward without
        // bound and produced impossible states (read_count 64 against
        // received_count 62 on a mailbox holding 5 of that sender's mails).
        // A full scan reads every email, so it can state the totals
        // absolutely and make re-scanning idempotent.
        if (isSentFolder && email.toAddress) {
          const isReply = !!email.inReplyTo || (email.subject || '').match(/^Re:/i) !== null;
          for (const addr of parseAddresses(email.toAddress)) {
            const t = tallyFor(addr);
            t.sentToCount += 1;
            if (isReply) t.repliedCount += 1;
          }
        } else if (!isSentFolder && email.fromAddress) {
          const t = tallyFor(email.fromAddress);
          t.receivedCount += 1;
          if ((email.tags || '').includes('|read|')) t.readCount += 1;
          if (isTrashFolder) t.deletedCount += 1;
        }
      }

      scanned += emails.length;
      inFolder += emails.length;
      offset += batchSize;

      if (emails.length < batchSize) {
        hasMore = false;
      }
    }

    // Report what was actually read, not the paging offset — a folder holding
    // one email used to log "500 emails" because `offset` jumps by batchSize.
    logger.info(`[Contacts] ${label}: scanned folder "${folder.name}": ${inFolder} emails (${direction})`);
  }

  // Write the tallied totals absolutely, so re-scanning converges instead of
  // accumulating. Falls back to the additive upsert only on storage impls
  // without the absolute setter (in which case re-scan drift remains, but
  // behaviour is unchanged from before).
  if (typeof (storage as any).setSenderStatsCounts === 'function') {
    await (storage as any).setSenderStatsCounts(
      [...tallies.entries()].map(([email, t]) => ({ email, ...t })),
    );
  } else {
    for (const [email, t] of tallies) {
      await storage.upsertSenderStats({ email, ...t });
    }
  }
  logger.info(`[Contacts] ${label}: recorded sender stats for ${tallies.size} addresses`);

  return scanned;
}

export function registerContactsHandlers(): void {
  /**
   * Get contacts with pagination and search
   */
  ipcMain.handle('contacts:list', async (_event, options: { limit: number; offset: number; search?: string; sortBy?: string; sortOrder?: 'asc' | 'desc'; contactType?: string }) => {
    try {
      const storage = requireStorage();
      const contacts = await storage.getContacts(options);
      const total = await storage.getContactsCount(options.search, options.contactType);
      return { success: true, data: { contacts, total } };
    } catch (error) {
      logger.error('Get contacts error:', error);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  });

  /**
   * Get a single contact by ID
   */
  ipcMain.handle('contacts:get', async (_event, id: string, accountId?: string) => {
    try {
      const storage = storageForAccount(accountId);
      const contact = await storage.getContact(id);
      return { success: true, data: contact };
    } catch (error) {
      logger.error('Get contact error:', error);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  });

  /**
   * Update a contact
   */
  ipcMain.handle('contacts:update', async (_event, id: string, updates: any) => {
    try {
      const storage = requireStorage();
      await storage.updateContact(id, updates);
      const updated = await storage.getContact(id);
      return { success: true, data: updated };
    } catch (error) {
      logger.error('Update contact error:', error);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  });

  /**
   * Delete a contact
   */
  ipcMain.handle('contacts:delete', async (_event, id: string) => {
    try {
      const storage = requireStorage();
      await storage.deleteContact(id);
      return { success: true };
    } catch (error) {
      logger.error('Delete contact error:', error);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  });

  /**
   * Recent inbound emails for a contact. Used by the enrichment
   * pipeline in the renderer — signatures come from received mail.
   * Capped at the caller-supplied limit (default 20).
   */
  ipcMain.handle('contacts:recentInbound', async (_event, contactId: string, limit = 20, accountId?: string) => {
    try {
      const storage = storageForAccount(accountId);
      const contact = await storage.getContact(contactId);
      if (!contact) {
        return { success: false, error: 'Contact not found' };
      }
      const emails = await (storage as any).getRecentInboundEmailsForContact(contact.email, limit);
      // Return just the fields the enricher needs — keeps IPC payload
      // reasonable when a contact has long HTML bodies. The repo returns
      // raw email rows: the only body columns are clean_body (cleaned
      // markdown) and raw_body (original HTML or text) — map both shapes
      // defensively in case it switches to camelCase EmailRecords.
      const trimmed = (emails as any[]).map((e: any) => ({
        id: e.id,
        date: e.date,
        subject: e.subject,
        cleanBody: e.clean_body || e.cleanBody || null,
        htmlBody: e.raw_body || e.rawBody || null,
      }));
      return { success: true, data: trimmed };
    } catch (error) {
      logger.error('Recent inbound error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Apply an enrichment result to a contact. Writes the blob, appends
   * to history, resolves identity merges from the shared mobile, and
   * find-or-creates the company contact — all in one transaction on
   * the repository side.
   */
  ipcMain.handle('contacts:applyEnrichment', async (_event, input: any) => {
    try {
      const storage = storageForAccount(input?.accountId);
      const updated = await (storage as any).applyContactEnrichment(input);
      return { success: true, data: updated };
    } catch (error) {
      logger.error('Apply enrichment error:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Bump the enrichment watermark without writing history — used when
   * the enricher scanned recent mail but found no usable signals.
   * Prevents the scheduler from re-queuing the same contact on every
   * tick.
   */
  ipcMain.handle('contacts:recordEnrichmentWatermark', async (_event, contactId: string, throughEmailAt: number, accountId?: string) => {
    try {
      const storage = storageForAccount(accountId);
      await (storage as any).recordContactEnrichmentWatermark(contactId, throughEmailAt);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  // Confirm-gated avatars: the user approving/declining a discovered photo.
  ipcMain.handle('contacts:confirmAvatar', async (_event, contactId: string, accountId?: string) => {
    try {
      await (storageForAccount(accountId) as any).confirmContactAvatar(contactId);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  ipcMain.handle('contacts:rejectAvatar', async (_event, contactId: string, accountId?: string) => {
    try {
      await (storageForAccount(accountId) as any).rejectContactAvatar(contactId);
      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Contact enrichment history — newest first, includes closed rows so
   * the detail view can render "previously at X" when someone has
   * switched jobs.
   */
  ipcMain.handle('contacts:getEnrichmentHistory', async (_event, contactId: string) => {
    try {
      const storage = requireStorage();
      const history = await (storage as any).getContactEnrichmentHistory(contactId);
      return { success: true, data: history };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Related contact rows that share a person_id — same human, different
   * emails (new job, personal vs work, etc.).
   */
  ipcMain.handle('contacts:getRelatedByPerson', async (_event, contactId: string) => {
    try {
      const storage = requireStorage();
      const related = await (storage as any).getContactsRelatedByPerson(contactId);
      return { success: true, data: related };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  });

  /**
   * Scan ALL existing emails to extract contacts
   */
  ipcMain.handle('contacts:scan', async () => {
    try {
      const storage = requireStorage();
      // The directory is shared, so any account's connection writes the same
      // rows — but the MAIL to read them out of lives in each account's own DB.
      const runtimes = getAllAccountRuntimes();
      const mailboxes: Array<[string, ReturnType<typeof requireStorage>]> =
        runtimes.length > 0
          ? runtimes.map(([id, rt]) => [id, rt.storage as ReturnType<typeof requireStorage>])
          : [['this account', storage]];
      logger.info(`[Contacts] Starting full scan of ${mailboxes.length} mailbox(es)...`);

      let totalScanned = 0;
      for (const [accountId, mailbox] of mailboxes) {
        try {
          totalScanned += await scanMailbox(mailbox, accountId);
        } catch (err) {
          // One mailbox failing (a locked DB mid-sync, usually transient) must
          // not cost the scan every OTHER account's contacts.
          logger.error(`[Contacts] Scan skipped mailbox ${accountId}:`, err);
        }
      }

      const total = await storage.getContactsCount();
      logger.info(`[Contacts] Scan complete. Total emails scanned: ${totalScanned}, Total contacts: ${total}`);

      // Cross-domain phone classification (office vs personal) over the freshly
      // scanned contacts — deterministic, no LLM.
      let phonesClassified = 0;
      try {
        phonesClassified = await classifyContactPhones(storage);
        logger.info(`[Contacts] Phone classification updated ${phonesClassified} contacts`);
      } catch (err) {
        logger.error('[Contacts] Phone classification failed:', err);
      }

      return { success: true, data: { scanned: true, totalContacts: total, emailsScanned: totalScanned, phonesClassified } };
    } catch (error) {
      logger.error('Scan contacts error:', error);
      return {
        success: false,
        error: (error as Error).message,
      };
    }
  });
}
