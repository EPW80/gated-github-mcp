#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { AuditLog } from "./audit/log.js";
import { createRedactor } from "./audit/redact.js";
import { createGitHubClient, type GitHubClient } from "./github/client.js";
import { loadPolicy } from "./policy/load.js";
import { createServer } from "./server.js";

// Fail closed: any policy problem aborts startup.
let policy;
try {
  policy = loadPolicy(process.env.POLICY_PATH, (m) => console.error(`warning: ${m}`));
} catch (e) {
  console.error(`fatal: ${(e as Error).message}`);
  process.exit(1);
}

let audit;
try {
  audit = AuditLog.open(process.env.AUDIT_LOG_PATH, policy.hash, createRedactor([process.env.GITHUB_TOKEN]));
} catch (e) {
  console.error(`fatal: ${(e as Error).message}`);
  process.exit(1);
}

let client: GitHubClient | undefined;
const getGitHub = (): GitHubClient => (client ??= createGitHubClient());

const server = createServer({ policy, audit, getGitHub });
await server.connect(new StdioServerTransport());
// stdout carries the MCP protocol; diagnostics go to stderr only.
console.error(`gated-github-mcp running on stdio (policy ${policy.hash.slice(0, 12)})`);
