import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  dts: true,
  format: ["cjs", "iife", "esm"],
  clean: true,
  sourcemap: true,
});
