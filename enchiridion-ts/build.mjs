import esbuild from "esbuild";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Copy the .wasm sidecar next to the bundle: node-sqlite3-wasm is inlined
// (not external), so it looks for the .wasm beside the output — the
// co-location a packaged plugin ships.
const wasmSrc = path.join(
  __dirname,
  "node_modules",
  "node-sqlite3-wasm",
  "dist",
  "node-sqlite3-wasm.wasm",
);
fs.mkdirSync(path.join(__dirname, "dist"), { recursive: true });
fs.copyFileSync(
  wasmSrc,
  path.join(__dirname, "dist", "node-sqlite3-wasm.wasm"),
);

// One bundled entry point (plus the .wasm sidecar) that node/bun run directly;
// wiki-plugin/bin/enchiridion execs this output.
//
// CJS, not ESM: inlined CommonJS packages (yaml, isomorphic-git) fail as
// dynamic requires under esbuild's ESM output. The .cjs extension sidesteps
// `"type": "module"` and matches the shipped artifact's directory.
await esbuild.build({
  entryPoints: ["src/cli.ts"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: "dist/cli.cjs",
  external: [
    // node built-ins are external automatically under platform: "node".
    "node:*",
    // No third-party packages are external: cli.cjs must be self-contained so
    // a packaged install runs it with no node_modules.
  ],
});

console.log("Build complete: dist/cli.cjs + dist/node-sqlite3-wasm.wasm");
