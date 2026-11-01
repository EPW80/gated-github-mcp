import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadPolicy, PolicyError } from "../src/policy/load.js";
import { DEFAULT_POLICY, tempDir } from "./helpers.js";

function load(yaml: string, warn?: (m: string) => void) {
  const p = join(tempDir(), "policy.yaml");
  writeFileSync(p, yaml);
  return loadPolicy(p, warn);
}

describe("loadPolicy fails closed", () => {
  it("rejects an unset path", () => expect(() => loadPolicy(undefined)).toThrow(PolicyError));
  it("rejects a missing file", () => expect(() => loadPolicy("/nonexistent/policy.yaml")).toThrow(/Cannot read/));

  it.each([
    ["invalid YAML", "version: [1\n"],
    ["duplicate keys", "version: 1\nrepos: []\ntools:\n  list_issues: allow\n  list_issues: deny\n"],
    ["wrong version", "version: 2\nrepos: []\ntools: {}\n"],
    ["missing version", "repos: []\ntools: {}\n"],
    ["unknown top-level key", "version: 1\nrepos: []\ntools: {}\nextra: 1\n"],
    ["invalid mode", "version: 1\nrepos: []\ntools:\n  list_issues: maybe\n"],
    ["boolean-looking mode", "version: 1\nrepos: []\ntools:\n  list_issues: yes\n"],
    ["unknown tool name (typo)", "version: 1\nrepos: []\ntools:\n  merge_pull_requests: deny\n"],
    ["dry_run on a read tool", "version: 1\nrepos: []\ntools:\n  list_issues: dry_run\n"],
    ["wildcard repo", "version: 1\nrepos: ['octocat/*']\ntools: {}\n"],
    ["repo without owner", "version: 1\nrepos: ['sandbox']\ntools: {}\n"],
    ["empty file", ""],
  ])("rejects %s", (_label, yaml) => {
    expect(() => load(yaml)).toThrow(PolicyError);
  });
});

describe("loadPolicy accepts a valid policy", () => {
  it("parses repos (lowercased), modes and a stable hash", () => {
    const a = load(DEFAULT_POLICY);
    const b = load(DEFAULT_POLICY);
    expect([...a.repos]).toEqual(["octocat/sandbox"]);
    expect(a.tools.get("merge_pull_request")).toBe("deny");
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.hash).toBe(b.hash);
    expect(load(DEFAULT_POLICY + "# changed\n").hash).not.toBe(a.hash);
  });

  it("warns on an empty allowlist", () => {
    const warnings: string[] = [];
    load("version: 1\nrepos: []\ntools: {}\n", (m) => warnings.push(m));
    expect(warnings.join()).toMatch(/empty repo allowlist/);
  });

  it("warns when the file is group/world-writable", () => {
    const p = join(tempDir(), "policy.yaml");
    writeFileSync(p, DEFAULT_POLICY);
    chmodSync(p, 0o666);
    const warnings: string[] = [];
    loadPolicy(p, (m) => warnings.push(m));
    expect(warnings.join()).toMatch(/writable/);
  });
});
