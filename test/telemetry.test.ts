import { SpanStatusCode, type Tracer } from "@opentelemetry/api";
import { BasicTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { describe, expect, it, vi } from "vitest";
import { createRedactor } from "../src/audit/redact.js";
import { initTelemetry, StderrSpanExporter } from "../src/telemetry.js";
import { execute } from "../src/tools/execute.js";
import { FAKE_TOKEN, harness } from "./helpers.js";

const ok = { owner: "octocat", repo: "sandbox" };
const createR = () => createRedactor([FAKE_TOKEN]);

describe("one span per tool call", () => {
  it("emits exactly one span per call, for every outcome", async () => {
    const h = harness();
    await h.run("list_issues", ok); // allow
    await h.run("merge_pull_request", { ...ok, pull_number: 1 }); // deny
    await h.run("create_pull_request", { ...ok, title: "t", head: "f", base: "main" }); // dry run
    await h.run("comment_on_issue", { ...ok, issue_number: 1, body: "hi" }); // allowed write: 2 log entries, 1 span
    await h.run("delete_repo", ok); // unknown
    expect(h.spans().map((s) => s.name)).toEqual([
      "tools/call list_issues",
      "tools/call merge_pull_request",
      "tools/call create_pull_request",
      "tools/call comment_on_issue",
      "tools/call",
    ]);
  });

  it("records the decision and links to the audit entry by seq", async () => {
    const h = harness();
    await h.run("merge_pull_request", { ...ok, pull_number: 1 });
    const [span] = h.spans();
    expect(span!.attributes).toMatchObject({
      "mcp.method.name": "tools/call",
      "gen_ai.tool.name": "merge_pull_request",
      "gated.tool.kind": "write",
      "gated.decision": "deny",
      "gated.deny_reason": "tool_denied",
      "gated.result.status": "denied",
      "gated.policy.hash": h.policy.hash,
      "gated.audit.seq": h.last().seq,
    });
  });

  it("marks GitHub failures as span errors", async () => {
    const h = harness();
    h.github.fns.listForRepo.mockRejectedValueOnce(Object.assign(new Error("Server exploded"), { status: 500 }));
    await h.run("list_issues", ok);
    expect(h.spans()[0]!.status).toEqual({ code: SpanStatusCode.ERROR, message: "GitHub API error 500: Server exploded" });
  });

  it("leaves denials and dry runs unset (policy working is not an error)", async () => {
    const h = harness();
    await h.run("merge_pull_request", { ...ok, pull_number: 1 });
    await h.run("create_pull_request", { ...ok, title: "t", head: "f", base: "main" });
    expect(h.spans().map((s) => s.status.code)).toEqual([SpanStatusCode.UNSET, SpanStatusCode.UNSET]);
  });
});

describe("spans never carry arguments or secrets", () => {
  it("omits args and redacts agent-supplied tool names", async () => {
    const h = harness();
    await h.run("comment_on_issue", { ...ok, issue_number: 1, body: `secret body ${FAKE_TOKEN}` });
    await h.run(`evil-${FAKE_TOKEN}`, {});
    h.github.fns.listForRepo.mockRejectedValueOnce(new Error(`leak ${FAKE_TOKEN}`));
    await h.run("list_issues", ok);
    const dump = JSON.stringify(h.spans().map((s) => ({ n: s.name, a: s.attributes, st: s.status })));
    expect(dump).not.toContain(FAKE_TOKEN);
    expect(dump).not.toContain("secret body");
    expect(h.spans()[1]!.name).toBe("tools/call"); // unknown name kept out of the span name
  });
});

describe("tracing cannot break or bypass a call", () => {
  it("still runs and logs the call when the tracer throws", async () => {
    const h = harness();
    const broken = { startSpan: () => { throw new Error("tracer down"); } } as unknown as Tracer;
    const r = await execute({ policy: h.policy, audit: h.audit, redactor: createR(), getGitHub: h.getGitHub, tracer: broken }, "list_issues", ok);
    expect(r.isError).toBeUndefined();
    expect(h.last()).toMatchObject({ tool: "list_issues", result: { status: "ok" } });
  });

  it("still denies when the tracer throws", async () => {
    const h = harness();
    const broken = { startSpan: () => { throw new Error("tracer down"); } } as unknown as Tracer;
    const r = await execute({ policy: h.policy, audit: h.audit, redactor: createR(), getGitHub: h.getGitHub, tracer: broken }, "merge_pull_request", { ...ok, pull_number: 1 });
    expect(r.isError).toBe(true);
    expect(h.github.fns.merge).not.toHaveBeenCalled();
  });
});

describe("console exporter", () => {
  it("writes one JSON line per span to its writer, never to stdout", async () => {
    const lines: string[] = [];
    const stdout = vi.spyOn(process.stdout, "write");
    const tracer = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(new StderrSpanExporter((l) => lines.push(l)))],
    }).getTracer("t");
    const h = harness();
    await execute({ policy: h.policy, audit: h.audit, redactor: createR(), getGitHub: h.getGitHub, tracer }, "merge_pull_request", { ...ok, pull_number: 1 });
    expect(stdout).not.toHaveBeenCalled();
    stdout.mockRestore();
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ otel: "span", name: "tools/call merge_pull_request", attributes: { "gated.decision": "deny" } });
  });

  it("is off unless OTEL_TRACES_EXPORTER=console", () => {
    expect(initTelemetry({}).startSpan("x").isRecording()).toBe(false);
    expect(initTelemetry({ OTEL_TRACES_EXPORTER: "none" }).startSpan("x").isRecording()).toBe(false);
    expect(initTelemetry({ OTEL_TRACES_EXPORTER: "console" }).startSpan("x").isRecording()).toBe(true);
  });

  it("warns on an unsupported exporter instead of failing", () => {
    const warnings: string[] = [];
    expect(initTelemetry({ OTEL_TRACES_EXPORTER: "otlp" }, (m) => warnings.push(m)).startSpan("x").isRecording()).toBe(false);
    expect(warnings.join()).toMatch(/not supported/);
  });
});
