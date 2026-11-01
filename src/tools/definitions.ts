import { z } from "zod";
import type { GitHubClient } from "../github/client.js";

export type ToolKind = "read" | "write";

export interface ToolDefinition<S extends z.ZodObject = z.ZodObject> {
  name: string;
  description: string;
  kind: ToolKind;
  inputSchema: S;
  handler: (gh: GitHubClient, args: z.infer<S>) => Promise<unknown>;
}

export type AnyToolDefinition = ToolDefinition<z.ZodObject>;

/**
 * Types each handler against its own schema, then erases to a common type for the
 * registry. Sound because `execute` always parses args with `inputSchema` before
 * calling `handler`.
 */
function defineTool<S extends z.ZodObject>(def: ToolDefinition<S>): AnyToolDefinition {
  return def as unknown as AnyToolDefinition;
}

// GitHub naming rules: owners are alphanumeric + hyphen (max 39); repos also allow "." and "_".
const owner = z
  .string()
  .regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, "invalid GitHub owner")
  .describe("Repository owner (user or org)");
const repo = z
  .string()
  .regex(/^[A-Za-z0-9._-]{1,100}$/, "invalid GitHub repo name")
  .refine((r) => r !== "." && r !== "..", "invalid GitHub repo name")
  .describe("Repository name");
const repoRef = { owner, repo };
const number = (what: string) => z.number().int().positive().describe(what);
const gitRef = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9._/-]+$/, "invalid git ref");

export const tools: readonly AnyToolDefinition[] = [
  defineTool({
    name: "list_issues",
    description: "List issues (not pull requests) in a repository.",
    kind: "read",
    inputSchema: z.strictObject({
      ...repoRef,
      state: z.enum(["open", "closed", "all"]).default("open"),
      per_page: z.number().int().min(1).max(50).default(20),
    }),
    async handler(gh, { owner, repo, state, per_page }) {
      const { data } = await gh.rest.issues.listForRepo({ owner, repo, state, per_page });
      return data
        .filter((i) => !i.pull_request)
        .map((i) => ({
          number: i.number,
          title: i.title,
          state: i.state,
          author: i.user?.login ?? null,
          labels: i.labels.map((l) => (typeof l === "string" ? l : l.name)),
          comments: i.comments,
          url: i.html_url,
        }));
    },
  }),

  defineTool({
    name: "get_issue",
    description: "Get a single issue by number, including its body.",
    kind: "read",
    inputSchema: z.strictObject({ ...repoRef, issue_number: number("Issue number") }),
    async handler(gh, { owner, repo, issue_number }) {
      const { data: i } = await gh.rest.issues.get({ owner, repo, issue_number });
      return {
        number: i.number,
        title: i.title,
        state: i.state,
        author: i.user?.login ?? null,
        body: i.body ?? "",
        labels: i.labels.map((l) => (typeof l === "string" ? l : l.name)),
        comments: i.comments,
        url: i.html_url,
      };
    },
  }),

  defineTool({
    name: "comment_on_issue",
    description: "Post a comment on an issue or pull request.",
    kind: "write",
    inputSchema: z.strictObject({
      ...repoRef,
      issue_number: number("Issue or PR number"),
      body: z.string().min(1).max(10_000).describe("Comment text (Markdown)"),
    }),
    async handler(gh, { owner, repo, issue_number, body }) {
      const { data } = await gh.rest.issues.createComment({ owner, repo, issue_number, body });
      return { id: data.id, url: data.html_url };
    },
  }),

  defineTool({
    name: "create_pull_request",
    description: "Open a pull request from an existing head branch into a base branch.",
    kind: "write",
    inputSchema: z.strictObject({
      ...repoRef,
      title: z.string().min(1).max(256),
      head: gitRef.describe("Branch containing the changes"),
      base: gitRef.describe("Branch to merge into"),
      body: z.string().max(20_000).optional(),
      draft: z.boolean().default(false),
    }),
    async handler(gh, { owner, repo, title, head, base, body, draft }) {
      const { data } = await gh.rest.pulls.create({ owner, repo, title, head, base, body, draft });
      return { number: data.number, state: data.state, draft: data.draft, url: data.html_url };
    },
  }),

  defineTool({
    name: "get_ci_status",
    description: "Get combined commit status and check runs for a branch, tag or SHA.",
    kind: "read",
    inputSchema: z.strictObject({ ...repoRef, ref: gitRef.describe("Branch, tag or commit SHA") }),
    async handler(gh, { owner, repo, ref }) {
      const [status, checks] = await Promise.all([
        gh.rest.repos.getCombinedStatusForRef({ owner, repo, ref }),
        gh.rest.checks.listForRef({ owner, repo, ref, per_page: 50 }),
      ]);
      return {
        ref,
        sha: status.data.sha,
        combined_state: status.data.state,
        statuses: status.data.statuses.map((s) => ({ context: s.context, state: s.state })),
        check_runs: checks.data.check_runs.map((c) => ({
          name: c.name,
          status: c.status,
          conclusion: c.conclusion,
        })),
      };
    },
  }),

  defineTool({
    name: "merge_pull_request",
    description: "Merge a pull request.",
    kind: "write",
    inputSchema: z.strictObject({
      ...repoRef,
      pull_number: number("Pull request number"),
      merge_method: z.enum(["merge", "squash", "rebase"]).default("squash"),
      sha: z
        .string()
        .regex(/^[0-9a-f]{40}$/, "must be a full 40-char commit SHA")
        .optional()
        .describe("Only merge if the PR head matches this SHA"),
    }),
    async handler(gh, { owner, repo, pull_number, merge_method, sha }) {
      const { data } = await gh.rest.pulls.merge({ owner, repo, pull_number, merge_method, sha });
      return { merged: data.merged, sha: data.sha, message: data.message };
    },
  }),
];

export const toolsByName: ReadonlyMap<string, AnyToolDefinition> = new Map(
  tools.map((t) => [t.name, t]),
);
