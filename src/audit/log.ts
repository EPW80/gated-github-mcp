import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalize, GENESIS_HASH, hashEntry, type AuditEntry } from "./chain.js";
import type { Redactor } from "./redact.js";

export class AuditError extends Error {}

export interface RecordInput {
  tool: string;
  args: unknown;
  decision: AuditEntry["decision"];
  result: AuditEntry["result"];
  durationMs: number;
}

/**
 * Append-only, hash-chained JSONL log. Each line carries the hash of the previous
 * line, so editing, deleting or reordering any entry breaks every later link.
 * Single writer: run one server per log file.
 */
export class AuditLog {
  /** Set after the first failed write; the server then refuses all calls. */
  failed = false;
  private seq: number;
  private prev: string;

  private constructor(
    private readonly path: string,
    private readonly policyHash: string,
    private readonly redactor: Redactor,
    last: AuditEntry | undefined,
  ) {
    this.seq = last ? last.seq + 1 : 0;
    this.prev = last ? last.hash : GENESIS_HASH;
  }

  /** Opens (or creates) the log, resumes the chain, and records a server_start entry. */
  static open(path: string | undefined, policyHash: string, redactor: Redactor): AuditLog {
    if (!path) throw new AuditError("AUDIT_LOG_PATH is not set");
    try {
      mkdirSync(dirname(path), { recursive: true });
    } catch {
      throw new AuditError(`Cannot create directory for audit log ${path}`);
    }
    const log = new AuditLog(path, policyHash, redactor, readLastEntry(path));
    // Writing the start entry proves the log is writable and puts every policy
    // change (a new policy hash) on the record.
    log.record({
      tool: "_server_start",
      args: {},
      decision: { outcome: "allow" },
      result: { status: "ok", detail: "server started" },
      durationMs: 0,
    });
    return log;
  }

  record(input: RecordInput): void {
    const body: Omit<AuditEntry, "hash"> = {
      v: 1,
      seq: this.seq,
      ts: new Date().toISOString(),
      tool: this.redactor.text(input.tool).slice(0, 100),
      args: this.redactor.value(input.args),
      policy_hash: this.policyHash,
      decision: input.decision,
      result: { status: input.result.status, detail: this.redactor.text(input.result.detail) },
      duration_ms: Math.round(input.durationMs),
      prev_hash: this.prev,
    };
    const entry: AuditEntry = { ...body, hash: hashEntry(body) };
    try {
      appendFileSync(this.path, `${canonicalize(entry)}\n`, { mode: 0o600 });
    } catch {
      this.failed = true;
      throw new AuditError("Audit log write failed");
    }
    this.seq += 1;
    this.prev = entry.hash;
  }
}

function readLastEntry(path: string): AuditEntry | undefined {
  if (!existsSync(path)) return undefined;
  const lines = readFileSync(path, "utf8").split("\n").filter((l) => l.trim() !== "");
  const lastLine = lines.at(-1);
  if (lastLine === undefined) return undefined;
  try {
    const entry = JSON.parse(lastLine) as AuditEntry;
    if (typeof entry.seq !== "number" || hashEntry(entry) !== entry.hash) throw new Error("hash mismatch");
    return entry;
  } catch {
    throw new AuditError(`Audit log ${path} has a corrupt last entry; run verify-log and move it aside before starting`);
  }
}
