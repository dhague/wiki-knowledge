/**
 * The lint body-reader command: `read-pages`, the bounded HEAD-pinned read the
 * `wiki-lint` judgment pass runs page bodies through (ADR-0029).
 */

import { InvalidArgumentError, type Command } from "commander";
import {
  DefaultBudget,
  DefaultLimit,
  DefaultMaxBytes,
  ErrBodies,
  readBodies,
} from "./lintbodies.js";
import { resolveRoot } from "./vault.js";
import { emitDocument, fail } from "./output.js";

/** A commander parser for a whole number no smaller than `floor`. */
function integerOption(what: string, floor: number): (value: string) => number {
  return (value: string) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < floor) {
      throw new InvalidArgumentError(
        `${what} must be an integer >= ${floor}, got "${value}"`,
      );
    }
    return n;
  };
}

export function registerReadPagesCommand(program: Command): void {
  program
    .command("read-pages")
    .argument(
      "[page_ref...]",
      "pages to read; absent, sweep the eligible pages in bounded batches",
    )
    .description(
      "Read page bodies from one committed HEAD snapshot: {head, eligible, returned, cached, next_after, remaining, budget, pages: [{page_ref, blob_oid, title, bytes, cached, body}]}",
    )
    .option(
      "--limit <n>",
      `pages per sweep batch (default ${DefaultLimit})`,
      integerOption("--limit", 1),
    )
    .option(
      "--max-bytes <n>",
      `body bytes per batch (default ${DefaultMaxBytes})`,
      integerOption("--max-bytes", 1),
    )
    .option(
      "--budget <n>",
      `bodies one lint run may newly read (default ${DefaultBudget})`,
      integerOption("--budget", 0),
    )
    .option(
      "--exclude <ref>",
      "a page a mechanical finding already flagged; repeatable, and the sweep skips it",
      (ref: string, previous: string[]) => [...previous, ref],
      [] as string[],
    )
    .option("--after <ref>", "continue a sweep after this page ref")
    .option(
      "--reset",
      "open a fresh lint run: drop the ledger, its cache and its spent budget",
    )
    .action(
      async (
        refs: string[],
        opts: {
          limit?: number;
          maxBytes?: number;
          budget?: number;
          exclude?: string[];
          after?: string;
          reset?: boolean;
        },
      ) => {
        const root = resolveRoot();
        try {
          emitDocument(
            await readBodies(root, {
              refs: refs.length > 0 ? refs : undefined,
              limit: opts.limit,
              maxBytes: opts.maxBytes,
              budget: opts.budget,
              exclude: opts.exclude,
              after: opts.after,
              reset: opts.reset,
            }),
          );
        } catch (err) {
          if (err instanceof ErrBodies) fail(err.message);
          throw err;
        }
      },
    );
}
