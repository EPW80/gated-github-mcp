import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { GitHubClient } from "../github/client.js";
import { decide } from "../policy/decide.js";
import type { Policy } from "../policy/load.js";

export interface ExecuteDeps {
  policy: Policy;
  /** Lazily provides the GitHub client. Only `execute` ever calls this. */
  getGitHub: () => GitHubClient;
}

/**
 * The single path from an MCP tool call to GitHub. Every call, including unknown
 * tool names and malformed arguments, is decided by `decide` first; only an
 * "allow" decision reaches a handler. Phase 3 records every return path.
 */
export async function execute(deps: ExecuteDeps, name: string, rawArgs: unknown): Promise<CallToolResult> {
  const decision = decide(deps.policy, name, rawArgs);

  if (decision.outcome === "deny") return errorResult(decision.message);

  if (decision.outcome === "dry_run") {
    // decide() guarantees plan exists for dry_run tools (checked at policy load);
    // if that ever breaks, fail closed instead of calling GitHub.
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
