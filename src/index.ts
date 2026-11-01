#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createGitHubClient, type GitHubClient } from "./github/client.js";
import { createServer } from "./server.js";

let client: GitHubClient | undefined;
const getGitHub = (): GitHubClient => (client ??= createGitHubClient());

const server = createServer({ getGitHub });
await server.connect(new StdioServerTransport());
// stdout carries the MCP protocol; diagnostics go to stderr only.
console.error("gated-github-mcp running on stdio");
