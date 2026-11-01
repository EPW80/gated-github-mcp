import { Octokit } from "@octokit/rest";

export type GitHubClient = Octokit;

/**
 * Builds an Octokit client from GITHUB_TOKEN. Called lazily, on the first tool
 * call, so the server can still start and list tools without a token.
 * The error message never includes the token or any part of it.
 */
export function createGitHubClient(env: NodeJS.ProcessEnv = process.env): GitHubClient {
  const token = env.GITHUB_TOKEN?.trim();
  if (!token) {
    throw new Error("GITHUB_TOKEN is not set");
  }
  return new Octokit({
    auth: token,
    userAgent: "gated-github-mcp",
    // Octokit's default logger writes warnings to stdout via console.warn in some
    // paths; route everything to stderr so the MCP channel stays clean.
    log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
  });
}
