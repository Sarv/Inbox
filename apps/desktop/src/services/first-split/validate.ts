/**
 * Checking the model's split of the first email, and building the parts that
 * are stored — pure functions over strings, the regions and Standard's turns.
 *
 * The model is trusted for exactly one thing: WHERE one message ends and the
 * next begins inside a region. Everything it says is checked against the text
 * it was given, and anything that fails keeps Standard's rendering instead:
 *
 *   * an output must name a region of its chunk, and its text must be FOUND in
 *     that chunk (grounding) — an invented or paraphrased message is dropped;
 *   * its body is cleaned with the library's own segment recipe
 *     (`cleanFragment`), exactly as Standard cleans a quote, and must still
 *     have visible text;
 *   * a lone output that keeps under a quarter of a long region's message
 *     (its attribution line not counted) is a husk (a salutation standing in
 *     for a whole message) and is dropped;
 *   * then COVERAGE: every segment Standard carved out of the first email must
 *     have every line kept by the outputs holding its text (coverage.ts — a
 *     signature the model was told to drop excepted), or Standard's segment
 *     is kept as a fallback part and those partial outputs are dropped. So the
 *     AI can add messages Standard missed, and can never lose text Standard
 *     had — a skipped message, one cut short, or a first email whose
 *     boundaries the library missed entirely (one segment holding the whole
 *     chain) all fall back to Standard.
 */
import {
  cleanAttributionName,
  cleanFragment,
  extractEmailFrom,
  hasVisibleContent,
  parseHumanDate,
  resolveParser,
  type ChatMessage,
} from '@sarv-in/email-chat-view/transform';
import type { EmailRecord } from '@sarvinbox/core';
import { isReadableDate } from '@sarvinbox/core/conversation-membership';
import type { FirstSplitPart, FirstSplitRosterEntry } from '@sarvinbox/core/first-split';

import { isSameContent, normalizedContent } from '../../components/email-detail/chat-message-adapter';
import { clampQuoteDate } from '../../components/email-detail/turn-order';
import { cleanLLMJsonResponse, parseLLMJson } from '../../utils/llm-json';

import { keepsEveryLine, segmentLines, type SegmentLine } from './coverage';
import { withImageRefs, type RegionChunk, type RegionOptions, type SplitRegion } from './regions';

/** How much of an output's normalized text must be found in its chunk. */
const GROUNDING_KEY_CHARS = 150;
/** A region at least this long (normalized) can hold a husk. */
const HUSK_MIN_REGION_CHARS = 200;
/** A lone output keeping less than this share of its region is a husk. */
const HUSK_MAX_SHARE = 0.25;

/** The model's answer, parsed. */
export interface ParsedSplitResponse {
  /** The entries, unchecked. */
  messages: unknown[];
  /**
   * The response was cut off (it does not end in `}` / `]`) and only parsed
   * after repair: its LAST entry may have lost the end of its body.
   */
  truncated: boolean;
}

/**
 * Parse the model's answer, or null when it has no `messages` array — an
 * `unparseable` answer (models are not deterministic: retried once, then a
 * permanent failure; see core `nextFailureState`).
 */
export function parseSplitResponse(raw: string): ParsedSplitResponse | null {
  let parsed: unknown;
  try {
    parsed = parseLLMJson(raw);
  } catch {
    return null;
  }
  const messages = Array.isArray(parsed)
    ? parsed
    : parsed && typeof parsed === 'object' && Array.isArray((parsed as { messages?: unknown }).messages)
      ? (parsed as { messages: unknown[] }).messages
      : null;
  if (!messages) return null;
  return { messages, truncated: !/[}\]]\s*$/.test(cleanLLMJsonResponse(raw)) };
}

/** An output that passed every per-output check. */
export interface AcceptedOutput {
  /** The region its text was found in (the one it named, when that holds it). */
  region: number;
  /** The sender as the model wrote it (unresolved). */
  fromAddress: string;
  /**
   * The address in `fromAddress` appears in the region's own text. An
   * address the text does not carry (and the roster does not know) is the
   * model's invention and never beats the attribution Standard parsed.
   */
  addressInText: boolean;
  fromName: string | null;
  /** The date as the model copied it (unparsed). */
  date: string;
  /** Cleaned HTML. */
  body: string;
  /** `normalizedContent(body)`. */
  key: string;
}

/** Why an output was not accepted — counted in the run's log line. */
export type RejectReason = 'shape' | 'region' | 'truncated' | 'empty' | 'ungrounded' | 'husk';

export interface ChunkValidation {
  accepted: AcceptedOutput[];
  rejected: RejectReason[];
}

const asString = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Clean one output body with Standard's segment recipe; '' when it cannot be parsed. */
function cleanBody(html: string, parser?: (html: string) => Document): string {
  try {
    const body = resolveParser(parser)(html).body;
    return body ? cleanFragment(body).html : '';
  } catch {
    return '';
  }
}

/** The chunk's region whose text holds `probe`, preferring the one the model named. */
function groundedRegion(chunk: RegionChunk, named: SplitRegion, probe: string): SplitRegion | null {
  if (named.text.includes(probe)) return named;
  return chunk.regions.find((region) => region.text.includes(probe)) ?? null;
}

/**
 * Check one chunk's outputs. `truncated` drops the LAST output — its body may
 * have been cut mid-message, and a cut body would pass every check.
 */
export function validateChunkOutputs(
  messages: readonly unknown[],
  chunk: RegionChunk,
  options: { truncated: boolean; parser?: (html: string) => Document },
): ChunkValidation {
  const rejected: RejectReason[] = [];
  const candidates: Array<AcceptedOutput & { regionChars: number }> = [];
  const byIndex = new Map(chunk.regions.map((region) => [region.index, region]));

  messages.forEach((entry, position) => {
    if (!entry || typeof entry !== 'object') {
      rejected.push('shape');
      return;
    }
    const record = entry as Record<string, unknown>;
    const named = typeof record.region === 'number' && Number.isInteger(record.region)
      ? byIndex.get(record.region)
      : undefined;
    if (!named) {
      rejected.push('region');
      return;
    }
    if (options.truncated && position === messages.length - 1) {
      rejected.push('truncated');
      return;
    }
    const body = cleanBody(asString(record.body), options.parser);
    const key = normalizedContent(body);
    if (!hasVisibleContent(body) || !key) {
      rejected.push('empty');
      return;
    }
    const region = groundedRegion(chunk, named, key.slice(0, GROUNDING_KEY_CHARS));
    if (!region) {
      rejected.push('ungrounded');
      return;
    }
    const fromAddress = asString(record.from_address).trim();
    const address = extractEmailFrom(fromAddress);
    candidates.push({
      region: region.index,
      fromAddress,
      addressInText: !!address && region.html.toLowerCase().includes(address.toLowerCase()),
      fromName: asString(record.from_name).trim() || null,
      date: asString(record.date).trim(),
      body,
      key,
      regionChars: region.messageChars,
    });
  });

  // The husk check needs every output of a region, so it runs once they are in.
  const perRegion = new Map<number, number>();
  for (const candidate of candidates) perRegion.set(candidate.region, (perRegion.get(candidate.region) ?? 0) + 1);
  const accepted: AcceptedOutput[] = [];
  for (const { regionChars, ...output } of candidates) {
    const lone = perRegion.get(output.region) === 1;
    if (lone && regionChars >= HUSK_MIN_REGION_CHARS && output.key.length < HUSK_MAX_SHARE * regionChars) {
      rejected.push('husk');
      continue;
    }
    accepted.push(output);
  }
  return { accepted, rejected };
}

/** What the parts are built from. */
export interface BuildPartsInput {
  /** Every chunk's accepted outputs, in chunk order. */
  accepted: readonly AcceptedOutput[];
  /**
   * Standard's turns CARRIED BY the first email, before the host's dedupe (the
   * library split of `[first]`): its own turn (id = first.id) and its quotes
   * (sourceId = first.id).
   */
  standard: readonly ChatMessage[];
  first: Pick<EmailRecord, 'id' | 'fromAddress' | 'fromName' | 'date'>;
  /** The thread members' distinct senders — resolves a name the model gave without an address. */
  roster: readonly FirstSplitRosterEntry[];
  /** Some chunk's answer was cut off. */
  truncated: boolean;
  /** Unix seconds; stands in for the first email's date when that is unreadable. */
  nowSeconds: number;
  /** Turns a fallback body's `data:` images into refs; the image cache by default. */
  registerImage?: RegionOptions['registerImage'];
  /** HTML parser; the global DOMParser by default. */
  parser?: RegionOptions['parser'];
}

export interface BuiltParts {
  status: 'ok' | 'partial' | 'failed';
  errorKind?: 'unusable';
  /** Oldest first; the own part (when there is one) last. Empty when failed. */
  parts: FirstSplitPart[];
  /** Parts from accepted AI outputs. */
  aiParts: number;
  /** Parts that are Standard's rendering of something the AI did not cover. */
  fallbackParts: number;
}

const normalizedName = (name: string | null | undefined): string =>
  (name ?? '').replace(/\s+/g, ' ').trim().toLowerCase();

const lowerAddress = (address: string | null | undefined): string => (address ?? '').trim().toLowerCase();

/** The one roster address carrying this display name, or null (none, or ambiguous). */
function rosterAddressFor(roster: readonly FirstSplitRosterEntry[], name: string | null | undefined): string | null {
  const wanted = normalizedName(name);
  if (!wanted) return null;
  const addresses = new Set(
    roster.filter((entry) => normalizedName(entry.name) === wanted).map((entry) => lowerAddress(entry.address)),
  );
  if (addresses.size !== 1) return null;
  return roster.find((entry) => normalizedName(entry.name) === wanted)!.address;
}

function rosterNameFor(roster: readonly FirstSplitRosterEntry[], address: string): string | null {
  const wanted = lowerAddress(address);
  return roster.find((entry) => lowerAddress(entry.address) === wanted)?.name ?? null;
}

/**
 * A quoted message's sender: the address the model wrote — when the region's
 * text or the roster carries it — then what Standard's segment read off the
 * attribution line, then a roster match on the name the model wrote (a mangled
 * attribution loses the address and keeps the name), then ''.
 */
function senderOf(
  output: Pick<AcceptedOutput, 'fromAddress' | 'fromName' | 'addressInText'>,
  segment: ChatMessage | undefined,
  roster: readonly FirstSplitRosterEntry[],
): { fromAddress: string; fromName: string | null } {
  const written = extractEmailFrom(output.fromAddress);
  const grounded = written && (output.addressInText || rosterNameFor(roster, written) !== null) ? written : null;
  const fromAddress = grounded
    ?? extractEmailFrom(segment?.fromAddress)
    ?? rosterAddressFor(roster, output.fromName)
    // A model (like the library, for a quote with no address) sometimes puts
    // the NAME in the address field.
    ?? rosterAddressFor(roster, output.fromAddress)
    ?? rosterAddressFor(roster, segment?.fromName)
    ?? '';
  // The name the model copied (tidied), then the roster's name for the
  // address, then Standard's, and only then one derived from the address —
  // the library's own last resort ("anish.sharma3@x" → "Anish Sharma").
  const tidied = output.fromName ? cleanAttributionName(output.fromName) : null;
  const fromName = tidied
    ?? (fromAddress ? rosterNameFor(roster, fromAddress) : null)
    ?? segment?.fromName
    ?? cleanAttributionName(null, fromAddress || null);
  return { fromAddress, fromName };
}

/** One of Standard's turns carried by the first email, read for the no-loss check. */
interface Segment {
  turn: ChatMessage;
  key: string;
  lines: SegmentLine[];
  /** The first email's own turn (not a quote it carries). */
  own: boolean;
}

const anchorOf = (key: string): string => key.slice(0, GROUNDING_KEY_CHARS);

/** An output holds text of a segment: one's opening is found inside the other. */
const holdsTextOf = (output: AcceptedOutput, segment: Segment): boolean =>
  segment.key.includes(anchorOf(output.key)) || output.key.includes(anchorOf(segment.key));

/** Two keys open identically, as far as the shorter one (or the anchor) goes. */
function sharesOpening(left: string, right: string): boolean {
  const length = Math.min(GROUNDING_KEY_CHARS, left.length, right.length);
  return length > 0 && left.slice(0, length) === right.slice(0, length);
}

const lastOf = <T>(items: readonly T[]): T | undefined => items[items.length - 1];

/** A part kept so far, for the duplicate check. */
interface KeptPart {
  key: string;
  part: FirstSplitPart;
}

/**
 * Build the parts from every chunk's accepted outputs, with Standard's
 * segments as the floor.
 *
 *   * COVERAGE first (coverage.ts): a segment is kept when the outputs holding
 *     its text keep every line of it. An output that holds text ONLY of
 *     segments it failed to keep is dropped — Standard's segment is shown
 *     instead, and a partial copy beside it would repeat it.
 *   * The OWN part (the sender's own words): among region-0 outputs that open
 *     exactly as Standard's own turn does, the last one (the prompt puts the
 *     own entry last), preferring the email's sender — never merely one whose
 *     text is somewhere inside Standard's own turn, which, when the library
 *     found no boundaries, is the whole chain. With no such output, or Standard's
 *     own turn not kept, Standard's own turn IS the own part. When Standard has
 *     no own turn (a forward with no comment), the last region-0 output from
 *     the sender.
 *   * Every other kept output is a QUOTE part, dated from the date the model
 *     copied (parsed day-first by the library, anchored to the email), clamped
 *     by the library's quote rule — never later than the email; a missing
 *     date becomes the email's time minus one millisecond per level, marked
 *     approximate — or else from the Standard segment it covers. The same
 *     message twice in the answer is one part, the LONGER copy's body.
 *   * A Standard quote segment not kept becomes a FALLBACK part, its images
 *     as refs like every stored body.
 *   * Status: no AI part left → failed/unusable; any fallback, or a cut-off
 *     answer → partial; otherwise ok.
 */
export function buildParts(input: BuildPartsInput): BuiltParts {
  const { accepted, first, roster } = input;
  const failed: BuiltParts = { status: 'failed', errorKind: 'unusable', parts: [], aiParts: 0, fallbackParts: 0 };
  if (accepted.length === 0) return failed;

  const carrierSeconds = isReadableDate(first.date) ? first.date : input.nowSeconds;
  const carrierMs = carrierSeconds * 1000;
  const refDate = new Date(carrierMs);
  const imageOptions = { registerImage: input.registerImage, parser: input.parser };

  const segments: Segment[] = input.standard
    .filter((turn) => (turn.sourceId ?? turn.id) === first.id)
    .map((turn) => ({ turn, key: normalizedContent(turn.body), own: !turn.sourceId }))
    .filter((segment) => segment.key)
    .map((segment) => ({ ...segment, lines: segmentLines(segment.turn.body) }));
  const ownSegment = segments.find((segment) => segment.own);
  const quoteSegments = segments.filter((segment) => !segment.own);

  // Coverage: which segments each output holds text of, and which segments
  // those outputs keep whole.
  const homes = new Map(accepted.map((output) => [output, segments.filter((segment) => holdsTextOf(output, segment))]));
  const homesOf = (output: AcceptedOutput): Segment[] => homes.get(output) ?? [];
  const kept = new Set(segments.filter((segment) => keepsEveryLine(
    segment.lines,
    accepted.filter((output) => homesOf(output).includes(segment)).map((output) => output.key),
  )));

  const ownPart = (body: string, fallback: boolean): FirstSplitPart => ({
    role: 'own',
    fromAddress: first.fromAddress || '',
    fromName: first.fromName ?? null,
    date: carrierSeconds,
    dateApprox: !isReadableDate(first.date),
    body,
    fallback,
  });

  // 1. The own part.
  const sender = lowerAddress(first.fromAddress);
  const isFromSender = (output: AcceptedOutput) =>
    sender !== '' && lowerAddress(extractEmailFrom(output.fromAddress)) === sender;
  let ownOutput: AcceptedOutput | undefined;
  if (ownSegment) {
    if (kept.has(ownSegment)) {
      const opening = accepted.filter((output) =>
        output.region === 0 && homesOf(output).includes(ownSegment) && sharesOpening(output.key, ownSegment.key));
      ownOutput = lastOf(opening.filter(isFromSender)) ?? lastOf(opening);
    }
    // No output IS the sender's own words: Standard's own turn stands, and no
    // output may stand in for any part of it.
    if (!ownOutput) kept.delete(ownSegment);
  } else {
    ownOutput = lastOf(accepted.filter((output) => output.region === 0 && isFromSender(output)));
  }
  let own: FirstSplitPart | null = null;
  if (ownOutput) own = ownPart(ownOutput.body, false);
  else if (ownSegment) own = ownPart(withImageRefs(ownSegment.turn.body, imageOptions), true);

  // 2. Quote parts from the AI — numbered down the page (region, then newest
  // first within a region: the model answers oldest first) for the date rule.
  // An output holding text only of segments it did not keep is dropped.
  const quoteOutputs = accepted
    .map((output, order) => ({ output, order }))
    .filter(({ output }) => output !== ownOutput)
    .filter(({ output }) => homesOf(output).length === 0 || homesOf(output).some((segment) => kept.has(segment)))
    .sort((a, b) => a.output.region - b.output.region || b.order - a.order)
    .map(({ output }) => output);

  const keptParts: KeptPart[] = own ? [{ key: normalizedContent(own.body), part: own }] : [];
  // The same message twice: the same content rule the AI view dedupes with,
  // or — for a body too short for it — one opening the other, from the same
  // sender (a short "OK" from someone else is a message of its own).
  const duplicateOf = (key: string, fromAddress: string) => keptParts.find((each) =>
    isSameContent(key, each.key)
    || (sharesOpening(key, each.key) && lowerAddress(fromAddress) !== ''
      && lowerAddress(each.part.fromAddress) === lowerAddress(fromAddress)));

  let aiQuotes = 0;
  quoteOutputs.forEach((output, position) => {
    const segment = homesOf(output).find((each) => !each.own)?.turn;
    const from = senderOf(output, segment, roster);
    const duplicate = duplicateOf(output.key, from.fromAddress);
    if (duplicate) {
      // Keeping the shorter copy would lose the rest of the message.
      if (!duplicate.part.fallback && output.key.length > duplicate.key.length) {
        duplicate.part.body = output.body;
        duplicate.key = output.key;
      }
      return;
    }
    const read = parseHumanDate(output.date, refDate)
      ?? (segment && !segment.dateApprox && Number.isFinite(segment.date) ? segment.date : null);
    const { dateMs, approx } = clampQuoteDate(read, carrierMs, position + 1);
    const part: FirstSplitPart = {
      role: 'quote',
      ...from,
      date: dateMs / 1000,
      dateApprox: approx,
      body: output.body,
      fallback: false,
    };
    keptParts.push({ key: output.key, part });
    aiQuotes += 1;
  });
  const aiParts = aiQuotes + (own && !own.fallback ? 1 : 0);
  if (aiParts === 0) return failed;

  // 3. Fallback parts: Standard's quote segments the outputs did not keep.
  const quotes = keptParts.filter((each) => each.part !== own).map((each) => each.part);
  let fallbackParts = own?.fallback ? 1 : 0;
  quoteSegments.forEach((segment, position) => {
    if (kept.has(segment)) return;
    const { turn } = segment;
    const readable = Number.isFinite(turn.date);
    quotes.push({
      role: 'quote',
      ...senderOf({ fromAddress: turn.fromAddress, fromName: turn.fromName ?? null, addressInText: true }, undefined, roster),
      date: (readable ? turn.date : carrierMs - (position + 1)) / 1000,
      dateApprox: turn.dateApprox === true || !readable,
      body: withImageRefs(turn.body, imageOptions),
      fallback: true,
    });
    fallbackParts += 1;
  });

  // Oldest first (stable), the sender's own words last.
  const parts = [...quotes].sort((a, b) => a.date - b.date);
  if (own) parts.push(own);
  return {
    status: fallbackParts > 0 || input.truncated ? 'partial' : 'ok',
    parts,
    aiParts,
    fallbackParts,
  };
}
