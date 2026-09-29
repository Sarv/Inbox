/**
 * The first email's body, cut into RAW regions at its quote boundaries, and
 * packed into chunks the model can take.
 *
 * Region 0 is the sender's own text; region k (k ≥ 1) is the k-th quoted
 * message down the page, STARTING with its attribution line ("On … wrote:",
 * an Outlook From:/Sent: block) so the model reads that message's sender and
 * date from it. The boundaries are the chat-view library's own
 * (`findBoundaries`), and the cuts are made with its `sliceBetween`, so a
 * region is exactly the stretch of body the Standard view turned into one
 * bubble — which is what lets the answer be checked region by region.
 *
 * RAW is the point. Nothing is cleaned before the cut: Standard's per-segment
 * cleaning deletes signatures, "Sent from my iPhone" footers and sign-offs,
 * and on a mangled history those cuts sometimes take real messages with them.
 * The model sees what the email actually carries. Only what carries no text
 * is removed: `<head>`, `<style>`, `<script>`, `<meta>`, `<link>`, `<title>`,
 * comments (Outlook's MSO conditionals included) — and a base64 `data:`
 * image's kilobytes become a short `sarv-image:` ref (the renderer resolves
 * it back at display time; see {@link registerDataImages} for which ones).
 *
 * No size-driven loss: a history too long for one request is sent in up to
 * {@link MAX_CHUNKS} chunks, cut at region boundaries. A region that cannot
 * fit is not shrunk — it keeps Standard's rendering (validate.ts builds its
 * fallback part from Standard's segment).
 */
import {
  findBoundaries,
  hasVisibleContent,
  resolveParser,
  sliceBetween,
  type Boundary,
  type ParsedAttribution,
} from '@sarv-in/email-chat-view/transform';

import { normalizedContent } from '../../components/email-detail/chat-message-adapter';
import { isRestorableDataUrl, registerImage as registerCachedImage } from '../image-cache';

import { CHUNK_BUDGET_CHARS, MAX_CHUNKS, regionOverheadChars } from './prompt';

/** One region of the first email's body. */
export interface SplitRegion {
  /** 0 = the sender's own text; k = the k-th quoted message down the page. */
  index: number;
  /** The region's prepared RAW HTML (region k ≥ 1 opens with its attribution line). */
  html: string;
  /** `normalizedContent(html)` — what grounding compares against. */
  text: string;
  /**
   * Normalized length of the message ALONE: the region without its
   * attribution line. The husk check measures against this — an Outlook
   * From/Sent/To/Cc/Subject block can be most of a short reply's region, and
   * counting it would call "Approved, go ahead." a husk.
   */
  messageChars: number;
  /** Sender and date read off the attribution line; null for region 0 or an unparsed line. */
  attribution: ParsedAttribution | null;
}

/** Regions sent to the model in one request. */
export interface RegionChunk {
  regions: SplitRegion[];
  /** Region HTML plus marker overhead, in characters. */
  chars: number;
  /** Holds region 0 — decides the prompt variant. */
  includesOwnRegion: boolean;
}

/** How a body's regions are sent. */
export interface ChunkPlan {
  chunks: RegionChunk[];
  /**
   * Regions no request carries — over budget on their own, or past the last
   * chunk. They keep Standard's rendering.
   */
  fallbackRegions: SplitRegion[];
  /**
   * Nothing can be sent at all (every region with content is over budget).
   * Named limitation: a body with NO boundaries is one region, and when that
   * region is over budget the split fails as `too_large` — there is no cut
   * point to chunk it at.
   */
  tooLarge: boolean;
}

/** How regions are made. Injected in tests; the defaults are the renderer's own. */
export interface RegionOptions {
  /** The email's send time — anchors relative attribution dates ("On Monday"). */
  sentAt?: Date;
  /** Turns a `data:` image URL into a short ref; the image cache by default. */
  registerImage?: (dataUrl: string) => string;
  /** HTML parser; the global DOMParser by default. */
  parser?: (html: string) => Document;
}

/** Elements that carry no text the model needs. */
const NOISE_SELECTOR = 'head, style, script, meta, link, title';

const COMMENT_NODE = 8;

/** Remove every comment node under `root` — MSO conditionals included. */
function removeComments(root: Node): void {
  for (const child of [...root.childNodes]) {
    if (child.nodeType === COMMENT_NODE) root.removeChild(child);
    else removeComments(child);
  }
}

/**
 * Turn every restorable `data:` image under `root` into a short ref, in place.
 * Only a canonical base64 image URL ({@link isRestorableDataUrl}) is swapped:
 * refs end up in PERSISTED parts, and after a restart the cache is refilled
 * from the rawBody by the populate walk, which finds only that shape. Any
 * other `data:` src stays inline — a few more bytes, never a broken image.
 */
function registerDataImages(root: ParentNode, registerImage: (dataUrl: string) => string): void {
  for (const img of [...root.querySelectorAll('img[src]')]) {
    const src = (img.getAttribute('src') ?? '').trim();
    if (isRestorableDataUrl(src)) img.setAttribute('src', registerImage(src));
  }
}

/**
 * Strip what carries no text, in place, with DOM operations (the regex pass
 * this replaces could cut through an attribute or a nested comment).
 */
export function prepareDocument(doc: Document, registerImage: (dataUrl: string) => string): void {
  for (const element of [...doc.querySelectorAll(NOISE_SELECTOR)]) element.remove();
  removeComments(doc);
  registerDataImages(doc, registerImage);
}

/**
 * `html` with its `data:` images as short `sarv-image:` refs — the form every
 * stored part body takes. Standard's segments are built from the record main
 * returned, whose inline images arrive inflated back to `data:` URIs; stored
 * as they are, one fallback part could carry megabytes of base64 into the
 * one-row-per-thread cache. Returns `html` unchanged when it has no `data:`
 * image or cannot be parsed (a fat part beats a lost one).
 */
export function withImageRefs(html: string, options: Pick<RegionOptions, 'registerImage' | 'parser'> = {}): string {
  if (!/data:/i.test(html)) return html;
  try {
    const body = resolveParser(options.parser)(html).body;
    if (!body) return html;
    registerDataImages(body, options.registerImage ?? registerCachedImage);
    return body.innerHTML;
  } catch {
    return html;
  }
}

/**
 * Cut `rawBody` into regions, or return null when it cannot be parsed (empty,
 * no DOM). A body with no boundaries is ONE region: the whole email.
 */
export function splitRegions(rawBody: string | null | undefined, options: RegionOptions = {}): SplitRegion[] | null {
  if (!rawBody || !rawBody.trim()) return null;
  let doc: Document;
  try {
    doc = resolveParser(options.parser)(rawBody);
  } catch {
    return null;
  }
  const body = doc.body;
  if (!body) return null;

  prepareDocument(doc, options.registerImage ?? registerCachedImage);

  // A marker element just BEFORE each boundary's attribution line: region k
  // then runs from after marker k-1 to before marker k, attribution included.
  // Positions (the library's boundaries) become nodes the slicer can cut at.
  const markers: Element[] = [];
  const boundaries: Boundary[] = [];
  for (const boundary of findBoundaries(body, options.sentAt)) {
    const parent = boundary.endBefore.parentNode;
    if (!parent) continue;
    const marker = doc.createElement('sarv-region-cut');
    parent.insertBefore(marker, boundary.endBefore);
    markers.push(marker);
    boundaries.push(boundary);
  }

  const regions: SplitRegion[] = [];
  for (let index = 0; index <= markers.length; index++) {
    const endBefore = markers[index] ?? null;
    const html = sliceBetween(body, { startAfter: index === 0 ? null : markers[index - 1], endBefore }).innerHTML.trim();
    const text = normalizedContent(html);
    const boundary = index === 0 ? null : boundaries[index - 1];
    // The message alone starts where the library's attribution line ends.
    const messageChars = boundary
      ? normalizedContent(sliceBetween(body, { startAfter: boundary.startAfter, endBefore }).innerHTML).length
      : text.length;
    regions.push({ index, html, text, messageChars, attribution: boundary?.attribution ?? null });
  }
  return regions;
}

/** A region's cost in a prompt. */
function regionChars(region: SplitRegion): number {
  return region.html.length + regionOverheadChars(region.index);
}

/**
 * Pack consecutive regions into at most `maxChunks` chunks of at most
 * `budget` characters each. Regions with no visible content are skipped (an
 * empty region 0 is a forward with no comment); a region over budget on its
 * own, or one that no chunk has room for, becomes a fallback region.
 */
export function chunkRegions(
  regions: readonly SplitRegion[],
  budget: number = CHUNK_BUDGET_CHARS,
  maxChunks: number = MAX_CHUNKS,
): ChunkPlan {
  const chunks: RegionChunk[] = [];
  const fallbackRegions: SplitRegion[] = [];
  let current: RegionChunk | null = null;

  for (const region of regions) {
    if (!hasVisibleContent(region.html)) continue;
    const chars = regionChars(region);
    if (chars > budget) {
      fallbackRegions.push(region);
      continue;
    }
    if (current && current.chars + chars <= budget) {
      current.regions.push(region);
      current.chars += chars;
      if (region.index === 0) current.includesOwnRegion = true;
      continue;
    }
    if (chunks.length >= maxChunks) {
      fallbackRegions.push(region);
      continue;
    }
    current = { regions: [region], chars, includesOwnRegion: region.index === 0 };
    chunks.push(current);
  }

  return { chunks, fallbackRegions, tooLarge: chunks.length === 0 && fallbackRegions.length > 0 };
}
