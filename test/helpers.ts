import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, vi } from "vitest";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { AuditLog } from "../src/audit/log.js";
import { createRedactor } from "../src/audit/redact.js";
import type { AuditEntry } from "../src/audit/chain.js";
import type { GitHubClient } from "../src/github/client.js";
import { loadPolicy } from "../src/policy/load.js";
import { execute } from "../src/tools/execute.js";

export const FAKE_TOKEN = `ghp_${"Ab1".repeat(12)}`;

export const DEFAULT_POLICY = `
version: 1
repos:
  - octocat/sandbox
tools:
  list_issues: allow
  get_issue: allow
  comment_on_issue: allow
  create_pull_request: dry_run
  merge_pull_request: deny
`; // get_ci_status is deliberately absent: deny by default

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

export function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "ggm-test-"));
  dirs.push(d);
  return d;
}

/** Mocked Octokit: every endpoint the tools use is a spy, none touches the network. */
export function mockGitHub() {
  const fns = {
    listForRepo: vi.fn(async () => ({ data: [{ number: 1, title: "Bug", state: "open", user: { login: "a" }, labels: [], comments: 0, html_url: "u" }] })),
    get: vi.fn(),
    createComment: vi.fn(async () => ({ data: { id: 7, html_url: "c" } })),
    create: vi.fn(),
    merge: vi.fn(),
    getCombinedStatusForRef: vi.fn(),
    listForRef: vi.fn(),
  };
  const gh = {
    rest: {
      issues: { listForRepo: fns.listForRepo, get: fns.get, createComment: fns.createComment },
      pulls: { create: fns.create, merge: fns.merge },
      repos: { getCombinedStatusForRef: fns.getCombinedStatusForRef },
      checks: { listForRef: fns.listForRef },
    },
  } as unknown as GitHubClient;
  const totalCalls = () => Object.values(fns).reduce((n, f) => n + f.mock.calls.length, 0);
  return { gh, fns, totalCalls };
}

export function harness(policyYaml = DEFAULT_POLICY) {
  const dir = tempDir();
  const policyPath = join(dir, "policy.yaml");
  const logPath = join(dir, "audit.jsonl");
  writeFileSync(policyPath, policyYaml);
  const policy = loadPolicy(policyPath);
  const audit = AuditLog.open(logPath, policy.hash, createRedactor([FAKE_TOKEN]));
  const github = mockGitHub();
  const getGitHub = vi.fn(() => github.gh);
  const run = (name: string, args: unknown): Promise<CallToolResult> => execute({ policy, audit, getGitHub }, name, args);
  const entries = (): AuditEntry[] => readLog(logPath);
  const last = (): AuditEntry => entries().at(-1)!;
  return { dir, policy, policyPath, logPath, audit, github, getGitHub, run, entries, last };
}

export const readLog = (path: string): AuditEntry[] =>
  readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as AuditEntry);

export const text = (r: CallToolResult): string => (r.content[0] as { text: string }).text;
