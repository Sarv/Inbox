/**
 * Shared limits for parsing UNTRUSTED email with mailparser's `simpleParser`.
 *
 * Email bodies are attacker-controlled: a message with a multi-hundred-MB HTML
 * part can pin CPU/RAM converting HTML→text (a DoS). Cap the HTML that
 * `simpleParser` will parse. Applied at every `simpleParser` call site so the
 * limit can't be forgotten in one place.
 *
 * Note: we deliberately do NOT cap the overall message size here — the sync
 * engine parses the full raw message (which includes attachment bytes) to pull a
 * single attachment, so a total-size cap would break legitimate large
 * attachments. Per-attachment size is bounded separately at the write sink.
 */
export const MAX_HTML_PARSE_BYTES = 5 * 1024 * 1024; // 5 MB of HTML

export const SIMPLE_PARSER_OPTIONS = {
  maxHtmlLengthToParse: MAX_HTML_PARSE_BYTES,
} as const;
