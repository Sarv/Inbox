import { HEADER_LABEL_PATTERN, HEADER_PATTERN, parseAttribution } from '@sarv-in/email-chat-view/transform';

export interface InboxAssistantContentMessage {
  id: string;
  accountId: string;
  threadId?: string;
  date: number;
  text: string;
}

interface RawTurn { header: string; body: string; quoted: boolean }

/**
 * Reuse the chat reader's attribution grammar, without its DOM-only cleaner.
 * Raw regions retain signatures, contact details, disclaimers and quote headers.
 */
function rawTurns(text: string, date: number): RawTurn[] {
  const lines = [...text.matchAll(/[^\n]*(?:\n|$)/g)].filter(line => line[0]);
  const boundaries: Array<{ start: number; end: number }> = [];
  const reference = Number.isFinite(date) ? new Date(date * 1_000) : undefined;
  const headerText = (value: string) => value.trim().replace(/^(?:>\s*)+/, '');
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const value = headerText(line[0]);
    if (value.length > 800) continue;
    const marker = /^[-_ ]{2,}(?:forwarded|original)\s+message\s*[-_: ]*$/i.test(value);
    if (!marker && !HEADER_PATTERN.test(value) && !/^From:\s*\S/i.test(value)) continue;
    let endIndex = index;
    const header = [value];
    // Outlook/forwarded headers may span several lines. The shared parser
    // expects the same contiguous From/Sent/To block as the chat view.
    for (let next = index + 1; next < Math.min(lines.length, index + 12); next++) {
      const continuation = headerText(lines[next]![0]);
      if (!continuation && marker && next === index + 1) { endIndex = next; continue; }
      if (!HEADER_LABEL_PATTERN.test(continuation)) break;
      header.push(continuation);
      endIndex = next;
    }
    const combined = header.join(' ');
    let attributed = false;
    try { attributed = Boolean(parseAttribution(combined, reference)); } catch { /* A malformed header must not fail mail research. */ }
    if (!marker && !HEADER_PATTERN.test(combined) && !attributed) continue;
    boundaries.push({ start: line.index!, end: lines[endIndex]!.index! + lines[endIndex]![0].length });
    index = endIndex;
  }
  if (!boundaries.length) return [{ header: '', body: text, quoted: false }];
  const result: RawTurn[] = [{ header: '', body: text.slice(0, boundaries[0]!.start), quoted: false }];
  for (const [index, boundary] of boundaries.entries()) {
    result.push({ header: text.slice(boundary.start, boundary.end),
      body: text.slice(boundary.end, boundaries[index + 1]?.start ?? text.length), quoted: true });
  }
  return result;
}

function exactContentKey(body: string): string {
  // Keep CC lines, indentation, tabs and internal newlines: flattening them
  // could make distinct table columns look equal. Only transport line endings
  // and outer blank newline rows may differ between otherwise exact copies.
  return body.replace(/\r\n/g, '\n').replace(/^\n+|\n+$/g, '');
}

/** Compact only duplicate quoted turns inside the already selected excerpts. */
export function compactInboxAssistantContent(messages: InboxAssistantContentMessage[]): {
  messages: Array<InboxAssistantContentMessage & { reusedTurns: number }>;
  reusedTurns: number;
  originalChars: number;
  submittedChars: number;
} {
  const prepared = messages.map(message => ({ message, turns: rawTurns(message.text, message.date) }));
  const canonical = new Map<string, { id: string; turn: number }>();
  const key = (message: InboxAssistantContentMessage, body: string) => message.threadId
    ? JSON.stringify([message.accountId, message.threadId, exactContentKey(body)]) : undefined;
  // Prefer a real message's own retained text over a later carrier's quote.
  // Every own turn remains in the payload, even when two real mails are equal.
  for (const { message, turns } of prepared) {
    for (const [index, turn] of turns.entries()) {
      const value = !turn.quoted && exactContentKey(turn.body).length >= 300 ? key(message, turn.body) : undefined;
      if (value && !canonical.has(value)) canonical.set(value, { id: message.id, turn: index + 1 });
    }
  }
  let reusedTurns = 0;
  const compacted = prepared.map(({ message, turns }) => {
    let reused = 0;
    const text = turns.map((turn, index) => {
      const value = turn.quoted && exactContentKey(turn.body).length >= 300 ? key(message, turn.body) : undefined;
      const existing = value ? canonical.get(value) : undefined;
      if (existing) {
        const marker = `\n[Exact quoted text shared with ${existing.id}, turn ${existing.turn}; original attribution above retained.]\n`;
        if (marker.length < turn.body.length) { reused++; return turn.header + marker; }
      }
      if (value && !existing) canonical.set(value, { id: message.id, turn: index + 1 });
      return turn.header + turn.body;
    }).join('');
    reusedTurns += reused;
    return { ...message, text, reusedTurns: reused };
  });
  return { messages: compacted, reusedTurns,
    originalChars: messages.reduce((sum, message) => sum + message.text.length, 0),
    submittedChars: compacted.reduce((sum, message) => sum + message.text.length, 0) };
}
