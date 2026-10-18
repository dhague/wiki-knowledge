/**
 * The roster of production components that open the search index, fenced
 * against the source: a new call site fails here until its skipped-page
 * diagnostic is declared, because nothing else notices a forgotten emit.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const srcDir = path.dirname(fileURLToPath(import.meta.url));

/** How a command reports the pages the index could not hold. */
type Disposition = "stderr" | "in band" | "exempt";

/** One production `Index.open(` call site. */
interface IndexOpener {
  /** Source module, relative to `src/`. */
  module: string;
  /** The command surface this call site serves. */
  command: string;
  disposition: Disposition;
  /** Why a non-stderr opener reports its skips another way, or not at all. */
  reason?: string;
}

/** Every production `Index.open(` call site, one entry each. */
const INDEX_OPENERS: readonly IndexOpener[] = [
  {
    module: "ingestcommand.ts",
    command: "discover (--plan, --ref, single page)",
    disposition: "stderr",
  },
  { module: "searchcommand.ts", command: "search", disposition: "stderr" },
  {
    module: "searchcommand.ts",
    command: "search --reindex",
    disposition: "stderr",
  },
  {
    module: "searchcommand.ts",
    command: "search --status",
    disposition: "in band",
    reason:
      "unindexed_pages is the status document's own field (ADR-0015), so the diagnostic would duplicate it",
  },
  {
    module: "check.ts",
    command: "check concept-fragmentation",
    disposition: "stderr",
  },
  {
    module: "check.ts",
    command: "check consolidation-exclusions",
    disposition: "stderr",
  },
  {
    module: "check.ts",
    command: "fix consolidation-exclusions",
    disposition: "stderr",
  },
];

/** Every non-test source module under `src/`, label → text. */
function sourceModules(): Map<string, string> {
  const modules = new Map<string, string>();
  const walk = (dir: string): void => {
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts")
      ) {
        const label = path.relative(srcDir, abs).split(path.sep).join("/");
        modules.set(label, fs.readFileSync(abs, "utf8"));
      }
    }
  };
  walk(srcDir);
  return modules;
}

/** [INDEX_OPENERS] grouped by module. */
function openersByModule(): Map<string, IndexOpener[]> {
  const byModule = new Map<string, IndexOpener[]>();
  for (const opener of INDEX_OPENERS) {
    const entries = byModule.get(opener.module) ?? [];
    entries.push(opener);
    byModule.set(opener.module, entries);
  }
  return byModule;
}

/** `Index.open(` occurrences per module. */
function actualOpeners(modules: Map<string, string>): Map<string, number> {
  const openers = new Map<string, number>();
  for (const [module, source] of modules) {
    const callSites = source.split("Index.open(").length - 1;
    if (callSites > 0) openers.set(module, callSites);
  }
  return openers;
}

test("every production Index.open( call site has one roster entry", () => {
  const actual = actualOpeners(sourceModules());
  const declared = openersByModule();

  for (const [module, callSites] of actual) {
    const entries = declared.get(module);
    if (entries === undefined) {
      assert.fail(
        `${module} opens the index ${callSites} time(s) but has no INDEX_OPENERS entry; ` +
          "declare each call site with its own command surface and disposition " +
          "(stderr, in band, or exempt with a stated reason)",
      );
    }
    assert.equal(
      entries.length,
      callSites,
      `${module} opens the index ${callSites} time(s), but INDEX_OPENERS declares ` +
        `${entries.length}; declare each call site with its own command surface`,
    );
  }

  for (const module of declared.keys()) {
    if (!actual.has(module)) {
      assert.fail(
        `INDEX_OPENERS declares ${module}, but it no longer calls Index.open(; ` +
          "remove or update its entries",
      );
    }
  }
});

test("every non-stderr opener states why the diagnostic is not on stderr", () => {
  for (const opener of INDEX_OPENERS) {
    if (opener.disposition === "stderr") continue;
    assert.ok(
      (opener.reason ?? "").trim() !== "",
      `${opener.module}'s ${opener.command} is "${opener.disposition}" but states no reason; ` +
        "say where its skips go, or why it has none",
    );
  }
});

test("every stderr opener routes skips through output.ts", () => {
  const modules = sourceModules();
  for (const [module, openers] of openersByModule()) {
    const source = modules.get(module);
    assert.ok(
      source !== undefined,
      `${module} is declared but not found in src/`,
    );
    const stderrOpeners = openers.filter(
      (opener) => opener.disposition === "stderr",
    ).length;
    if (stderrOpeners === 0) continue;
    const emits = source.split("emitSkippedPages(").length - 1;
    assert.ok(
      emits >= stderrOpeners,
      `${module} declares ${stderrOpeners} stderr opener(s) but calls emitSkippedPages ` +
        `${emits} time(s); route each opener's skips through output.ts so the line ` +
        "format has one owner",
    );
  }
});
