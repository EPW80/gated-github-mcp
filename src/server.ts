import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { tools } from "./tools/definitions.js";
import { execute, type ExecuteDeps } from "./tools/execute.js";

/**
 * Uses the SDK's low-level Server rather than McpServer.registerTool on purpose:
 * McpServer validates arguments and rejects unknown tool names before any tool
 * callback runs, so those calls would bypass the policy wrapper and audit log.
 * Here one CallTool handler receives every call and hands it to `execute`.
 */
export function createServer(deps: ExecuteDeps): Server {
  const server = new Server(
    { name: "gated-github-mcp", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  const listed = tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: z.toJSONSchema(t.inputSchema, { io: "input" }) as {
      type: "object";
      [k: string]: unknown;
    },
    annotations: {
      readOnlyHint: t.kind === "read",
      destructiveHint: t.name === "merge_pull_request",
      openWorldHint: true,
    },
  }));

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: listed }));
  server.setRequestHandler(CallToolRequestSchema, (req) =>
    execute(deps, req.params.name, req.params.arguments),
  );

  return server;
}
