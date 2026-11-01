// Reproducible demo: starts the built server over stdio with a throwaway policy
// and log, asks it to dry-run a PR and to merge one, then prints the merge's
// audit entry and verifies the log. No GitHub token needed.
// Run: npm run build && npx tsx scripts/demo.ts
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { verifyLog } from "../src/audit/verify.js";

const dir = mkdtempSync(join(tmpdir(), "ggm-demo-"));
const policyPath = join(dir, "policy.yaml");
const logPath = join(dir, "audit.jsonl");
writeFileSync(
  policyPath,
  `version: 1
repos:
  - demo-org/sandbox
tools:
  list_issues: allow
  get_issue: allow
  comment_on_issue: allow
  create_pull_request: dry_run
  merge_pull_request: deny
`,
);

const client = new Client({ name: "demo", version: "0.0.0" });
await client.connect(
  new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    env: { PATH: process.env.PATH ?? "", POLICY_PATH: policyPath, AUDIT_LOG_PATH: logPath },
    stderr: "ignore",
  }),
);

const repo = { owner: "demo-org", repo: "sandbox" };
const show = async (name: string, args: Record<string, unknown>) => {
  const r = await client.callTool({ name, arguments: args });
  const body = (r.content as { text: string }[])[0]!.text;
  console.log(`$ ${name} ${JSON.stringify(args)}`);
  console.log(`${r.isError ? "✗ DENIED" : "✓ OK"}  ${body}\n`);
};

await show("create_pull_request", { ...repo, title: "Fix typo", head: "fix-typo", base: "main" });
await show("merge_pull_request", { ...repo, pull_number: 1 });
await client.close();

const entries = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
console.log("$ tail -1 audit.jsonl | jq");
console.log(JSON.stringify(entries.at(-1), null, 2) + "\n");

const v = verifyLog(logPath);
console.log("$ npm run verify-log audit.jsonl");
console.log(v.ok ? `OK  ${v.entries} entries, chain intact\n    head: ${v.head}` : `FAIL ${JSON.stringify(v)}`);
