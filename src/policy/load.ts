import { readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { parse } from "yaml";
import { z } from "zod";
import { ownerSchema, repoSchema, toolsByName } from "../tools/definitions.js";

export type Mode = "allow" | "deny" | "dry_run";

export interface Policy {
  /** Lowercased "owner/repo" strings (GitHub names are case-insensitive). */
  repos: ReadonlySet<string>;
  tools: ReadonlyMap<string, Mode>;
  /** SHA-256 of the raw policy file, recorded in each audit entry. */
  hash: string;
}

export class PolicyError extends Error {}

const repoEntry = z.string().refine((s) => {
  const [owner, repo, ...rest] = s.split("/");
  return rest.length === 0 && ownerSchema.safeParse(owner).success && repoSchema.safeParse(repo).success;
}, "must be exactly owner/repo");

const fileSchema = z.strictObject({
  version: z.literal(1),
  repos: z.array(repoEntry),
  tools: z.record(z.string(), z.enum(["allow", "deny", "dry_run"])),
});

/**
 * Loads and validates the policy. Throws PolicyError on any problem; the caller
 * must refuse to start (fail closed). No defaults, no fallbacks.
 */
export function loadPolicy(path: string | undefined, warn: (m: string) => void = () => {}): Policy {
  if (!path) throw new PolicyError("POLICY_PATH is not set");

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new PolicyError(`Cannot read policy file ${path}: ${(e as NodeJS.ErrnoException).code ?? "error"}`);
  }

  let raw: unknown;
  try {
    raw = parse(text, { version: "1.2", uniqueKeys: true });
  } catch (e) {
    throw new PolicyError(`Policy is not valid YAML: ${(e as Error).message}`);
  }

  const parsed = fileSchema.safeParse(raw);
  if (!parsed.success) throw new PolicyError(`Invalid policy: ${z.prettifyError(parsed.error)}`);

  for (const [name, mode] of Object.entries(parsed.data.tools)) {
    const def = toolsByName.get(name);
    if (!def) throw new PolicyError(`Policy names unknown tool: ${name}`);
    if (mode === "dry_run" && (def.kind !== "write" || !def.plan)) {
      throw new PolicyError(`dry_run is only valid for write tools: ${name}`);
    }
  }

  if (parsed.data.repos.length === 0) warn("policy has an empty repo allowlist: every call will be denied");
  try {
    if (statSync(path).mode & 0o022) warn(`policy file ${path} is group- or world-writable`);
  } catch {
    /* stat failure is not fatal; the read already succeeded */
  }

  return {
    repos: new Set(parsed.data.repos.map((r) => r.toLowerCase())),
    tools: new Map(Object.entries(parsed.data.tools)),
    hash: createHash("sha256").update(text).digest("hex"),
  };
}
