/**
 * The `wiki/<kind>/KIND.md` declaration reader and the one folder → kind ladder
 * every read path shares (ADR-0020): canonical folders from `FolderKinds`, a
 * custom folder from its declaration, else strip-`s`.
 */

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { splitFrontmatter } from "./wikipage.js";
import { FolderKinds, folderToKind } from "./place.js";

/** A `KIND.md` declaration: the kind value a folder declares (`null` when only
 * other keys are present), its summary, and whether its pages consolidate. */
export interface KindMeta {
  kind: string | null;
  summary: string;
  consolidatable: boolean;
}

/** Parse a `KIND.md` document's text; `null` when it has no frontmatter or a
 * non-mapping one. Parseable frontmatter missing `kind:` still returns a
 * [KindMeta], so a declaration carrying the flag alone is not dropped. */
export function parseKindMeta(text: string): KindMeta | null {
  try {
    const { frontmatter, hasFrontmatter } = splitFrontmatter(text);
    if (!hasFrontmatter || frontmatter === "") return null;
    const data = parseYaml(frontmatter) as unknown;
    if (data === null || typeof data !== "object" || Array.isArray(data))
      return null;
    const map = data as Record<string, unknown>;
    const kind = typeof map["kind"] === "string" ? map["kind"].trim() : "";
    const summary = typeof map["summary"] === "string" ? map["summary"] : "";
    return {
      kind: kind === "" ? null : kind,
      summary,
      consolidatable: map["consolidatable"] === true,
    };
  } catch {
    return null;
  }
}

/** Reads the `KIND.md` declaration in an absolute folder path; `null` as
 * [parseKindMeta] defines it. */
export function readKindMeta(folderAbsPath: string): KindMeta | null {
  let text: string;
  try {
    text = fs.readFileSync(path.join(folderAbsPath, "KIND.md"), "utf8");
  } catch {
    return null;
  }
  return parseKindMeta(text);
}

/** The folder → kind ladder (ADR-0020): a canonical folder wins whatever its
 * `KIND.md` says, else the declared kind, else strip-`s`. */
export function resolveKind(
  folder: string,
  declaredKind?: string | null,
): string {
  return FolderKinds[folder] ?? declaredKind ?? folderToKind(folder);
}

/** The kind value a folder's pages carry, its declaration read from disk. */
export function kindForFolder(root: string, folder: string): string {
  return resolveKind(
    folder,
    readKindMeta(path.join(root, "wiki", folder))?.kind,
  );
}

/** folder → kind for every `wiki/` subdirectory, folder-keyed so two folders
 * declaring one kind stay distinct. */
export function kindByFolder(root: string): Record<string, string> {
  const wikiDir = path.join(root, "wiki");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(wikiDir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  const out: Record<string, string> = {};
  for (const entry of entries) {
    if (entry.isDirectory()) out[entry.name] = kindForFolder(root, entry.name);
  }
  return out;
}
