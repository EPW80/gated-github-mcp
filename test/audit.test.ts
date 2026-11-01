import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AuditError, AuditLog } from "../src/audit/log.js";
import { createRedactor } from "../src/audit/redact.js";
import { verifyLog } from "../src/audit/verify.js";
import { harness } from "./helpers.js";

const ok = { owner: "octocat", repo: "sandbox" };

async function populated() {
  const h = harness();
  await h.run("list_issues", ok);
  await h.run("merge_pull_request", { ...ok, pull_number: 1 }); // denied
  await h.run("create_pull_request", { ...ok, title: "t", head: "f", base: "main" }); // dry run
  await h.run("delete_repo", ok); // unknown
  return h;
}

describe("hash chain", () => {
  it("verifies an intact log and records the policy hash on every entry", async () => {
    const h = await populated();
    const r = verifyLog(h.logPath);
    expect(r).toMatchObject({ ok: true, entries: 5 }); // start entry + 4 calls
    expect(new Set(h.entries().map((e) => e.policy_hash))).toEqual(new Set([h.policy.hash]));
    expect(h.entries()[0]).toMatchObject({ tool: "_server_start", seq: 0 });
  });

  it("fails verification when an entry is hand-edited", async () => {
    const h = await populated();
    const lines = readFileSync(h.logPath, "utf8").trim().split("\n");
    lines[2] = lines[2]!.replace('"outcome":"deny"', '"outcome":"allow"'); // the denied merge
    expect(lines[2]).toContain('"outcome":"allow"');
    writeFileSync(h.logPath, lines.join("\n") + "\n");

    const r = verifyLog(h.logPath);
    expect(r).toMatchObject({ ok: false, line: 3, seq: 2 });
    expect((r as { problem: string }).problem).toMatch(/edited/);
  });

  it("fails when an entry is edited AND its hash recomputed by hand (next link breaks)", async () => {
    const h = await populated();
    const entries = h.entries();
    entries[2]!.decision = { outcome: "allow" };
    const { hashEntry } = await import("../src/audit/chain.js");
    entries[2]!.hash = hashEntry(entries[2]!);
    writeFileSync(h.logPath, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
    expect(verifyLog(h.logPath)).toMatchObject({ ok: false, line: 4 });
  });

  it("fails when an entry is deleted", async () => {
    const h = await populated();
    const lines = readFileSync(h.logPath, "utf8").trim().split("\n");
    lines.splice(2, 1);
    writeFileSync(h.logPath, lines.join("\n") + "\n");
    expect(verifyLog(h.logPath)).toMatchObject({ ok: false, line: 3 });
  });

  it("fails when entries are reordered", async () => {
    const h = await populated();
    const lines = readFileSync(h.logPath, "utf8").trim().split("\n");
    [lines[2], lines[3]] = [lines[3]!, lines[2]!];
    writeFileSync(h.logPath, lines.join("\n") + "\n");
    expect(verifyLog(h.logPath)).toMatchObject({ ok: false, line: 3 });
  });

  it("fails on a garbage line", async () => {
    const h = await populated();
    const lines = readFileSync(h.logPath, "utf8").trim().split("\n");
    lines[1] = "not json";
    writeFileSync(h.logPath, lines.join("\n") + "\n");
    expect(verifyLog(h.logPath)).toMatchObject({ ok: false, line: 2 });
  });
});

describe("log lifecycle", () => {
  it("resumes the chain after a restart", async () => {
    const h = await populated();
    AuditLog.open(h.logPath, h.policy.hash, createRedactor());
    expect(verifyLog(h.logPath)).toMatchObject({ ok: true, entries: 6 });
  });

  it("refuses to open a log whose last entry is corrupt", async () => {
    const h = await populated();
    writeFileSync(h.logPath, readFileSync(h.logPath, "utf8") + "garbage\n");
    expect(() => AuditLog.open(h.logPath, h.policy.hash, createRedactor())).toThrow(AuditError);
  });

  it("refuses to open without a path", () => {
    expect(() => AuditLog.open(undefined, "x", createRedactor())).toThrow(/AUDIT_LOG_PATH/);
  });
});
