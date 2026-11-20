/**
 * Text that did not come from our own code — a renderer-forwarded log record, a
 * server's error message — made safe to write as ONE line of app.log.
 *
 * CR and LF become the visible escapes `\r` / `\n`, and every other control
 * character (ESC, NUL, the Unicode line/paragraph separators, …) becomes
 * `\uXXXX`, so the text can neither start a fake line that reads as the main
 * process's own nor drive a terminal that later `cat`s the file. Tabs stay.
 */
export function toOneLine(text: string): string {
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  return text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, (c) => {
    if (c === '\n') return '\\n';
    if (c === '\r') return '\\r';
    if (c === '\t') return c;
    return `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;
  });
}

const SCHEME = /^[a-z][a-z0-9+.-]{0,31}:$/;

/**
 * What a log line may say about a URL that came from mail or the renderer: its
 * scheme (`https:`, `file:`, `ms-word:`), never the rest. A link's host, path
 * and query name the people, services and documents in the user's mail.
 * Answers `unparseable` for text that is not a URL, `scheme-too-long` for a
 * scheme past 32 characters (a made-up scheme can carry words), and the type
 * for a value that is not a string at all.
 */
export function urlSchemeForLog(url: unknown): string {
  if (typeof url !== 'string') return `not-a-string:${url === null ? 'null' : typeof url}`;
  let protocol: string;
  try {
    protocol = new URL(url).protocol;
  } catch {
    return 'unparseable';
  }
  return SCHEME.test(protocol) ? protocol : 'scheme-too-long';
}

const FIELD_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,39}$/;
const MAX_NAMED_FIELDS = 12;

/**
 * The keys a log line may name: the identifier-like ones (at most 12), sorted,
 * and how many others there are. A key that is not an identifier is counted,
 * never written, because whoever built the object chose it (a renderer, a model).
 */
function nameableKeys(keys: readonly string[]): { named: string[]; others: number } {
  const named = keys.filter((key) => FIELD_NAME.test(key)).sort().slice(0, MAX_NAMED_FIELDS);
  return { named, others: keys.length - named.length };
}

/** Key names for a log line (see nameableKeys), with the rest as `+N more`. */
function fieldNamesForLog(keys: readonly string[]): string {
  const { named, others } = nameableKeys(keys);
  return named.join(',') + (others > 0 ? `${named.length ? ',' : ''}+${others} more` : '');
}

/**
 * Each field of an object someone else built (an AI provider's `message`), for
 * a log line: a string's length, `array(<n>)` for an array, `null`, or the type
 * of anything else — never a value. Keys follow nameableKeys; the ones it does
 * not name are counted under `+more`. Empty for anything that is not a plain
 * object (an array, a string, nothing).
 */
export function fieldSizesForLog(value: unknown): Record<string, number | string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const fields = value as Record<string, unknown>;
  const { named, others } = nameableKeys(Object.keys(fields));
  const sizes: Record<string, number | string> = {};
  for (const key of named) sizes[key] = fieldSize(fields[key]);
  if (others > 0) sizes['+more'] = others;
  return sizes;
}

function fieldSize(field: unknown): number | string {
  if (typeof field === 'string') return field.length;
  if (Array.isArray(field)) return `array(${field.length})`;
  return field === null ? 'null' : typeof field;
}

/**
 * The names of the fields of `value` that are set — a non-empty string, a
 * boolean (true OR false), a finite number, a non-empty array or an object —
 * for a log line about a request whose VALUES are the user's (a search's words,
 * senders, labels). A boolean counts either way because an explicit `false` is
 * a filter too: `isUnread: false` asks for read mail, and leaving it out asks
 * for both. `skip` names fields the caller logs itself.
 */
export function setFieldNamesForLog(value: unknown, skip: readonly string[] = []): string {
  if (!value || typeof value !== 'object') return 'none';
  const set = Object.entries(value as Record<string, unknown>)
    .filter(([key, field]) => !skip.includes(key) && isSetField(field))
    .map(([key]) => key);
  return fieldNamesForLog(set) || 'none';
}

function isSetField(field: unknown): boolean {
  if (typeof field === 'string') return field.length > 0;
  if (typeof field === 'number') return Number.isFinite(field);
  if (typeof field === 'boolean') return true;
  if (Array.isArray(field)) return field.length > 0;
  return field !== null && typeof field === 'object';
}

/**
 * The shape of a value someone else built (an AI provider's answer, a
 * renderer's payload), for a log line: its type, a string's or an array's
 * length, and an object's key names (see fieldNamesForLog). Never a value.
 */
export function valueShapeForLog(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === 'string') return `string(${value.length} chars)`;
  if (typeof value !== 'object') return typeof value;
  return `object keys=[${fieldNamesForLog(Object.keys(value))}]`;
}
