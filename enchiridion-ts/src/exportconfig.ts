/**
 * The vault config file (`.wiki-knowledge/config.json`) and the one place each
 * export-wide setting is resolved.
 *
 * Each setting resolves in exactly one function — title: flag → config → vault
 * root directory name; start page: flag → config → none. An absent or malformed
 * file, and a blank value, are never errors; they fall through to the next level.
 *
 * Deliberate asymmetry: a saved value the export cannot carry is a title's
 * cosmetic miss but a start page's hard error — falling back to the generated
 * front page would silently undo the setting (see runExport).
 */

import fs from "node:fs";
import path from "node:path";

/**
 * The vault config as read. `title` and `startPage` are the only keys
 * interpreted; the index signature lets other keys ride along untouched through
 * a read-modify-write rather than being dropped by a save that only knows one.
 */
export interface ExportConfig {
  /** Wiki title shown in the exported site's nav bar and front page heading. */
  title?: string;
  /** The vault-relative ref promoted to the front page when no flag overrides it. */
  startPage?: string;
  [key: string]: unknown;
}

/** Absolute path of the vault config file for `root`. */
export function exportConfigPath(root: string): string {
  return path.join(root, ".wiki-knowledge", "config.json");
}

/** Read the vault config: absent, unreadable, malformed, non-object, or
 *  wrong-typed values all read as absent, and none is an error. */
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

/** Whether a supplied flag or saved value counts as *provided*: blank means not
 *  supplied and falls through. Exported because the start page's error message
 *  names its source after resolving it. */
export function isSupplied(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== "";
}

/** Persist the title, preserving whatever else the file holds. A blank title is
 *  refused: "no title" is spelled by not having one. */
export function saveExportTitle(root: string, title: string): void {
  if (!isSupplied(title)) {
    throw new Error("a wiki title must not be empty");
  }
  writeExportConfig(root, { ...readExportConfig(root), title: title.trim() });
}

/** The one place the title is decided: flag → config → vault root directory
 *  name. A blank value falls through at each level. */
export function resolveExportTitle(root: string, flagTitle?: string): string {
  if (isSupplied(flagTitle)) return flagTitle.trim();

  const fromConfig = readExportConfig(root).title;
  if (isSupplied(fromConfig)) return fromConfig.trim();

  return path.basename(path.resolve(root));
}

// ---------------------------------------------------------------------------
// Start page
// ---------------------------------------------------------------------------

/** A start page ref as the export spells it: no leading `./`, and `.md`
 *  appended when absent. Applied to both the flag and the saved value. */
export function normalizeStartPageRef(ref: string): string {
  let normalized = ref.trim();
  while (normalized.startsWith("./")) normalized = normalized.slice(2);
  if (normalized !== "" && !normalized.endsWith(".md")) normalized += ".md";
  return normalized;
}

/** The one place the start page is decided: flag → saved ref → none. A blank
 *  value, or one that normalises away, falls through.
 *
 *  Deliberately does not check the ref is a page of the vault or that the export
 *  carries it: save time owns vault membership, export time owns `--raw`. */
export function resolveExportStartPage(
  root: string,
  flagStartPage?: string,
): string | undefined {
  for (const candidate of [flagStartPage, readExportConfig(root).startPage]) {
    if (!isSupplied(candidate)) continue;
    const ref = normalizeStartPageRef(candidate);
    if (ref !== "") return ref;
  }
  return undefined;
}

/** Persist the vault's standing start page. A blank ref clears the key rather
 *  than being refused — "no start page" is a state an operator returns to.
 *  Caller validates the ref against the vault. */
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
