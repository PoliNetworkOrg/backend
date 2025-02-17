import { defineConfig } from "tsup";

// this file is the config for the tsup bundler
// which build the npm package 

export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "./lib",
  dts: true,
  format: ["cjs", "iife", "esm"],
  clean: true,
  sourcemap: true,
});
