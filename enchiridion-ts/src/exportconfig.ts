/**
 * The vault config file and the one place the wiki title is resolved.
 *
 * `.wiki-knowledge/config.json` sits beside the search index at the vault
 * root — same directory, same gitignored status, same character: local state
 * the plugin owns, absent until something writes it. Its absence is never an
 * error; neither is a file someone broke by hand, which degrades to the same
 * place an absent one does.
 *
 * The title resolves in exactly one function, `resolveExportTitle`: flag →
 * config → vault root directory name. Callers hand it what they were given
 * and take what comes back; nothing downstream of it re-derives a title from
 * a different input.
 */

import fs from "node:fs";
import path from "node:path";

/**
 * The vault config as read. Only `title` is interpreted today; the index
 * signature lets other keys ride along untouched through a read-modify-write
 * rather than being dropped by a save that only knows about one.
 */
export interface ExportConfig {
  /** Wiki title shown in the exported site's nav bar and front page heading. */
  title?: string;
  [key: string]: unknown;
}

/** Absolute path of the vault config file for `root` — `.wiki-knowledge/`
 *  at the vault root, the directory the search index and lock files use. */
export function exportConfigPath(root: string): string {
  return path.join(root, ".wiki-knowledge", "config.json");
}

/**
 * Read the vault config. An absent, unreadable, malformed, or non-object file
 * reads as an empty config — the caller sees "nothing configured" in every one
 * of those cases, and none of them is an error. A non-string `title` is
 * dropped for the same reason: a hand-written `{"title": 42}` means the same
 * as no title, and rendering whatever a wrong-typed value stringifies to would
 * be worse than the fallback.
 */
export function readExportConfig(root: string): ExportConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(exportConfigPath(root), "utf8");
  } catch {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }

  const config = parsed as ExportConfig;
  if (config.title !== undefined && typeof config.title !== "string") {
    delete config.title;
  }
  return config;
}

/** Write the vault config, creating `.wiki-knowledge/` if it isn't there. */
export function writeExportConfig(root: string, config: ExportConfig): void {
  fs.mkdirSync(path.dirname(exportConfigPath(root)), { recursive: true });
  fs.writeFileSync(
    exportConfigPath(root),
    JSON.stringify(config, null, 2) + "\n",
    "utf8",
  );
}

/**
 * Persist the wiki title, preserving whatever else the file holds. A blank
 * title is refused rather than written: "no title" is spelled by not having
 * one, and a stored blank would silently read as unset by every consumer.
 */
export function saveExportTitle(root: string, title: string): void {
  if (title.trim() === "") {
    throw new Error("a wiki title must not be empty");
  }
  writeExportConfig(root, { ...readExportConfig(root), title: title.trim() });
}

/**
 * The wiki title, resolved in the one place it is decided:
 *
 *   1. `flagTitle` — a per-run override, this run only;
 *   2. `title` in the vault config — the persistent default;
 *   3. the vault root's directory name — the one thing a vault calls itself
 *      without being told.
 *
 * A blank value at either of the first two levels means "not supplied" and
 * falls through, so an empty flag can't blank out the nav bar.
 */
export function resolveExportTitle(root: string, flagTitle?: string): string {
  const fromFlag = flagTitle?.trim();
  if (fromFlag) return fromFlag;

  const fromConfig = readExportConfig(root).title?.trim();
  if (fromConfig) return fromConfig;

  return path.basename(path.resolve(root));
}
