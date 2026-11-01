import { appendFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalize, GENESIS_HASH, hashEntry, type AuditEntry } from "./chain.js";
import type { Redactor } from "./redact.js";
import { verifyLog } from "./verify.js";

export class AuditError extends Error {}

export interface RecordInput {
  event?: "intent" | "call";
  tool: string;
  args: unknown;
  decision: AuditEntry["decision"];
  result: AuditEntry["result"];
  durationMs: number;
}

/** Upper bound on the serialized args stored per entry. */
const MAX_ARGS_CHARS = 8_000;

/**
 * Append-only, hash-chained JSONL log. Each line carries the hash of the previous
 * line, so editing, deleting or reordering any entry breaks every later link.
 *
 * Single writer: before each append the file size is compared with what this
 * process last wrote. Any difference (another server, a truncation, a hand edit)
 * marks the log failed and every later call is refused.
 */
export class AuditLog {
  /** Set after the first failed or unsafe write; the server then refuses all calls. */
  failed = false;
  private seq: number;
  private prev: string;
  private size: number;

  private constructor(
    private readonly path: string,
    private readonly policyHash: string,
    private readonly redactor: Redactor,
  ) {
    this.seq = 0;
    this.prev = GENESIS_HASH;
    this.size = 0;
  }

  /**
   * Opens (or creates) the log. An existing log must verify end to end, otherwise
   * the server refuses to start. Then records a start entry, which proves the log
   * is writable and puts the current policy hash on the record.
   */
  static open(path: string | undefined, policyHash: string, redactor: Redactor, warn: (m: string) => void = () => {}): AuditLog {
    if (!path) throw new AuditError("AUDIT_LOG_PATH is not set");
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    } catch {
      throw new AuditError(`Cannot create directory for audit log ${path}`);
    }

    const log = new AuditLog(path, policyHash, redactor);
    if (existsSync(path)) {
      let result;
      try {
        result = verifyLog(path);
      } catch {
        throw new AuditError(`Cannot read audit log ${path}`);
      }
      if (!result.ok) {
        throw new AuditError(
          `Audit log ${path} fails verification at line ${result.line}: ${result.problem}. Move it aside before starting.`,
        );
      }
      log.seq = result.entries;
      log.prev = result.entries > 0 ? result.head : GENESIS_HASH;
      const st = statSync(path);
      log.size = st.size;
      if (st.mode & 0o077) warn(`audit log ${path} is readable or writable by other users`);
    }

    log.write("start", {
      tool: "gated-github-mcp",
      args: {},
      decision: { outcome: "allow" },
      result: { status: "ok", detail: "server started" },
      durationMs: 0,
    });
    return log;
  }

  /** seq of the most recently written entry (-1 if none). */
  get lastSeq(): number {
    return this.seq - 1;
  }

  record(input: RecordInput): void {
    this.write(input.event ?? "call", input);
  }

  private write(event: AuditEntry["event"], input: RecordInput): void {
    let args = this.redactor.value(input.args);
    const serialized = canonicalize(args);
    if (serialized.length > MAX_ARGS_CHARS) args = { _truncated: serialized.slice(0, MAX_ARGS_CHARS) };

    const body: Omit<AuditEntry, "hash"> = {
      v: 1,
      seq: this.seq,
      event,
      ts: new Date().toISOString(),
      tool: this.redactor.text(input.tool).slice(0, 100),
      args,
      policy_hash: this.policyHash,
      decision: input.decision,
      result: { status: input.result.status, detail: this.redactor.text(input.result.detail) },
      duration_ms: Math.round(input.durationMs),
      prev_hash: this.prev,
    };
    const entry: AuditEntry = { ...body, hash: hashEntry(body) };
    const line = `${canonicalize(entry)}\n`;
    try {
      if (existsSync(this.path) && statSync(this.path).size !== this.size) {
        throw new Error("log changed outside this process");
      }
      appendFileSync(this.path, line, { mode: 0o600 });
    } catch {
      this.failed = true;
      throw new AuditError("Audit log write failed");
    }
    this.size += Buffer.byteLength(line);
    this.seq += 1;
    this.prev = entry.hash;
  }
}
