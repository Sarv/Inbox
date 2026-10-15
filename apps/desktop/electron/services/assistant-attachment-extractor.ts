import path from 'node:path';

import DOMMatrix from '@thednp/dommatrix';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { strFromU8, unzipSync } from 'fflate';

import {
  ASSISTANT_ATTACHMENT_LIMITS as LIMIT,
  assistantAttachmentFailure,
  type AssistantAttachmentExtraction,
  type AssistantAttachmentLocator,
  type AssistantAttachmentSegment,
} from './assistant-attachment-types';

type XmlNode = Record<string, unknown>;

class ExtractionError extends Error {
  constructor(readonly status: 'malformed' | 'too_large' | 'password_protected') {
    super(status);
  }
}

class EvidenceCollector {
  readonly segments: AssistantAttachmentSegment[] = [];
  characters = 0;
  truncated = false;

  get full(): boolean {
    return this.characters >= LIMIT.characters || this.segments.length >= LIMIT.segments;
  }

  add(raw: string, locator: AssistantAttachmentLocator): void {
    const text = raw.split('\u0000').join('').replace(/[\t ]+/g, ' ').trim();
    if (!text) return;
    for (let offset = 0; offset < text.length; offset += LIMIT.segmentCharacters) {
      if (this.full) { this.truncated = true; return; }
      const remaining = LIMIT.characters - this.characters;
      const part = text.slice(offset, offset + Math.min(remaining, LIMIT.segmentCharacters));
      this.segments.push({ text: part, locator });
      this.characters += part.length;
      if (part.length < Math.min(LIMIT.segmentCharacters, text.length - offset)) {
        this.truncated = true;
        return;
      }
    }
  }

  result(empty: 'empty' | 'scanned' = 'empty'): AssistantAttachmentExtraction {
    return { status: this.segments.length ? 'ready' : empty, segments: this.segments, truncated: this.truncated };
  }
}

function checkAbort(signal?: AbortSignal): void { signal?.throwIfAborted(); }

function xml(raw: Uint8Array): XmlNode[] {
  const text = strFromU8(raw);
  // OOXML needs no external declarations. Reject them before invoking a parser.
  if (/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(text) || XMLValidator.validate(text) !== true)
    throw new ExtractionError('malformed');
  return new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    parseTagValue: false,
    parseAttributeValue: false,
    trimValues: false,
    processEntities: false,
  }).parse(text) as XmlNode[];
}

function decodeXml(text: string): string {
  return text.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/gi, entity => {
    const named: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };
    if (named[entity]) return named[entity];
    const hex = /^&#x/i.test(entity);
    const code = Number.parseInt(entity.slice(hex ? 3 : 2, -1), hex ? 16 : 10);
    return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}

function* elements(nodes: XmlNode[], name: string, depth = 0): Generator<XmlNode> {
  if (depth > 80) throw new ExtractionError('malformed');
  for (const node of nodes) {
    for (const [key, value] of Object.entries(node)) {
      if (key === name || key.split(':').at(-1) === name) yield node;
      if (Array.isArray(value)) yield* elements(value as XmlNode[], name, depth + 1);
    }
  }
}

function children(node: XmlNode, name: string): XmlNode[] {
  const entry = Object.entries(node).find(([key]) => key === name || key.split(':').at(-1) === name);
  return Array.isArray(entry?.[1]) ? entry[1] as XmlNode[] : [];
}

function attribute(node: XmlNode, name: string): string {
  const attributes = node[':@'] as Record<string, unknown> | undefined;
  return decodeXml(String(attributes?.[`@_${name}`] ?? ''));
}

function nodeText(nodes: XmlNode[], depth = 0, currentWordText = false): string {
  if (depth > 80) throw new ExtractionError('malformed');
  let value = '';
  for (const node of nodes) {
    for (const [key, child] of Object.entries(node)) {
      if (currentWordText && ['del', 'delText', 'moveFrom', 'instrText'].includes(key.split(':').at(-1) ?? '')) continue;
      if (key === '#text') value += decodeXml(String(child));
      else if (key.endsWith(':tab') || key === 'tab') value += '\t';
      else if (key.endsWith(':br') || key === 'br') value += '\n';
      else if (Array.isArray(child)) value += nodeText(child as XmlNode[], depth + 1, currentWordText);
    }
  }
  return value;
}

function readOfficeZip(bytes: Uint8Array, kind: 'docx' | 'xlsx'): Record<string, Uint8Array> {
  if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
    // Office encrypted OOXML uses an OLE container, not a normal ZIP.
    if (bytes[0] === 0xd0 && bytes[1] === 0xcf) throw new ExtractionError('password_protected');
    throw new ExtractionError('malformed');
  }
  let count = 0;
  let total = 0;
  const selected = new Set<string>();
  return unzipSync(bytes, { filter: file => {
    if (++count > LIMIT.zipEntries) throw new ExtractionError('too_large');
    const name = file.name;
    if (name.includes('\\') || name.startsWith('/') || name.split('/').includes('..'))
      throw new ExtractionError('malformed');
    total += file.originalSize;
    if (total > LIMIT.uncompressedBytes) throw new ExtractionError('too_large');
    const needed = kind === 'docx'
      ? name === 'word/document.xml'
      : /^(?:xl\/(?:workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml))$/.test(name);
    if (!needed) return false;
    if (file.originalSize > LIMIT.xmlEntryBytes) throw new ExtractionError('too_large');
    if (selected.has(name)) throw new ExtractionError('malformed');
    selected.add(name);
    return true;
  } });
}

function docx(bytes: Uint8Array, evidence: EvidenceCollector, signal?: AbortSignal): void {
  const files = readOfficeZip(bytes, 'docx');
  if (!files['word/document.xml']) throw new ExtractionError('malformed');
  let paragraph = 0;
  for (const node of elements(xml(files['word/document.xml']), 'p')) {
    checkAbort(signal);
    paragraph++;
    evidence.add(nodeText(children(node, 'p'), 0, true), { kind: 'paragraph', paragraph, label: `Paragraph ${paragraph}` });
    if (evidence.full) { evidence.truncated = true; break; }
  }
}

function xlsx(bytes: Uint8Array, evidence: EvidenceCollector, signal?: AbortSignal): void {
  const files = readOfficeZip(bytes, 'xlsx');
  if (!files['xl/workbook.xml'] || !files['xl/_rels/workbook.xml.rels']) throw new ExtractionError('malformed');
  const sharedStrings = files['xl/sharedStrings.xml']
    ? [...elements(xml(files['xl/sharedStrings.xml']), 'si')].map(node => nodeText(children(node, 'si')))
    : [];
  const relationships = new Map<string, string>();
  for (const node of elements(xml(files['xl/_rels/workbook.xml.rels']), 'Relationship')) {
    if (attribute(node, 'TargetMode') === 'External') continue;
    const target = attribute(node, 'Target');
    const resolved = target.startsWith('/') ? target.slice(1) : path.posix.normalize(`xl/${target}`);
    if (resolved.startsWith('xl/worksheets/') && !resolved.includes('..')) relationships.set(attribute(node, 'Id'), resolved);
  }
  const sheets = [...elements(xml(files['xl/workbook.xml']), 'sheet')];
  if (sheets.length > LIMIT.sheets) evidence.truncated = true;
  for (const sheet of sheets.slice(0, LIMIT.sheets)) {
    checkAbort(signal);
    const name = attribute(sheet, 'name') || 'Sheet';
    const location = relationships.get(attribute(sheet, 'r:id'));
    if (!location || !files[location]) continue;
    let rowCount = 0;
    for (const row of elements(xml(files[location]), 'row')) {
      checkAbort(signal);
      if (++rowCount > LIMIT.rows) { evidence.truncated = true; break; }
      const rowIndex = Number(attribute(row, 'r')) || rowCount;
      const values: string[] = [];
      for (const cell of elements(children(row, 'row'), 'c')) {
        const type = attribute(cell, 't');
        const address = attribute(cell, 'r');
        const raw = type === 'inlineStr' ? nodeText(children(cell, 'c')) : [...elements(children(cell, 'c'), 'v')].map(v => nodeText(children(v, 'v'))).join('');
        const value = type === 's' ? sharedStrings[Number(raw)] ?? '' : type === 'b' ? raw === '1' ? 'TRUE' : 'FALSE' : raw;
        if (value) values.push(`${address || 'Cell'}: ${value}`);
      }
      evidence.add(values.join(' | '), { kind: 'sheet', sheet: name, rowStart: rowIndex, rowEnd: rowIndex, label: `${name}, row ${rowIndex}` });
      if (evidence.full) { evidence.truncated = true; return; }
    }
  }
}

function decodedText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le', { fatal: true }).decode(bytes.subarray(2));
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be', { fatal: true }).decode(bytes.subarray(2));
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (text.includes('\u0000')) throw new ExtractionError('malformed');
  return text;
}

function plainText(bytes: Uint8Array, evidence: EvidenceCollector, signal?: AbortSignal): void {
  const text = decodedText(bytes);
  const lines = text.split(/\r\n|\r|\n/);
  for (let index = 0; index < lines.length; index++) {
    checkAbort(signal);
    evidence.add(lines[index], { kind: 'line', lineStart: index + 1, lineEnd: index + 1, label: `Line ${index + 1}` });
    if (evidence.full) { evidence.truncated ||= index < lines.length - 1; break; }
  }
}

let pdfLibrary: Promise<typeof import('pdfjs-dist')> | undefined;
async function loadPdf(): Promise<typeof import('pdfjs-dist')> {
  pdfLibrary ??= (async () => {
    // Text extraction needs DOMMatrix at module load, but no native canvas or rendering.
    if (!globalThis.DOMMatrix) Object.defineProperty(globalThis, 'DOMMatrix', { value: DOMMatrix, configurable: true });
    const worker = await import('pdfjs-dist/build/pdf.worker.mjs');
    Object.defineProperty(globalThis, 'pdfjsWorker', { value: { WorkerMessageHandler: worker.WorkerMessageHandler }, configurable: true });
    return import('pdfjs-dist');
  })();
  return pdfLibrary;
}

async function pdf(bytes: Uint8Array, evidence: EvidenceCollector, signal?: AbortSignal): Promise<void> {
  const { getDocument } = await loadPdf();
  checkAbort(signal);
  const task = getDocument({
    data: Uint8Array.from(bytes),
    useWasm: false,
    enableXfa: false,
    useSystemFonts: false,
    disableFontFace: true,
    disableAutoFetch: true,
    disableRange: true,
    disableStream: true,
    verbosity: 0,
  });
  const abort = () => { void task.destroy(); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    const document = await task.promise;
    if (document.numPages > LIMIT.pages) evidence.truncated = true;
    for (let pageNumber = 1; pageNumber <= Math.min(document.numPages, LIMIT.pages); pageNumber++) {
      checkAbort(signal);
      const page = await document.getPage(pageNumber);
      try {
        const content = await page.getTextContent();
        const text = content.items.map(item => 'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '').join('');
        evidence.add(text, { kind: 'page', page: pageNumber, label: `Page ${pageNumber}` });
        if (evidence.full) { evidence.truncated = true; break; }
      } finally { page.cleanup(); }
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    await task.destroy();
  }
}

/** In-memory only; production invokes this in a disposable, resource-limited worker. */
export async function extractAssistantAttachment(input: {
  filename: string;
  bytes: Uint8Array;
  signal?: AbortSignal;
}): Promise<AssistantAttachmentExtraction> {
  const { filename, bytes, signal } = input;
  if (bytes.byteLength > LIMIT.bytes) return assistantAttachmentFailure('too_large', 'Attachment exceeds the 10 MB extraction limit.');
  if (!bytes.byteLength) return assistantAttachmentFailure('empty', 'Attachment has no content.');
  const extension = path.extname(filename).toLowerCase();
  const evidence = new EvidenceCollector();
  try {
    checkAbort(signal);
    if (extension === '.pdf') await pdf(bytes, evidence, signal);
    else if (extension === '.docx') docx(bytes, evidence, signal);
    else if (extension === '.xlsx') xlsx(bytes, evidence, signal);
    else if (['.txt', '.csv', '.tsv'].includes(extension)) plainText(bytes, evidence, signal);
    else return assistantAttachmentFailure('unsupported', 'This attachment type is not supported for text extraction.');
    return evidence.result(extension === '.pdf' ? 'scanned' : 'empty');
  } catch (error) {
    if (signal?.aborted) return assistantAttachmentFailure('cancelled', 'Attachment reading was cancelled.');
    if (error instanceof ExtractionError) return assistantAttachmentFailure(error.status);
    if (error instanceof Error && error.name === 'PasswordException') return assistantAttachmentFailure('password_protected', 'Attachment requires a password.');
    return assistantAttachmentFailure('malformed', 'Attachment text could not be read.');
  }
}
