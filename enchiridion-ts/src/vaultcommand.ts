/**
 * The vault-root and placement command group: `vault` (root/move/kinds) plus
 * `init` and `place` — everything that answers where the vault is or where a
 * page goes. Two entry points keep the root help order unchanged.
 */

import type { Command } from "commander";
import path from "node:path";
import { KindFolders, Kinds, path as placePath } from "./place.js";
import { Vault, resolveRoot } from "./vault.js";
import { readKindMeta } from "./kindmeta.js";
import { init as initWiki, Modes } from "./initwiki.js";
import { emitDocument } from "./output.js";
import { KindDefinitionFields, KindFields } from "./contract.js";

export function registerPlacementCommands(program: Command): void {
  // init <path> — scaffold a brand-new vault from an explicit path, not a
  // resolved root; the resolved vault root is the only thing on stdout.
  program
    .command("init <path>")
    .description(
      `Scaffold a brand-new wiki vault; --mode is one of: ${Modes.join(", ")}`,
    )
    .requiredOption(
      "--mode <mode>",
      `deployment mode: one of ${Modes.join(", ")}`,
    )
    .option(
      "--plugin-root <dir>",
      "this plugin's install dir (required for query-from-anywhere)",
    )
    .action(
      async (
        vaultPath: string,
        opts: { mode: string; pluginRoot?: string },
      ) => {
        const root = await initWiki(
          vaultPath,
          opts.mode,
          opts.pluginRoot ?? "",
        );
        console.log(root);
      },
    );

  // place <kind> <title> — compute a page's vault-relative path (ADR-0020).
  program
    .command("place <kind> <title>")
    .description(
      `Compute a new page's vault-relative path from its kind and title; kind is one of: ${Kinds.join(", ")}, or a discovered custom kind-folder`,
    )
    .action((kind: string, title: string) => {
      const root = resolveRoot();
      const rel = placePath(kind, title, new Vault(root).discoveredKinds());
      console.log(rel);
    });
}

export function registerVaultCommand(program: Command): void {
  // vault — bare or `vault root` prints the resolved root, `vault move`
  // moves a page and fixes every link, `vault kinds` lists placement kinds as
  // JSON. The parent's action runs for bare `vault` and is inherited by a
  // subcommand with no handler of its own.
  const vault = program
    .command("vault")
    .description(
      "Resolve the vault root, or move a page within it (moves need exactly two page refs)",
    )
    .action(() => {
      const root = resolveRoot();
      console.log(root);
    });
  vault
    .command("root")
    .description("Print the resolved vault root (the no-argument default)")
    .action(() => {
      const root = resolveRoot();
      console.log(root);
    });
  vault
    .command("move")
    .description(
      "Move a page within the vault and fix every link, inbound and outbound",
    )
    .argument("<old_ref>", "vault-relative path of the page to move")
    .argument("<new_ref>", "vault-relative destination path")
    .action((oldRef: string, newRef: string) => {
      const root = resolveRoot();
      const changed = new Vault(root).movePage(oldRef, newRef);
      for (const pageRef of changed) console.log(pageRef);
    });
  vault
    .command("kinds")
    .description(
      `List all placement kinds as one compact JSON array: canonical four plus any discovered custom folders; each entry: {${KindFields.join(", ")}}, definition {${KindDefinitionFields.join(", ")}} or null`,
    )
    .action(() => {
      const root = resolveRoot();
      const vault = new Vault(root);
      const custom = vault.discoveredKinds();
      const result: {
        kind: string;
        folder: string;
        canonical: boolean;
        consolidatable: boolean;
        definition: { kind: string; summary: string } | null;
      }[] = [];
      for (const kind of Kinds) {
        const folder = KindFolders[kind];
        result.push({
          kind,
          folder,
          canonical: true,
          consolidatable: vault.isConsolidatable(folder),
          definition: null,
        });
      }
      for (const [kind, folder] of Object.entries(custom)) {
        const meta = readKindMeta(path.join(root, "wiki", folder));
        result.push({
          kind,
          folder,
          canonical: false,
          consolidatable: vault.isConsolidatable(folder),
          // Unchanged shape: a KIND.md declaring no kind contributes the flag,
          // not a definition.
          definition:
            meta === null || meta.kind === null
              ? null
              : { kind: meta.kind, summary: meta.summary },
        });
      }
      emitDocument(result);
    });
}
