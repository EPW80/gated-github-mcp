import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "node_modules"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // stdout is the MCP transport; anything else written there corrupts the protocol.
      "no-console": ["error", { allow: ["error"] }],
    },
  },
  { files: ["scripts/**"], rules: { "no-console": "off" } },
);
