import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { GitHubClient } from "../github/client.js";
import { toolsByName } from "./definitions.js";

export interface ExecuteDeps {
  /** Lazily provides the GitHub client. Only `execute` ever calls this. */
  getGitHub: () => GitHubClient;
}

/**
 * The single path from an MCP tool call to GitHub. Every call, including unknown
 * tool names and malformed arguments, comes through here.
 *
 * Phase 2 inserts the policy check (and dry_run) between parsing and the handler;
 * Phase 3 records every return path in the audit log.
 */
export async function execute(
  deps: ExecuteDeps,
  name: string,
  rawArgs: unknown,
): Promise<CallToolResult> {
  const def = toolsByName.get(name);
  if (!def) {
    return errorResult(`Unknown tool: ${name}`);
  }

  const parsed = def.inputSchema.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    return errorResult(`Invalid arguments: ${z.prettifyError(parsed.error)}`);
  }

  try {
    const result = await def.handler(deps.getGitHub(), parsed.data);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  } catch (err) {
    return errorResult(describeError(err));
  }
}

function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

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
