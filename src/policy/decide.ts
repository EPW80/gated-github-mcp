import type { AnyToolDefinition } from "../tools/definitions.js";
import { toolsByName } from "../tools/definitions.js";
import type { Policy } from "./load.js";

export type DenyReason =
  | "unknown_tool"
  | "tool_denied"
  | "tool_not_in_policy"
  | "invalid_arguments"
  | "repo_not_allowed"
  | "policy_error";

export type Decision =
  | { outcome: "deny"; reason: DenyReason; message: string }
  | { outcome: "dry_run"; def: AnyToolDefinition; args: Record<string, unknown> }
  | { outcome: "allow"; def: AnyToolDefinition; args: Record<string, unknown> };

const deny = (reason: DenyReason, message: string): Decision => ({
  outcome: "deny",
  reason,
  message: `Denied by policy: ${message}`,
});

/** Pure decision function. First matching rule wins; anything unexpected denies. */
export function decide(policy: Policy, name: string, rawArgs: unknown): Decision {
  try {
    const def = toolsByName.get(name);
    if (!def) return deny("unknown_tool", `unknown tool ${name}`);

    const mode = policy.tools.get(name);
    if (mode === undefined) return deny("tool_not_in_policy", `${name} is not listed in the policy`);
    if (mode === "deny") return deny("tool_denied", `${name} is set to deny`);

    const parsed = def.inputSchema.safeParse(rawArgs ?? {});
    if (!parsed.success) return deny("invalid_arguments", `invalid arguments for ${name}`);
    const args = parsed.data as Record<string, unknown>;

    const slug = `${String(args.owner)}/${String(args.repo)}`.toLowerCase();
    if (!policy.repos.has(slug)) return deny("repo_not_allowed", `repository ${slug} is not on the allowlist`);

    if (mode === "dry_run") return { outcome: "dry_run", def, args };
    if (mode === "allow") return { outcome: "allow", def, args };
    return deny("policy_error", "unrecognized policy mode");
  } catch {
    return deny("policy_error", "policy evaluation failed");
  }
}
