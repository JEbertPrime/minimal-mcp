import typescript from "@rollup/plugin-typescript";
import dts from "rollup-plugin-dts";
import type { RollupOptions } from "rollup";

const input = "src/mcp-client.ts";

const config: RollupOptions[] = [
  // ── ESM + CJS bundles ─────────────────────────────────────────────────────
  {
    input,
    output: [
      {
        file: "dist/mcp-client.js",
        format: "esm",
        sourcemap: true,
      },
      {
        file: "dist/mcp-client.cjs",
        format: "cjs",
        sourcemap: true,
        // CJS consumers may be in strict mode; keep exports clean.
        exports: "named",
      },
    ],
    plugins: [
      typescript({
        tsconfig: "./tsconfig.build.json",
        declaration: false, // declarations handled by the dts pass below
      }),
    ],
  },

  // ── Type declarations ─────────────────────────────────────────────────────
  {
    input,
    output: {
      file: "dist/mcp-client.d.ts",
      format: "esm",
    },
    plugins: [
      dts({
        tsconfig: "./tsconfig.build.json",
      }),
    ],
  },
];

export default config;
