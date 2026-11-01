// Regression tests for the Phase 4 adversarial review findings.
import { appendFileSync, chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { AuditLog } from "../src/audit/log.js";
import { createRedactor } from "../src/audit/redact.js";
import { verifyLog } from "../src/audit/verify.js";
import { toolsByName } from "../src/tools/definitions.js";
import { FAKE_TOKEN, harness, text } from "./helpers.js";

const ok = { owner: "octocat", repo: "sandbox" };
const comment = { ...ok, issue_number: 1, body: "hello" };

describe("allowed writes are logged before GitHub is called", () => {
  it("writes an intent entry, then the outcome", async () => {
    const h = harness();
    await h.run("comment_on_issue", comment);
    const [intent, outcome] = h.entries().slice(-2);
    expect(intent).toMatchObject({ event: "intent", tool: "comment_on_issue", result: { status: "pending" } });
    expect(outcome).toMatchObject({ event: "call", tool: "comment_on_issue", result: { status: "ok" } });
  });

  it("does not call GitHub if the intent entry cannot be written", async () => {
    const h = harness();
    rmSync(h.logPath);
    mkdirSync(h.logPath);
    const r = await h.run("comment_on_issue", comment);
    expect(text(r)).toMatch(/nothing was sent to GitHub/);
    expect(h.github.fns.createComment).not.toHaveBeenCalled();
  });

  it("reads and dry runs do not get an intent entry", async () => {
    const h = harness();
    await h.run("list_issues", ok);
    await h.run("create_pull_request", { ...ok, title: "t", head: "f", base: "main" });
    expect(h.entries().filter((e) => e.event === "intent")).toHaveLength(0);
  });
});

describe("unexpected exceptions are still logged", () => {
  it("logs a crash inside the dry-run path as an error", async () => {
    const h = harness();
    const def = toolsByName.get("create_pull_request")!;
    const spy = vi.spyOn(def, "plan").mockImplementation(() => {
      throw new Error("boom");
    });
    try {
      const r = await h.run("create_pull_request", { ...ok, title: "t", head: "f", base: "main" });
      expect(r.isError).toBe(true);
      expect(h.last()).toMatchObject({ decision: { outcome: "dry_run" }, result: { status: "error" } });
    } finally {
      spy.mockRestore();
    }
  });
});

describe("the log cannot be changed underneath a running server", () => {
  it("fails closed when another writer appends", async () => {
    const h = harness();
    await h.run("list_issues", ok);
    appendFileSync(h.logPath, readFileSync(h.logPath, "utf8").trim().split("\n").at(-1)! + "\n");
    const r = await h.run("comment_on_issue", comment);
    expect(r.isError).toBe(true);
    expect(h.github.fns.createComment).not.toHaveBeenCalled();
    expect(h.audit.failed).toBe(true);
  });

  it("fails closed when the log is truncated", async () => {
    const h = harness();
    await h.run("list_issues", ok);
    writeFileSync(h.logPath, readFileSync(h.logPath, "utf8").split("\n")[0] + "\n");
    expect((await h.run("comment_on_issue", comment)).isError).toBe(true);
    expect(h.github.fns.createComment).not.toHaveBeenCalled();
  });

  it("refuses to start on a log tampered in the middle (not just at the tail)", async () => {
    const h = harness();
    await h.run("list_issues", ok);
    await h.run("list_issues", ok);
    const lines = readFileSync(h.logPath, "utf8").trim().split("\n");
    lines[1] = lines[1]!.replace('"status":"ok"', '"status":"error"');
    writeFileSync(h.logPath, lines.join("\n") + "\n");
    expect(() => AuditLog.open(h.logPath, h.policy.hash, createRedactor())).toThrow(/line 2/);
  });

  it("warns when an existing log is readable by other users", () => {
    const h = harness();
    chmodSync(h.logPath, 0o644);
    const warnings: string[] = [];
    AuditLog.open(h.logPath, h.policy.hash, createRedactor(), (m) => warnings.push(m));
    expect(warnings.join()).toMatch(/other users/);
  });
});

describe("verify-log rejects non-canonical lines", () => {
  it("catches a duplicate key that displays a different value than the one hashed", async () => {
    const h = harness();
    await h.run("merge_pull_request", { ...ok, pull_number: 1 }); // denied
    const lines = readFileSync(h.logPath, "utf8").trim().split("\n");
    // JSON.parse keeps the LAST "decision", so the hash still matches, but a
    // human or grep reading left to right sees "allow" first.
    lines[1] = lines[1]!.replace('{"args"', '{"decision":{"outcome":"allow"},"args"');
    expect(JSON.parse(lines[1]!).decision.outcome).toBe("deny");
    writeFileSync(h.logPath, lines.join("\n") + "\n");
    expect(verifyLog(h.logPath)).toMatchObject({ ok: false, line: 2 });
  });

  it("catches reformatted JSON", async () => {
    const h = harness();
    const lines = readFileSync(h.logPath, "utf8").trim().split("\n");
    lines[0] = JSON.stringify(JSON.parse(lines[0]!), null, 1).replace(/\n/g, "");
    writeFileSync(h.logPath, lines.join("\n") + "\n");
    expect(verifyLog(h.logPath)).toMatchObject({ ok: false, line: 1 });
  });
});

describe("secrets", () => {
  it("redacts the configured token even when the env value has surrounding whitespace", () => {
    const r = createRedactor([`  ${FAKE_TOKEN}\n`]);
    expect(r.text(`x ${FAKE_TOKEN} y`)).not.toContain(FAKE_TOKEN);
    const custom = "custom-secret-without-known-prefix";
    expect(createRedactor([` ${custom} `]).text(custom)).toBe("[REDACTED]");
  });

  it("redacts error text returned to the agent, not just the log copy", async () => {
    const h = harness();
    h.github.fns.listForRepo.mockRejectedValueOnce(new Error(`bad ${FAKE_TOKEN}`));
    const r = await h.run("list_issues", ok);
    expect(text(r)).not.toContain(FAKE_TOKEN);
  });
});

describe("log integrity details", () => {
  it("an agent cannot forge a server start entry", async () => {
    const h = harness();
    await h.run("_server_start", {});
    await h.run("gated-github-mcp", {});
    expect(h.entries().filter((e) => e.event === "start")).toHaveLength(1);
  });

  it("caps oversized arguments in the log", async () => {
    const h = harness();
    const big = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`k${i}`, "x".repeat(1500)]));
    await h.run("delete_repo", big);
    expect(JSON.stringify(h.last().args).length).toBeLessThan(9_000);
  });
});

describe("git refs cannot rewrite the request path", () => {
  it.each(["..", ".", "a/../b", "a//b", "/main", "main/", ".hidden", "main.lock"])("rejects %j", async (ref) => {
    const h = harness(`version: 1\nrepos: [octocat/sandbox]\ntools:\n  get_ci_status: allow\n`);
    const r = await h.run("get_ci_status", { ...ok, ref });
    expect(r.isError).toBe(true);
    expect(h.last().decision.reason).toBe("invalid_arguments");
  });

  it.each(["main", "feature/x", "v1.2.3", "release-2026.11"])("accepts %j", async (ref) => {
    const h = harness(`version: 1\nrepos: [octocat/sandbox]\ntools:\n  get_ci_status: allow\n`);
    h.github.fns.getCombinedStatusForRef.mockResolvedValueOnce({ data: { sha: "s", state: "success", statuses: [] } });
    h.github.fns.listForRef.mockResolvedValueOnce({ data: { check_runs: [] } });
    expect((await h.run("get_ci_status", { ...ok, ref })).isError).toBeUndefined();
  });
});

describe("structure: every GitHub call goes through execute()", () => {
  it("only src/tools/execute.ts invokes handlers or the client factory", async () => {
    const { readdirSync } = await import("node:fs");
    const files = readdirSync("src", { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts"));
    const offenders = files.filter((f) => {
      const src = readFileSync(`src/${f}`, "utf8");
      return f !== "tools/execute.ts" && /\.handler\(|getGitHub\(\)/.test(src);
    });
    expect(offenders).toEqual([]);
  });

  it("no module outside definitions.ts and client.ts touches Octokit", async () => {
    const { readdirSync } = await import("node:fs");
    const files = readdirSync("src", { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts"));
    const offenders = files.filter(
      (f) => !["tools/definitions.ts", "github/client.ts"].includes(f) && /@octokit|\.rest\./.test(readFileSync(`src/${f}`, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
