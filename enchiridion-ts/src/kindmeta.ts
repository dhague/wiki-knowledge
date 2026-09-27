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

/**
 * Reads the `KIND.md` declaration in an absolute folder path.
 *
 * `null` only when the file is absent or unparseable (no frontmatter,
 * non-mapping YAML); parseable frontmatter missing `kind:` still returns a
 * [KindMeta], so a `KIND.md` carrying the flag alone is not dropped. Callers
 * fall back to [folderToKind] for a null `kind`.
 */
export function readKindMeta(folderAbsPath: string): KindMeta | null {
  let text: string;
  try {
    text = fs.readFileSync(path.join(folderAbsPath, "KIND.md"), "utf8");
  } catch {
    return null;
  }
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

/** The kind value a folder's pages carry (ADR-0020): [FolderKinds] wins for a
 * canonical folder, so a stray `KIND.md` there never declares it. */
export function kindForFolder(root: string, folder: string): string {
  return (
    FolderKinds[folder] ??
    readKindMeta(path.join(root, "wiki", folder))?.kind ??
    folderToKind(folder)
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
