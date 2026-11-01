const REDACTED = "[REDACTED]";

// Property names whose values are never logged, whatever they contain.
const SECRET_KEY = /token|secret|passw(?:or)?d|authorization|api[_-]?key|private[_-]?key|credential|cookie|bearer/i;

// Values that look like credentials, wherever they appear in a string.
const SECRET_PATTERNS: RegExp[] = [
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}/g,
  /\b(?:Bearer|Basic|token)\s+[A-Za-z0-9._~+/=-]{16,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  // credentials embedded in URLs: https://user:pass@host
  /(?<=:\/\/)[^\s/:@]+:[^\s/@]+(?=@)/g,
];

const MAX_STRING = 2000;
const MAX_DEPTH = 6;
const MAX_ITEMS = 50;

export type Redactor = {
  /** Redacts secrets in a string and truncates it. */
  text(s: string): string;
  /** Redacts and bounds an arbitrary JSON-like value. */
  value(v: unknown, depth?: number): unknown;
};

/**
 * `knownSecrets` are exact values (e.g. the configured GITHUB_TOKEN) that are
 * scrubbed wherever they appear, in addition to the pattern and key-name rules.
 * Redaction runs on the full string first, then truncates, so a secret can never
 * be cut in half and left partially visible.
 */
export function createRedactor(knownSecrets: readonly (string | undefined)[] = []): Redactor {
  const exact = knownSecrets.map((s) => s?.trim()).filter((s): s is string => !!s && s.length >= 8);

  const scrub = (s: string): string => {
    let out = s;
    for (const secret of exact) out = out.split(secret).join(REDACTED);
    for (const re of SECRET_PATTERNS) out = out.replace(re, REDACTED);
    return out;
  };
  const text = (s: string): string => {
    const clean = scrub(s);
    return clean.length > MAX_STRING ? `${clean.slice(0, MAX_STRING)}…[truncated ${clean.length - MAX_STRING} chars]` : clean;
  };
  const value = (v: unknown, depth = 0): unknown => {
    if (typeof v === "string") return text(v);
    if (v === null || typeof v === "number" || typeof v === "boolean") return v;
    if (depth >= MAX_DEPTH) return "[max depth]";
    if (Array.isArray(v)) {
      const items = v.slice(0, MAX_ITEMS).map((x) => value(x, depth + 1));
      if (v.length > MAX_ITEMS) items.push(`[${v.length - MAX_ITEMS} more items]`);
      return items;
    }
    if (typeof v === "object" && v !== null) {
      const entries = Object.entries(v).slice(0, MAX_ITEMS);
      // fromEntries defines own properties, so a "__proto__" key cannot alter prototypes.
      return Object.fromEntries(
        entries.map(([k, x]) => [text(k).slice(0, 100), SECRET_KEY.test(k) ? REDACTED : value(x, depth + 1)]),
      );
    }
    return `[${typeof v}]`; // undefined, functions, symbols, bigint
  };
  return { text, value };
}
