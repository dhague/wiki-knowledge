/**
 * The check and fix command group: run a vault health check by name or all
 * checks, and apply an auto-fix by name. The known names shown in help and
 * errors are derived from the registries.
 */

import { InvalidArgumentError, type Command } from "commander";
import { CHECKS, DefaultMinSimilarity, FIXES, runAllChecks } from "./check.js";
import { VaultRead } from "./vaultread.js";
import { emitRows, fail } from "./output.js";
import { resolveRoot } from "./vault.js";

export function registerCheckFixCommands(program: Command): void {
  const checkNames = Object.keys(CHECKS).join(", ");

  // check [<name>] [--json] — run one vault health check by name, or every one
  // with --all. The name is optional only alongside --all.
  program
    .command("check")
    .description(
      `Run a vault health check by name, or --all; names: ${checkNames}`,
    )
    .argument("[name]", "check name")
    .option("--json", "emit findings as JSON Lines (one object per line)")
    .option(
      "--all",
      "run every check; each row carries its slug (JSON) or is prefixed with it (text)",
    )
    .option(
      "--min-similarity <n>",
      `concept-fragmentation cutoff, 0-1 (default ${DefaultMinSimilarity})`,
      (v: string) => {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0 || n > 1) {
          throw new InvalidArgumentError(
            `must be a number in [0, 1], got "${v}"`,
          );
        }
        return n;
      },
    )
    .action(
      async (
        name: string | undefined,
        opts: { json?: boolean; all?: boolean; minSimilarity?: number },
      ) => {
        if (opts.all) {
          const root = resolveRoot();
          const rows = await runAllChecks(root, {
            minSimilarity: opts.minSimilarity,
          });
          if (opts.json) emitRows(rows);
          else
            for (const f of rows)
              console.log(`${f.check}: ${f.pageRef}: ${f.detail}`);
          return;
        }
        const fn = name ? CHECKS[name] : undefined;
        if (!fn) {
          fail(
            name
              ? `enchiridion check: unknown check "${name}"; known: ${checkNames}`
              : `enchiridion check: name a check or pass --all; known: ${checkNames}`,
          );
        }
        // One check's findings carry no check name — the caller named it.
        const root = resolveRoot();
        const findings = await fn(new VaultRead(root), {
          minSimilarity: opts.minSimilarity,
        });
        if (opts.json) emitRows(findings);
        else for (const f of findings) console.log(`${f.pageRef}: ${f.detail}`);
      },
    );

  const fixNames = Object.keys(FIXES).join(", ");

  // fix <name> — apply an auto-fix by name; prints each changed page ref.
  program
    .command("fix")
    .description(`Apply an auto-fix by name; names: ${fixNames}`)
    .argument("<name>", "fix name")
    .action(async (name: string) => {
      const fn = FIXES[name];
      if (!fn) {
        fail(`enchiridion fix: unknown fix "${name}"; known: ${fixNames}`);
      }
      const root = resolveRoot();
      const changed = await fn(root);
      for (const ref of changed) console.log(ref);
    });
}
