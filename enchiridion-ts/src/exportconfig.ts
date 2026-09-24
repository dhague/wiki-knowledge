/**
 * The vault config file and the one place each export-wide setting is
 * resolved.
 *
 * `.wiki-knowledge/config.json` sits beside the search index at the vault
 * root — same directory, same gitignored status, same character: local state
 * the plugin owns, absent until something writes it. Its absence is never an
 * error; neither is a file someone broke by hand, which degrades to the same
 * place an absent one does.
 *
 * Each setting resolves in exactly one function: the wiki title through
 * `resolveExportTitle` (flag → config → vault root directory name), the start
 * page through `resolveExportStartPage` (flag → config → none). Callers hand
 * them what they were given and take what comes back; nothing downstream
 * re-derives a value from a different input.
 *
 * One deliberate asymmetry between them: a well-formed saved value that the
 * export cannot carry is a title's cosmetic miss but a start page's hard
 * error. Falling back to the generated front page would silently undo the
 * setting, which is the bug the setting exists to prevent, so the caller is
 * told to re-save or clear it (see `runExport`).
 */

import fs from "node:fs";
import path from "node:path";

/**
 * The vault config as read. Only `title` and `startPage` are interpreted
 * today; the index signature lets other keys ride along untouched through a
 * read-modify-write rather than being dropped by a save that only knows about
 * one.
 */
export interface ExportConfig {
  /** Wiki title shown in the exported site's nav bar and front page heading. */
  title?: string;
  /**
   * The vault's standing start page: the vault-relative ref of the page the
   * export promotes to the front page when no `--start-page` flag overrides it.
   */
  startPage?: string;
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
 * of those cases, and none of them is an error. A non-string `title` or
 * `startPage` is dropped for the same reason: a hand-written `{"title": 42}`
 * means the same as no title, and rendering whatever a wrong-typed value
 * stringifies to would be worse than the fallback.
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
  if (config.startPage !== undefined && typeof config.startPage !== "string") {
    delete config.startPage;
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
 * Whether a supplied flag or saved value counts as *provided*. A blank value
 * means "not supplied" and falls through to the next level, at every level of
 * every resolution order here — an empty `--title` cannot blank out the nav
 * bar, and an empty `--start-page` cannot blank out a saved one. Exported so
 * the one caller that has to ask the question about a flag *after* resolving it
 * (the start page's error message names its source) spells the rule the same
 * way the resolvers do.
 */
export function isSupplied(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== "";
}

/**
 * Persist the wiki title, preserving whatever else the file holds. A blank
 * title is refused rather than written: "no title" is spelled by not having
 * one, and a stored blank would silently read as unset by every consumer.
 */
export function saveExportTitle(root: string, title: string): void {
  if (!isSupplied(title)) {
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
  if (isSupplied(flagTitle)) return flagTitle.trim();

  const fromConfig = readExportConfig(root).title;
  if (isSupplied(fromConfig)) return fromConfig.trim();

  return path.basename(path.resolve(root));
}

// ---------------------------------------------------------------------------
// Start page
// ---------------------------------------------------------------------------

/**
 * A start page ref as the export spells it: no leading `./`, and a `.md`
 * extension when the caller left one off. Applied to both the flag and the
 * saved value, so a hand-edited config and a typed flag reach the export in
 * the same shape — there is one spelling of a page ref, and this is it.
 */
export function normalizeStartPageRef(ref: string): string {
  let normalized = ref.trim();
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  if (normalized !== "" && !normalized.endsWith(".md")) normalized += ".md";
  return normalized;
}

/**
 * The start page, resolved in the one place it is decided:
 *
 *   1. `flagStartPage` — a per-run override, this run only;
 *   2. `startPage` in the vault config — the vault's standing choice;
 *   3. nothing — the export keeps its generated front page.
 *
 * A blank value at either level means "not supplied" and falls through, so a
 * blank flag cannot blank out a saved start page — and so does a value that
 * normalises away (a bare `./`), which would otherwise resolve to a ref no
 * export could carry.
 *
 * This deliberately does *not* check that the ref is a page of the vault, or
 * that the export carries it: the first is the save path's business (it has the
 * vault enumeration), the second depends on `--raw` and belongs to export time
 * (it has the exported set).
 */
export function resolveExportStartPage(
  root: string,
  flagStartPage?: string,
): string | undefined {
  // Flag first, then the saved value; either level falls through when it is
  // blank or normalises away.
  for (const candidate of [flagStartPage, readExportConfig(root).startPage]) {
    if (!isSupplied(candidate)) continue;
    const ref = normalizeStartPageRef(candidate);
    if (ref !== "") return ref;
  }
  return undefined;
}

/**
 * Persist the vault's standing start page, preserving whatever else the file
 * holds. A blank ref **clears the key** rather than being refused — unlike
 * `saveExportTitle`, and deliberately: "no start page" is a state an operator
 * returns to (the generated front page), while "no title" has no such reading.
 *
 * The caller validates that the ref names a page of the vault before calling;
 * this helper only knows the file.
 */
export function saveExportStartPage(root: string, ref: string): void {
  const config = readExportConfig(root);
  const normalized = normalizeStartPageRef(ref);
  if (normalized === "") {
    delete config.startPage;
  } else {
    config.startPage = normalized;
  }
  writeExportConfig(root, config);
}
