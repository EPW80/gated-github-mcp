import { rmSync, mkdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FAKE_TOKEN, harness, text } from "./helpers.js";

const ok = { owner: "octocat", repo: "sandbox" };

describe("allowed calls", () => {
  it("reaches GitHub and logs an allow/ok entry", async () => {
    const h = harness();
    const r = await h.run("list_issues", ok);
    expect(r.isError).toBeUndefined();
    expect(h.github.fns.listForRepo).toHaveBeenCalledOnce();
    expect(h.last()).toMatchObject({ tool: "list_issues", decision: { outcome: "allow" }, result: { status: "ok" } });
  });

  it("matches the repo allowlist case-insensitively", async () => {
    const h = harness();
    const r = await h.run("list_issues", { owner: "OctoCat", repo: "SANDBOX" });
    expect(r.isError).toBeUndefined();
  });
});

describe("repo allowlist", () => {
  it.each([
    ["list_issues", { owner: "evil", repo: "other" }],
    ["comment_on_issue", { owner: "evil", repo: "other", issue_number: 1, body: "hi" }],
    ["list_issues", { owner: "octocat", repo: "different-repo" }],
  ])("denies %s on a non-allowlisted repo without calling GitHub", async (tool, args) => {
    const h = harness();
    const r = await h.run(tool, args);
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/not on the allowlist/);
    expect(h.getGitHub).not.toHaveBeenCalled();
    expect(h.github.totalCalls()).toBe(0);
    expect(h.last()).toMatchObject({ decision: { outcome: "deny", reason: "repo_not_allowed" }, result: { status: "denied" } });
  });
});

describe("tool modes", () => {
  it("denies a tool set to deny and never calls GitHub", async () => {
    const h = harness();
    const r = await h.run("merge_pull_request", { ...ok, pull_number: 1 });
    expect(r.isError).toBe(true);
    expect(text(r)).toBe("Denied by policy: merge_pull_request is set to deny");
    expect(h.getGitHub).not.toHaveBeenCalled();
    expect(h.github.fns.merge).not.toHaveBeenCalled();
    expect(h.last().decision).toEqual({ outcome: "deny", reason: "tool_denied" });
  });

  it("denies a tool missing from the policy (deny by default)", async () => {
    const h = harness();
    const r = await h.run("get_ci_status", { ...ok, ref: "main" });
    expect(r.isError).toBe(true);
    expect(h.github.totalCalls()).toBe(0);
    expect(h.last().decision.reason).toBe("tool_not_in_policy");
  });

  it("denies unknown tools", async () => {
    const h = harness();
    const r = await h.run("delete_repo", ok);
    expect(r.isError).toBe(true);
    expect(h.last().decision.reason).toBe("unknown_tool");
  });

  it.each([
    ["wrong type", { ...ok, issue_number: "1" }],
    ["negative number", { ...ok, issue_number: -1 }],
    ["extra field", { ...ok, issue_number: 1, sneaky: true }],
    ["__proto__ key", JSON.parse('{"owner":"octocat","repo":"sandbox","issue_number":1,"__proto__":{"x":1}}')],
    ["missing args", undefined],
  ])("denies malformed arguments (%s)", async (_label, args) => {
    const h = harness();
    const r = await h.run("get_issue", args);
    expect(r.isError).toBe(true);
    expect(h.github.totalCalls()).toBe(0);
    expect(h.last().decision.reason).toBe("invalid_arguments");
  });

  it("rejects a cross-repo PR head (owner:branch)", async () => {
    const h = harness(`version: 1\nrepos: [octocat/sandbox]\ntools:\n  create_pull_request: allow\n`);
    const r = await h.run("create_pull_request", { ...ok, title: "t", head: "evil:branch", base: "main" });
    expect(r.isError).toBe(true);
    expect(h.github.fns.create).not.toHaveBeenCalled();
  });
});

describe("dry_run", () => {
  it("returns the planned request and makes no API call", async () => {
    const h = harness();
    const r = await h.run("create_pull_request", { ...ok, title: "Add thing", head: "feat", base: "main" });
    expect(r.isError).toBeUndefined();
    const body = JSON.parse(text(r));
    expect(body).toMatchObject({
      dry_run: true,
      would_call: {
        method: "POST",
        endpoint: "/repos/octocat/sandbox/pulls",
        body: { title: "Add thing", head: "feat", base: "main", draft: false },
      },
    });
    expect(h.getGitHub).not.toHaveBeenCalled();
    expect(h.github.totalCalls()).toBe(0);
    expect(h.last()).toMatchObject({ decision: { outcome: "dry_run" }, result: { status: "dry_run" } });
  });

  it("still enforces the repo allowlist and argument validation", async () => {
    const h = harness();
    const a = await h.run("create_pull_request", { owner: "evil", repo: "x", title: "t", head: "f", base: "main" });
    const b = await h.run("create_pull_request", { ...ok, title: "", head: "f", base: "main" });
    expect(a.isError && b.isError).toBe(true);
  });
});

describe("errors are still logged", () => {
  it("logs a GitHub failure as error without leaking headers or the token", async () => {
    const h = harness();
    h.github.fns.listForRepo.mockRejectedValueOnce(
      Object.assign(new Error("Server exploded"), {
        status: 500,
        request: { headers: { authorization: `token ${FAKE_TOKEN}` } },
        response: { headers: { "x-secret": FAKE_TOKEN } },
      }),
    );
    const r = await h.run("list_issues", ok);
    expect(r.isError).toBe(true);
    expect(text(r)).toBe("GitHub API error 500: Server exploded");
    expect(h.last()).toMatchObject({ decision: { outcome: "allow" }, result: { status: "error", detail: "GitHub API error 500: Server exploded" } });
    expect(readFileSync(h.logPath, "utf8")).not.toContain(FAKE_TOKEN);
  });

  it("redacts a token that appears in an error message", async () => {
    const h = harness();
    h.github.fns.listForRepo.mockRejectedValueOnce(new Error(`failed using ${FAKE_TOKEN}`));
    await h.run("list_issues", ok);
    expect(readFileSync(h.logPath, "utf8")).not.toContain(FAKE_TOKEN);
    expect(h.last().result.detail).toContain("[REDACTED]");
  });

  it("logs the missing-token failure", async () => {
    const h = harness();
    h.getGitHub.mockImplementationOnce(() => {
      throw new Error("GITHUB_TOKEN is not set");
    });
    const r = await h.run("list_issues", ok);
    expect(r.isError).toBe(true);
    expect(h.last().result).toMatchObject({ status: "error", detail: "GITHUB_TOKEN is not set" });
  });
});

describe("secrets never reach the log", () => {
  it("redacts secret-looking argument keys and values, including in denied calls", async () => {
    const h = harness();
    await h.run("get_issue", { ...ok, issue_number: 1, api_key: "hunter2hunter2", note: FAKE_TOKEN });
    await h.run(`tool-${FAKE_TOKEN}`, {});
    const raw = readFileSync(h.logPath, "utf8");
    for (const s of [FAKE_TOKEN, "hunter2hunter2"]) expect(raw).not.toContain(s);
  });

  it("logs a comment body that contains a token only in redacted form", async () => {
    const h = harness();
    await h.run("comment_on_issue", { ...ok, issue_number: 1, body: `my token is ${FAKE_TOKEN}` });
    expect(readFileSync(h.logPath, "utf8")).not.toContain(FAKE_TOKEN);
  });
});

describe("audit log failure fails closed", () => {
  it("refuses all calls after a log write fails", async () => {
    const h = harness();
    rmSync(h.logPath);
    mkdirSync(h.logPath); // appending to a directory now fails

    const first = await h.run("list_issues", ok);
    expect(first.isError).toBe(true);
    expect(text(first)).toMatch(/Audit log write failed/);

    h.github.fns.listForRepo.mockClear();
    const second = await h.run("list_issues", ok);
    expect(text(second)).toMatch(/Audit log unavailable/);
    expect(h.github.fns.listForRepo).not.toHaveBeenCalled();
  });
});
