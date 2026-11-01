// Manual smoke check: spawns the built server over stdio and exercises it.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const env = Object.fromEntries(
  Object.entries(process.env).filter((e): e is [string, string] => e[1] !== undefined),
);
const transport = new StdioClientTransport({ command: "node", args: ["dist/index.js"], env });
const client = new Client({ name: "smoke", version: "0.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log("tools:", tools.map((t) => t.name).join(", "));
console.log("list_issues schema:", JSON.stringify(tools[0]?.inputSchema));

const ok = { owner: "octocat", repo: "sandbox" };
const calls: [string, unknown][] = [
  ["list_issues", ok],
  ["create_pull_request", { ...ok, title: "t", head: "feat", base: "main" }],
  ["merge_pull_request", { ...ok, pull_number: 1 }],
  ["list_issues", { owner: "evil", repo: "other" }],
  ["get_issue", { ...ok, issue_number: -1 }],
  ["delete_repo", ok],
];
for (const [name, args] of calls) {
  const r = await client.callTool({ name, arguments: args as Record<string, unknown> });
  console.log(`${name} ->`, r.isError ? "ERROR" : "OK", JSON.stringify(r.content).slice(0, 200));
}
await client.close();
