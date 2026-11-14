/**
 * Live end-to-end check against the real GitHub API (issue #2).
 *
 * Spawns the built MCP server over stdio with a throwaway policy and audit log,
 * then exercises the same tool path Claude Code would: list issues, CI status,
 * comment (and read it back), dry-run PR, denied merge, repo allowlist and
 * verify-log. Optionally probes that the token itself cannot merge.
 *
 * Point it at a SANDBOX repo: it posts a real comment there.
 *
 * Required env:
 *   GITHUB_TOKEN   fine-grained PAT for the sandbox repo only
 *                  (Issues RW, Pull requests RW, Commit statuses R, Checks R; no Contents: write)
 *   E2E_OWNER      sandbox repo owner
 *   E2E_REPO       sandbox repo name
 *   E2E_ISSUE      open issue number to comment on
 *
 * Optional env:
 *   E2E_REF              ref for get_ci_status (default "main")
 *   E2E_MERGE_PROBE_PR   opt-in: number of a NON-draft PR whose base is a throwaway
 *                        branch (never the default branch). The script temporarily
 *                        allows merge_pull_request and expects GitHub to refuse with
 *                        403 because the token lacks Contents: write.
 *
 * Run: npm run build && npm run e2e:live
 */
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Octokit } from "@octokit/rest";
import type { AuditEntry } from "../src/audit/chain.js";
import { verifyLog } from "../src/audit/verify.js";

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`fatal: ${name} is required (see the header of scripts/e2e-live.ts)`);
    process.exit(2);
  }
  return value;
};
const positiveInt = (name: string, raw: string): number => {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`fatal: ${name} must be a positive integer`);
    process.exit(2);
  }
  return n;
};

const token = required("GITHUB_TOKEN");
const owner = required("E2E_OWNER");
const repo = required("E2E_REPO");
const issueNumber = positiveInt("E2E_ISSUE", required("E2E_ISSUE"));
const ref = process.env.E2E_REF?.trim() || "main";
const probeRaw = process.env.E2E_MERGE_PROBE_PR?.trim();
const probePr = probeRaw ? positiveInt("E2E_MERGE_PROBE_PR", probeRaw) : undefined;

const dir = mkdtempSync(join(tmpdir(), "ggm-e2e-"));
const policyPath = join(dir, "policy.yaml");

const writePolicy = (mergeMode: "deny" | "allow") =>
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

// The server gets a minimal environment, plus the network settings (proxy and CA
// trust) it needs to reach GitHub from behind a proxy. None of these are secrets.
const NETWORK_VARS = /^(HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy|NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|NODE_USE_ENV_PROXY)$/;
const serverEnv = (logPath: string): Record<string, string> => ({
  ...Object.fromEntries(
    Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined && NETWORK_VARS.test(e[0])),
  ),
  PATH: process.env.PATH ?? "",
  GITHUB_TOKEN: token,
  POLICY_PATH: policyPath,
  AUDIT_LOG_PATH: logPath,
});

const startClient = async (logPath: string): Promise<Client> => {
  const client = new Client({ name: "e2e-live", version: "0.0.0" });
  await client.connect(
    new StdioClientTransport({ command: "node", args: ["dist/index.js"], env: serverEnv(logPath), stderr: "inherit" }),
  );
  return client;
};

type ToolResult = { isError?: boolean; content: { type: string; text?: string }[] };
const call = async (client: Client, name: string, args: Record<string, unknown>) =>
  (await client.callTool({ name, arguments: args })) as ToolResult;
const text = (r: ToolResult): string => r.content.find((c) => c.type === "text")?.text ?? "";
const readLog = (path: string): AuditEntry[] =>
  readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as AuditEntry);
const lastEntry = (path: string, event: AuditEntry["event"], tool: string) =>
  readLog(path).reverse().find((e) => e.event === event && e.tool === tool);
const lastCall = (path: string, tool: string) => lastEntry(path, "call", tool);

const failures: string[] = [];
const ok = (label: string) => console.log(`✓ ${label}`);
const fail = (label: string, detail: string) => {
  failures.push(`${label}: ${detail}`);
  console.error(`✗ ${label}: ${detail}`);
};

console.log(`e2e-live: ${owner}/${repo} (issue #${issueNumber}, ref ${ref}${probePr ? `, merge probe PR #${probePr}` : ""})`);
console.log(`policy/log dir: ${dir}\n`);

const logPath = join(dir, "audit.jsonl");
writePolicy("deny");
const client = await startClient(logPath);
try {
  // 1) list_issues
  {
    const r = await call(client, "list_issues", { owner, repo, state: "open", per_page: 10 });
    if (r.isError) fail("list_issues", text(r));
    else {
      const issues = JSON.parse(text(r)) as unknown[];
      if (!Array.isArray(issues) || issues.length === 0) fail("list_issues", "expected at least one open issue");
      else ok(`list_issues (${issues.length} open)`);
    }
  }

  // 2) get_ci_status
  {
    const r = await call(client, "get_ci_status", { owner, repo, ref });
    if (r.isError) fail("get_ci_status", text(r));
    else {
      const s = JSON.parse(text(r)) as { combined_state?: string; check_runs?: unknown[] };
      if (typeof s.combined_state !== "string" || !Array.isArray(s.check_runs)) fail("get_ci_status", `unexpected body: ${text(r).slice(0, 200)}`);
      else ok(`get_ci_status (${ref}: ${s.combined_state}, ${s.check_runs.length} check runs)`);
    }
  }

  // 3) comment_on_issue: posted, read back, and logged as intent -> call
  {
    const before = await call(client, "get_issue", { owner, repo, issue_number: issueNumber });
    const countBefore = before.isError ? undefined : (JSON.parse(text(before)) as { comments: number }).comments;
    const r = await call(client, "comment_on_issue", {
      owner,
      repo,
      issue_number: issueNumber,
      body: `gated-github-mcp e2e-live check, ${new Date().toISOString()}`,
    });
    if (r.isError) fail("comment_on_issue", text(r));
    else {
      ok("comment_on_issue");
      const after = await call(client, "get_issue", { owner, repo, issue_number: issueNumber });
      const countAfter = after.isError ? undefined : (JSON.parse(text(after)) as { comments: number }).comments;
      if (countBefore === undefined || countAfter === undefined) fail("comment read-back", "get_issue failed");
      else if (countAfter <= countBefore) fail("comment read-back", `comment count did not increase (${countBefore} -> ${countAfter})`);
      else ok(`comment read back (comments ${countBefore} -> ${countAfter})`);

      const intent = lastEntry(logPath, "intent", "comment_on_issue");
      const done = lastEntry(logPath, "call", "comment_on_issue");
      if (!intent || !done) fail("audit intent -> call", "missing intent or call entry");
      else if (done.seq !== intent.seq + 1) fail("audit intent -> call", `expected consecutive entries, got seq ${intent.seq} and ${done.seq}`);
      else ok("audit log: intent then call for the comment");
    }
  }

  // 4) create_pull_request in dry_run: returns the planned request, creates nothing
  {
    const r = await call(client, "create_pull_request", { owner, repo, title: "e2e-live dry run", head: "e2e-dry-run", base: ref });
    if (r.isError) fail("create_pull_request dry_run", text(r));
    else {
      const body = JSON.parse(text(r)) as { dry_run?: boolean; would_call?: { method?: string; endpoint?: string } };
      const expected = `/repos/${owner}/${repo}/pulls`;
      if (body.dry_run !== true || body.would_call?.method !== "POST" || body.would_call?.endpoint !== expected) {
        fail("create_pull_request dry_run", `unexpected body: ${text(r).slice(0, 200)}`);
      } else ok("create_pull_request dry_run (no request sent)");
    }
  }

  // 5) merge_pull_request denied by policy, before any GitHub call
  {
    const r = await call(client, "merge_pull_request", { owner, repo, pull_number: 1 });
    const entry = lastCall(logPath, "merge_pull_request");
    if (!r.isError) fail("merge denied", "expected a denial");
    else if (entry?.decision?.reason !== "tool_denied") fail("merge denied", `expected tool_denied, got ${JSON.stringify(entry?.decision)}`);
    else ok("merge_pull_request denied (tool_denied)");
  }

  // 6) repo not on the allowlist
  {
    const r = await call(client, "list_issues", { owner: "octocat", repo: "Hello-World" });
    const reason = lastCall(logPath, "list_issues")?.decision?.reason;
    if (!r.isError || reason !== "repo_not_allowed") fail("repo_not_allowed", `expected repo_not_allowed, got ${reason}`);
    else ok("off-allowlist repo denied (repo_not_allowed)");
  }
} finally {
  await client.close();
}

// 7) verify-log on the real log, and on a tampered copy
{
  const v = verifyLog(logPath);
  if (!v.ok) fail("verify-log", JSON.stringify(v));
  else ok(`verify-log (${v.entries} entries, head ${v.head.slice(0, 12)}…)`);

  const tampered = join(dir, "audit.tampered.jsonl");
  copyFileSync(logPath, tampered);
  const lines = readFileSync(tampered, "utf8").trim().split("\n");
  const obj = JSON.parse(lines[1]!) as Record<string, unknown>;
  obj.tool = "tampered_tool";
  lines[1] = JSON.stringify(obj);
  writeFileSync(tampered, lines.join("\n") + "\n");
  const bad = verifyLog(tampered);
  if (bad.ok) fail("verify-log tamper", "expected failure on the edited copy");
  else ok(`verify-log rejects an edited copy (line ${bad.line})`);
}

// 8) Opt-in: the token itself cannot merge, even when the policy allows it.
if (probePr === undefined) {
  console.log("· merge-permission probe skipped (set E2E_MERGE_PROBE_PR to run it)");
} else {
  // Guard rails, checked directly against GitHub before the server is involved:
  // a mis-scoped token must never be able to merge into the default branch, and a
  // draft PR would be refused for reasons unrelated to permissions.
  const gh = new Octokit({ auth: token, log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } });
  let repoInfo, pr;
  try {
    [{ data: repoInfo }, { data: pr }] = await Promise.all([
      gh.rest.repos.get({ owner, repo }),
      gh.rest.pulls.get({ owner, repo, pull_number: probePr }),
    ]);
  } catch (e) {
    // Report status and message only; the error object carries request details.
    const status = (e as { status?: number }).status;
    fail("merge probe", `could not read PR #${probePr}: ${status ?? ""} ${(e as Error).message}`.replace(/\s+/g, " "));
  }
  if (!repoInfo || !pr) {
    // already reported
  } else if (pr.base.ref === repoInfo.default_branch) {
    fail("merge probe", `PR #${probePr} targets the default branch (${pr.base.ref}); use a PR into a throwaway branch`);
  } else if (pr.draft || pr.state !== "open") {
    fail("merge probe", `PR #${probePr} must be open and not a draft (draft=${pr.draft}, state=${pr.state})`);
  } else {
    writePolicy("allow");
    // A separate log keeps the probe's entries apart from the main run.
    const mergeLog = join(dir, "audit-merge-probe.jsonl");
    const mergeClient = await startClient(mergeLog);
    let r: ToolResult;
    try {
      r = await call(mergeClient, "merge_pull_request", { owner, repo, pull_number: probePr });
    } finally {
      await mergeClient.close();
      writePolicy("deny");
    }
    const body = text(r);
    if (!r.isError) {
      fail("merge probe", `MERGED PR #${probePr} into ${pr.base.ref}: the token has Contents: write. Recreate it without that permission.`);
    } else if (/GitHub API error 403/.test(body) && /not accessible/i.test(body)) {
      ok(`token cannot merge without Contents: write (${body.slice(0, 100)})`);
    } else {
      fail("merge probe", `inconclusive, expected a 403 permission error, got: ${body.slice(0, 200)}`);
    }
  }
}

console.log("");
if (failures.length) {
  console.error(`FAILED ${failures.length} check(s):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("OK  all live e2e checks passed");
console.log(`    audit log: ${logPath}`);
