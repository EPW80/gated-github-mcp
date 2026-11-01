import { readFileSync } from "node:fs";
import { canonicalize, GENESIS_HASH, hashEntry, type AuditEntry } from "./chain.js";

export type VerifyResult =
  | { ok: true; entries: number; head: string }
  | { ok: false; entries: number; line: number; seq: number; problem: string };

/**
 * Walks the log from the first line and stops at the first bad entry.
 * Detects edited entries, deleted or reordered entries, and malformed lines.
 * Cannot detect removal of entries from the END of the log (nothing follows them
 * to disagree), so `head` is returned for pinning outside the log.
 */
export function verifyLog(path: string): VerifyResult {
  const lines = readFileSync(path, "utf8").split("\n");
  while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop(); // trailing newline only

  let prev = GENESIS_HASH;
  for (const [i, line] of lines.entries()) {
    const fail = (problem: string): VerifyResult => ({ ok: false, entries: i, line: i + 1, seq: i, problem });

    let e: AuditEntry;
    try {
      e = JSON.parse(line) as AuditEntry;
    } catch {
      return fail("line is not valid JSON");
    }
    if (!e || typeof e !== "object" || typeof e.seq !== "number" || typeof e.hash !== "string" || typeof e.prev_hash !== "string") {
      return fail("line is not a well-formed audit entry");
    }
    // The logger only writes canonical JSON. Anything else (duplicate keys, reordered
    // keys, extra whitespace) is hand-edited, and could display a different value
    // than the one that was hashed.
    if (line !== canonicalize(e)) return fail("line is not in canonical form (hand-edited or duplicate keys)");
    if (hashEntry(e) !== e.hash) return fail("entry contents do not match its hash (entry was edited)");
    if (e.seq !== i) {
      return fail(
        e.seq > i
          ? `sequence gap: expected seq ${i}, found ${e.seq} (entries missing or reordered before this one)`
          : `sequence out of order: expected seq ${i}, found ${e.seq} (duplicated or reordered entry)`,
      );
    }
    if (e.prev_hash !== prev) return fail("prev_hash does not match the previous entry (entry removed or reordered)");
    prev = e.hash;
  }
  return { ok: true, entries: lines.length, head: prev };
}
