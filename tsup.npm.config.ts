import { defineConfig } from "tsup";

// this file is the config for the tsup bundler
// which build the npm package

export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "./package/dist",
  dts: true,
  format: ["cjs", "esm"],
  clean: true,
  splitting: false,
  sourcemap: true,
});

