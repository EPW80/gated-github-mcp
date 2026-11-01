import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { GitHubClient } from "../github/client.js";
import type { AuditEntry } from "../audit/chain.js";
import type { AuditLog } from "../audit/log.js";
import { decide, type Decision } from "../policy/decide.js";
import type { Policy } from "../policy/load.js";

export interface ExecuteDeps {
  policy: Policy;
  audit: AuditLog;
  /** Lazily provides the GitHub client. Only `execute` ever calls this. */
  getGitHub: () => GitHubClient;
}

/**
 * The single path from an MCP tool call to GitHub. Every call, including unknown
 * tool names and malformed arguments, is decided by `decide` first; only an
 * "allow" decision reaches a handler. Every outcome is then written to the audit log.
 */
export async function execute(deps: ExecuteDeps, name: string, rawArgs: unknown): Promise<CallToolResult> {
  // Fail closed: once the audit log has failed, nothing else runs unrecorded.
  if (deps.audit.failed) return errorResult("Audit log unavailable: all calls are refused");

  const started = performance.now();
  const decision = decide(deps.policy, name, rawArgs);
  const result = await run(deps, decision);

  const status: AuditEntry["result"]["status"] =
    decision.outcome === "deny" ? "denied" : decision.outcome === "dry_run" ? "dry_run" : result.isError ? "error" : "ok";
  try {
    deps.audit.record({
      tool: name,
      args: rawArgs,
      decision: decision.outcome === "deny" ? { outcome: "deny", reason: decision.reason } : { outcome: decision.outcome },
      result: { status, detail: textOf(result) },
      durationMs: performance.now() - started,
    });
  } catch {
    console.error("fatal: audit log write failed; refusing further calls");
    return errorResult("Audit log write failed: the outcome of this call was not recorded");
  }
  return result;
}

async function run(deps: ExecuteDeps, decision: Decision): Promise<CallToolResult> {
  if (decision.outcome === "deny") return errorResult(decision.message);

  if (decision.outcome === "dry_run") {
    // Policy load guarantees plan exists for dry_run tools; if that ever breaks,
    // fail closed instead of calling GitHub.
    if (!decision.def.plan) return errorResult("Denied by policy: dry_run unavailable for this tool");
    const would_call = decision.def.plan(decision.args);
    return ok({ dry_run: true, note: "No request was sent to GitHub.", would_call });
  }

  try {
    return ok(await decision.def.handler(deps.getGitHub(), decision.args));
  } catch (err) {
    return errorResult(describeError(err));
  }
}

const textOf = (r: CallToolResult): string => {
  const first = r.content[0];
  return first && first.type === "text" ? first.text : "";
};

const ok = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const errorResult = (message: string): CallToolResult => ({ isError: true, content: [{ type: "text", text: message }] });

/**
 * Reduces any thrown value to status + message. Octokit's RequestError carries the
 * full request (including the Authorization header) and response headers, so we
 * never serialize the error object itself.
 */
export function describeError(err: unknown): string {
  if (err && typeof err === "object") {
    const status = "status" in err && typeof err.status === "number" ? err.status : undefined;
    const message = err instanceof Error ? err.message : "Unknown error";
    return status ? `GitHub API error ${status}: ${message}` : message;
  }
  return "Unknown error";
}
