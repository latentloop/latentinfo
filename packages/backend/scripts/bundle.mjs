/**
 * Bundle the backend into a single ESM file for production packaging.
 *
 * Externalizes:
 * - libsql + @libsql/* + @neon-rs/* + detect-libc: native addon chain uses
 *   dynamic require() that esbuild cannot statically analyze
 * - pino-pretty: devDependency, not available in production
 */

import * as esbuild from "esbuild"

await esbuild.build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "esm",
  outfile: "dist/bundle.mjs",
  external: [
    // Native addon chain — uses dynamic require() for platform detection
    "libsql",
    "@libsql/*",
    "@neon-rs/*",
    "detect-libc",
    // Pino — uses __dirname for worker.js resolution, incompatible with ESM bundling
    "pino",
    "pino-pretty",
  ],
  sourcemap: false,
  minify: false,
  // Banner to handle require() in ESM context (needed for externalized CJS packages)
  banner: {
    js: `import { createRequire } from "node:module"; const require = createRequire(import.meta.url);`,
  },
})

console.log("Backend bundled to dist/bundle.mjs")
