/**
 * Live end-to-end check against the real GitHub API (issue #2).
 *
 * Spawns the built MCP server over stdio with a throwaway policy + audit log,
 * then exercises the same tool path Claude Code would: list, comment, dry-run PR,
 * denied merge, repo allowlist, verify-log, and (optional) merge blocked by token
 * scopes when Contents: write is absent.
 *
 * Required env:
 *   GITHUB_TOKEN   fine-grained PAT (Issues RW, PRs RW, statuses/checks R; no Contents: write)
 *
 * Optional env:
 *   E2E_OWNER      default EPW80
 *   E2E_REPO       default gated-github-mcp
 *   E2E_ISSUE      issue number to comment on (default 3)
 *   E2E_PR         PR number for merge attempts (default 4)
 *   E2E_SKIP_MERGE_SCOPE_CHECK  if "1", skip the temporary allow+merge probe
 *
 * Run: npm run build && npx tsx scripts/e2e-live.ts
 */
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { verifyLog } from "../src/audit/verify.js";

const token = process.env.GITHUB_TOKEN;
if (!token) {
  console.error("fatal: GITHUB_TOKEN is required (fine-grained PAT for the sandbox repo)");
  process.exit(2);
}

const owner = process.env.E2E_OWNER ?? "EPW80";
const repo = process.env.E2E_REPO ?? "gated-github-mcp";
const issueNumber = Number(process.env.E2E_ISSUE ?? "3");
const pullNumber = Number(process.env.E2E_PR ?? "4");
const skipMergeScope = process.env.E2E_SKIP_MERGE_SCOPE_CHECK === "1";

const dir = mkdtempSync(join(tmpdir(), "ggm-e2e-"));
const policyPath = join(dir, "policy.yaml");
const logPath = join(dir, "audit.jsonl");

const writePolicy = (mergeMode: "deny" | "allow") => {
  writeFileSync(
    policyPath,
    `version: 1
repos:
  - ${owner}/${repo}
tools:
  list_issues: allow
  get_issue: allow
  get_ci_status: allow
  comment_on_issue: allow
  create_pull_request: dry_run
  merge_pull_request: ${mergeMode}
`,
  );
};

writePolicy("deny");

type ToolResult = { isError?: boolean; content: { type: string; text?: string }[] };

const failures: string[] = [];
const ok = (label: string) => console.log(`✓ ${label}`);
const fail = (label: string, detail: string) => {
  failures.push(`${label}: ${detail}`);
  console.error(`✗ ${label}: ${detail}`);
};

const parseBody = (r: ToolResult): string => r.content.find((c) => c.type === "text")?.text ?? "";

const startClient = async () => {
  const client = new Client({ name: "e2e-live", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({
      command: "node",
      args: ["dist/index.js"],
      env: {
        PATH: process.env.PATH ?? "",
        GITHUB_TOKEN: token,
        POLICY_PATH: policyPath,
        AUDIT_LOG_PATH: logPath,
      },
      stderr: "inherit",
    }),
  );
  return client;
};

const call = async (client: Client, name: string, args: Record<string, unknown>) => {
  const r = (await client.callTool({ name, arguments: args })) as ToolResult;
  return r;
};

console.log(`e2e-live: ${owner}/${repo} (issue #${issueNumber}, PR #${pullNumber})`);
console.log(`policy/log dir: ${dir}\n`);

const client = await startClient();

// 1) list_issues — real API
{
  const r = await call(client, "list_issues", { owner, repo, state: "open", per_page: 10 });
  const body = parseBody(r);
  if (r.isError) fail("list_issues", body);
  else {
    try {
      const issues = JSON.parse(body) as { number: number }[];
      if (!Array.isArray(issues) || issues.length === 0) fail("list_issues", "expected at least one open issue");
      else ok(`list_issues (${issues.length} open)`);
    } catch (e) {
      fail("list_issues", `unparseable body: ${(e as Error).message}`);
    }
  }
}

// 2) comment_on_issue — real API + intent then call in the log
{
  const marker = `e2e-live comment ${new Date().toISOString()}`;
  const r = await call(client, "comment_on_issue", {
    owner,
    repo,
    issue_number: issueNumber,
    body: marker,
  });
  const body = parseBody(r);
  if (r.isError) fail("comment_on_issue", body);
  else {
    ok("comment_on_issue");
    const lines = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const intent = [...lines].reverse().find((e) => e.event === "intent" && e.tool === "comment_on_issue");
    const callEntry = [...lines].reverse().find((e) => e.event === "call" && e.tool === "comment_on_issue");
    if (!intent) fail("audit intent", "missing intent entry for comment_on_issue");
    else if (!callEntry) fail("audit call", "missing call entry for comment_on_issue");
    else if ((callEntry.seq as number) <= (intent.seq as number)) {
      fail("audit order", `expected intent seq < call seq (got ${intent.seq} then ${callEntry.seq})`);
    } else ok("audit intent → call for comment");
  }
}

// 3) create_pull_request dry_run — no GitHub mutation
{
  const r = await call(client, "create_pull_request", {
    owner,
    repo,
    title: "e2e-live dry-run",
    head: "cursor/e2e-scratch-pr-bd49",
    base: "main",
  });
  const body = parseBody(r);
  if (r.isError) fail("create_pull_request dry_run", body);
  else if (!/dry.?run|POST|pulls/i.test(body)) fail("create_pull_request dry_run", `unexpected body: ${body.slice(0, 200)}`);
  else ok("create_pull_request dry_run");
}

// 4) merge denied by policy
{
  const r = await call(client, "merge_pull_request", { owner, repo, pull_number: pullNumber });
  if (!r.isError) fail("merge_pull_request deny", "expected denial, got success");
  else {
    ok("merge_pull_request denied");
    const lines = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const entry = [...lines].reverse().find((e) => e.tool === "merge_pull_request" && e.event === "call");
    if (!entry) fail("merge audit", "missing call entry");
    else if (entry.decision?.reason !== "tool_denied") {
      fail("merge audit", `expected tool_denied, got ${JSON.stringify(entry.decision)}`);
    } else ok("merge audit tool_denied");
  }
}

// 5) repo not on allowlist
{
  const r = await call(client, "list_issues", { owner: "octocat", repo: "Hello-World" });
  if (!r.isError) fail("repo_not_allowed", "expected denial");
  else {
    const lines = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    const entry = [...lines].reverse().find((e) => e.tool === "list_issues" && e.event === "call");
    const reason = entry?.decision?.reason;
    if (reason !== "repo_not_allowed") fail("repo_not_allowed", `expected repo_not_allowed, got ${reason}`);
    else ok("repo_not_allowed");
  }
}

await client.close();

// 6) verify-log on the real log
{
  const v = verifyLog(logPath);
  if (!v.ok) fail("verify-log", JSON.stringify(v));
  else ok(`verify-log (${v.entries} entries, head ${v.head.slice(0, 12)}…)`);

  const tampered = join(dir, "audit.tampered.jsonl");
  copyFileSync(logPath, tampered);
  const lines = readFileSync(tampered, "utf8").trim().split("\n");
  if (lines.length >= 2) {
    const obj = JSON.parse(lines[1]!);
    obj.tool = "tampered_tool";
    lines[1] = JSON.stringify(obj);
    writeFileSync(tampered, lines.join("\n") + "\n");
    const bad = verifyLog(tampered);
    if (bad.ok) fail("verify-log tamper", "expected failure on edited copy");
    else ok(`verify-log detects edit (line ${bad.line})`);
  } else fail("verify-log tamper", "log too short to edit");
}

// 7) Token without Contents: write still cannot merge when policy allows
if (!skipMergeScope) {
  writePolicy("allow");
  // Fresh log path so startup verification succeeds with the new policy hash.
  const mergeLog = join(dir, "audit-merge.jsonl");
  const mergeClient = new Client({ name: "e2e-merge", version: "0.0.0" });
  await mergeClient.connect(
    new StdioClientTransport({
      command: "node",
      args: ["dist/index.js"],
      env: {
        PATH: process.env.PATH ?? "",
        GITHUB_TOKEN: token,
        POLICY_PATH: policyPath,
        AUDIT_LOG_PATH: mergeLog,
      },
      stderr: "inherit",
    }),
  );
  const r = await call(mergeClient, "merge_pull_request", {
    owner,
    repo,
    pull_number: pullNumber,
  });
  const body = parseBody(r);
  await mergeClient.close();
  if (!r.isError) {
    fail(
      "merge scope",
      "merge succeeded — token appears to have Contents: write; recreate the PAT without it",
    );
  } else if (/denied|tool_denied/i.test(body) && !/403|Resource not accessible|Not Found|pull request/i.test(body)) {
    // Policy shouldn't deny here; we set allow. Treat unexpected policy deny as fail.
    fail("merge scope", `unexpected policy-style denial: ${body.slice(0, 240)}`);
  } else {
    ok(`merge blocked without Contents: write (${body.slice(0, 120).replace(/\s+/g, " ")})`);
  }
} else {
  console.log("· skipped merge scope check (E2E_SKIP_MERGE_SCOPE_CHECK=1)");
}

console.log("");
if (failures.length) {
  console.error(`FAILED ${failures.length} check(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("OK  all live e2e checks passed");
console.log(`    audit log: ${logPath}`);
