import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["cjs", "esm"],
    dts: true,
    outDir: "dist",
    clean: true,
  },
  {
    entry: ["src/next/plugin.ts"],
    format: ["cjs"],
    outDir: "dist/next",
  },
  {
    entry: ["src/server/index.ts"],
    format: ["cjs"],
    outDir: "dist/server",
  },
  {
    entry: ["src/client-setup.ts"],
    format: ["cjs"],
    outDir: "dist",
  },
]);
