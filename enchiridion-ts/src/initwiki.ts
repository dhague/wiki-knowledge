/**
 * Scaffolds a new wiki vault — kind-folders, git repo, .gitignore, and (for
 * query-from-anywhere mode) the plugin-registration settings.json — or seeds a
 * git repo around an existing `wiki/` tree that has no git work tree.
 *
 * [init] refuses a directory that is already a vault ([isVault]: a marker and a
 * git work tree). Deployment mode (ADR-0004) is the caller's judgment, never
 * inferred here.
 */

import fs from "node:fs";
import path from "node:path";
import { mkdirSafe } from "./fsutil.js";
import { KindFolders } from "./place.js";
import { hasMarker } from "./vault.js";
import { VaultGit } from "./vaultgit.js";

/** The two deployment modes of ADR-0004. */
export const ModeQueryFromAnywhere = "query-from-anywhere";
export const ModeDedicated = "dedicated";

/** The accepted --mode values, for CLI help and validation. */
export const Modes = [ModeQueryFromAnywhere, ModeDedicated];

/** Session-tracker state is per-host and never committed; in dedicated mode the
 * project dir is the vault, so both hosts' state trees land here. */
export const gitignore =
  "*.rsls\n" +
  // `**/`-prefixed: a pattern containing `/` is anchored to the directory
  // holding the .gitignore, so the un-prefixed form would leave a nested state
  // tree untracked-but-committable.
  "**/.claude/wiki-knowledge/sessions/\n" +
  "**/.opencode/wiki-knowledge/sessions/\n" +
  // Search index (ADR-0006). Also add it to Resilio Sync's own ignore list: a
  // .gitignore doesn't propagate there, and a synced SQLite sidecar corrupts.
  ".wiki-knowledge/\n" +
  // LLM-wiki/Obsidian navigation scaffolding (log.md, index.md, _index.md) is
  // not knowledge, so a converted vault's initial commit skips it.
  "log.md\n" +
  "index.md\n" +
  "_index.md\n";

/** Whether root already looks like a vault — the gate [init] refuses on. A root
 * qualifies only with a marker (`wiki/` or `.wiki-root`) and a git work tree; a
 * marker without git still resolves as a vault root for reads. */
export async function isVault(root: string): Promise<boolean> {
  if (!hasMarker(root)) return false;
  return await new VaultGit(root).isWorkTree();
}

function settingsJSON(pluginRoot: string): string {
  const settings = {
    extraKnownMarketplaces: {
      "wiki-knowledge-plugin": {
        source: { source: "directory", path: pluginRoot },
      },
    },
    enabledPlugins: { "wiki-knowledge@wiki-knowledge-plugin": true },
  };
  return JSON.stringify(settings, null, 2) + "\n";
}

/** Scaffolds vaultRoot as a new vault and returns the resolved root. mode is
 * [ModeQueryFromAnywhere] (requires pluginRoot) or [ModeDedicated] (no
 * settings.json). */
export async function init(
  vaultRoot: string,
  mode: string,
  pluginRoot: string,
): Promise<string> {
  switch (mode) {
    case ModeQueryFromAnywhere:
      if (pluginRoot === "") {
        throw new Error(`${ModeQueryFromAnywhere} mode requires a plugin root`);
      }
      break;
    case ModeDedicated:
      break;
    default:
      throw new Error(
        `unknown mode "${mode}"; must be one of ${Modes.join(", ")}`,
      );
  }

  if (await isVault(vaultRoot)) {
    throw new Error(
      `${vaultRoot} already looks like a vault (a wiki/ or .wiki-root marker in a git work tree)`,
    );
  }

  mkdirSafe(vaultRoot, 0o755);

  // A pre-existing wiki/ tree means conversion: existing kind-folders are left
  // alone, missing ones are created with a .gitkeep.
  const converting = fs.existsSync(path.join(vaultRoot, "wiki"));
  for (const folder of Object.values(KindFolders)) {
    const kindDir = path.join(vaultRoot, "wiki", folder);
    if (fs.existsSync(kindDir)) continue;
    mkdirSafe(kindDir, 0o755);
    touch(path.join(kindDir, ".gitkeep"));
  }
  // raw/ is part of a fresh scaffold only; a conversion keeps no inbox.
  const rawDir = path.join(vaultRoot, "raw");
  if (!converting && !fs.existsSync(rawDir)) {
    mkdirSafe(rawDir, 0o755);
    touch(path.join(rawDir, ".gitkeep"));
  }

  fs.writeFileSync(path.join(vaultRoot, ".gitignore"), gitignore, {
    mode: 0o644,
  });

  // Stage only what exists: a conversion may lack raw/, and an existing raw/ is
  // swept into the initial commit.
  const addPaths: string[] = [];
  for (const rel of ["wiki", "raw", ".gitignore"]) {
    const abs = path.join(vaultRoot, ...rel.split("/"));
    if (fs.existsSync(abs)) addPaths.push(rel);
  }
  if (mode === ModeQueryFromAnywhere) {
    const claudeDir = path.join(vaultRoot, ".claude");
    mkdirSafe(claudeDir, 0o755);
    fs.writeFileSync(
      path.join(claudeDir, "settings.json"),
      settingsJSON(pluginRoot),
      {
        mode: 0o644,
      },
    );
    addPaths.push(".claude/settings.json");
  }

  const repo = new VaultGit(vaultRoot);
  if (!(await repo.isWorkTree())) {
    await repo.init();
  }
  await repo.add(addPaths);
  await repo.commit("Initialize wiki vault");

  return path.resolve(vaultRoot);
}

function touch(file: string): void {
  fs.closeSync(fs.openSync(file, "a", 0o644));
}
