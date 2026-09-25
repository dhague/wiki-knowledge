// Import-safety test for the esbuild CJS bundle: importing it must be inert
// (main() runs only when the module is the direct CLI entry), `run(...)` must
// execute in-process, and the host's exitCode must stay clean. Runs under Node
// ESM and Bun — on Node the CJS namespace's `default` is module.exports, on Bun
// `mod.run` is present directly.
import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Asserted in a CHILD process: if main() ran unconditionally it would
// process.exit during import, killing the host before any assertion and
// looking like a pass. The child prints a sentinel after importing; a missing
// sentinel or non-zero child exit fails this script.
const bundlePath = fileURLToPath(new URL("../dist/cli.cjs", import.meta.url));
const inert = execFileSync(
  process.execPath,
  [
    "-e",
    "import(process.argv[1]).then(() => console.log('import-alive'))",
    bundlePath,
  ],
  { encoding: "utf8" },
);
assert.ok(
  inert.includes("import-alive"),
  "importing the bundle must not run main() (host died on import)",
);

const mod = await import("../dist/cli.cjs");
const entry = mod.run ? mod : mod.default;
assert.equal(typeof entry.run, "function", "bundle must export run()");

const usage = await entry.run([]);
assert.equal(usage.exitCode, 0, "run([]) must exit 0");
assert.ok(
  usage.stdout.includes("Usage:"),
  "run([]) must print usage to stdout",
);

const placed = await entry.run(["place", "concept", "import-safety-check"]);
assert.equal(placed.exitCode, 0, "run(place) must exit 0");
assert.ok(
  placed.stdout.includes("import-safety-check"),
  "run(place) must produce the placed page path (an action handler ran in-process)",
);

assert.ok(
  process.exitCode == null || process.exitCode === 0,
  `host process must not be left with a failing exitCode (got ${process.exitCode})`,
);

console.log(
  "import-safety: bundle imports inertly, run() works in-process, host unaffected",
);
