import { createHash } from "node:crypto";

/** prev_hash of the first entry in a log. */
export const GENESIS_HASH = "0".repeat(64);

export interface AuditEntry {
  v: 1;
  seq: number;
  /** start: server boot; intent: written before an allowed write call; call: final outcome. */
  event: "start" | "intent" | "call";
  ts: string;
  tool: string;
  args: unknown;
  policy_hash: string;
  decision: { outcome: "allow" | "deny" | "dry_run"; reason?: string };
  result: { status: "ok" | "error" | "denied" | "dry_run" | "pending"; detail: string };
  duration_ms: number;
  prev_hash: string;
  hash: string;
}

/** JSON with recursively sorted keys, so the hash does not depend on key order. */
export function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => canonicalize(v ?? null)).join(",")}]`;
  if (value && typeof value === "object") {
    const body = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`);
    return `{${body.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** SHA-256 over the canonical form of the entry with its own `hash` field removed. */
export function hashEntry(entry: Omit<AuditEntry, "hash"> | AuditEntry): string {
  const { hash: _ignored, ...rest } = entry as AuditEntry;
  void _ignored;
  return createHash("sha256").update(canonicalize(rest)).digest("hex");
}
