import { defineConfig } from "tsup";

// this file is the config for the tsup bundler
// which build the npm package

export default defineConfig({
  entry: ["src/server.ts"],
  outDir: "./dist",
  dts: false,
  format: ["esm"],
  clean: true,
  splitting: false,
  sourcemap: true,
});

