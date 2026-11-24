import { defineConfig } from "tsdown"

// this file is the config for the tsdown bundler
// which build the npm package
//
// `build:npm` runs it once per format (`--format esm`, then `--format cjs --no-clean`): each run starts its own
// TypeScript process for the declarations, and running both at once doubles the build's peak memory.

export default defineConfig({
  entry: ["src/index.ts"],
  outDir: "./package/dist",
  dts: true,
  clean: true,
  sourcemap: true,
  // `index.js` + `index.d.ts` for ESM and `index.cjs` + `index.d.cts` for CJS, as package/package.json expects.
  fixedExtension: false,
  // Keep every package import in the declarations (zod, @trpc/server, ...) instead of inlining its types,
  // as the tsup build did.
  deps: { neverBundle: true },
  // Otherwise a type-only import whose types are not part of the public API stays as a bare `import "pkg"`.
  inputOptions: { treeshake: { moduleSideEffects: false } },
  // Mark the CJS build as a transpiled ES module (`exports.__esModule`), as it has always been.
  outputOptions: { esModule: true },
})
