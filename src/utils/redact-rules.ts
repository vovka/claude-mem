/**
 * Pattern tables and small predicates used by redact-secrets.ts's redaction
 * passes: the sensitive-key regex, the key=value assignment grammar, and the
 * quoting/literal-value helpers that decide whether a matched value is worth
 * redacting.
 */

export const tag = (kind: string): string => `[REDACTED:${kind}]`;

// ponytail: unanchored substring match, not per-word-boundary per term — so
// "author", "authenticate" etc. also flag (they contain "auth"). That's the
// spec as given; tighten to per-term boundaries if false positives show up
// on real tool input in practice.
export const SENSITIVE_KEY_REGEX =
  /(pass(word)?|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth|credential|session[_-]?key)/i;

const TYPE_LIKE_VALUES =
  /^(string|number|boolean|any|unknown|object|void|null|undefined|true|false|Array|Record|Map|Set)(<.*>)?$/i;

/** True when an unquoted assignment RHS looks like a real secret literal, not code. */
function isLiteralValue(value: string): boolean {
  if (!value) return false;
  if (TYPE_LIKE_VALUES.test(value)) return false;
  // getToken(), foo() — a call, not a value.
  if (/^[A-Za-z_$][\w$]*\(\)?$/.test(value)) return false;
  return value.length >= 6;
}

const KEY_PART = '[A-Za-z_][A-Za-z0-9_.-]{0,60}';
const QUOTED_VALUE = `"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*'`;
// Unquoted value token: stops at whitespace and the punctuation that ends a
// code statement/collection (`;`, `,`, braces, brackets, parens) so
// `secret: string;` and `token: number)` don't drag trailing syntax into the
// captured value and defeat the type-annotation check in isLiteralValue.
const VALUE_TOKEN = `[^\\s"'{}\\[\\],;()]+`;

export const ASSIGNMENT_REGEX = new RegExp(
  `(")?(${KEY_PART})(")?(\\s*[:=]\\s*)(${QUOTED_VALUE}|${VALUE_TOKEN})`,
  'g',
);
export const CLI_FLAG_REGEX = new RegExp(
  `(--(${KEY_PART}))([= ]+)(${QUOTED_VALUE}|${VALUE_TOKEN})`,
  'g',
);

export function isQuoted(raw: string): boolean {
  return raw.length >= 2 && ((raw[0] === '"' && raw.endsWith('"')) || (raw[0] === "'" && raw.endsWith("'")));
}

export function shouldRedactAssignment(key: string, raw: string): boolean {
  if (!SENSITIVE_KEY_REGEX.test(key)) return false;
  // Authorization headers are handled by redactAuthHeader already — skip
  // here so "Authorization: Bearer [REDACTED:auth_header]" isn't re-matched
  // as a plain key:value assignment on the scheme word.
  if (key.toLowerCase() === 'authorization') return false;
  if (isQuoted(raw)) return raw.length > 2;
  return isLiteralValue(raw);
}

export function redactedValueFor(raw: string, key: string): string {
  const quoteChar = isQuoted(raw) ? raw[0] : '';
  return `${quoteChar}${tag(`field:${key.toLowerCase()}`)}${quoteChar}`;
}
