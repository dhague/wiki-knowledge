/**
 * The one definition of what counts as a page.
 *
 * A page is markdown at exactly `wiki/<kind-folder>/<file>.md` — three path
 * segments directly under a kind-folder — and never the generated
 * `wiki/_index.md` nor a `KIND.md` kind-metadata file. The single predicate and
 * disk enumerator the disk walk, git walk, and index status count all delegate
 * to, so they cannot disagree.
 *
 * Deliberately a leaf module: it imports nothing from the rest of the codebase,
 * which is why `searchindex` can use it without the import cycle proxying back
 * through `vault` would create (ADR-0015).
 */

import fs from "node:fs";
import path from "node:path";

/** The generated `wiki/_index.md`; never a page. */
const GeneratedIndexRef = "wiki/_index.md";

/** `wiki/<kind>/KIND.md` is kind metadata, not a page; it matches the
 * three-segment shape, so exclude it explicitly. */
const KindMetaFilename = "KIND.md";

/** Whether a vault-relative path (ADR-0009) names a page — the rule in the
 * module doc. */
export function isPageRef(ref: string): boolean {
  if (ref === GeneratedIndexRef) return false;
  if (!ref.startsWith("wiki/")) return false;
  if (!ref.endsWith(".md")) return false;
  if (ref.split("/").length !== 3) return false;
  return ref.split("/")[2] !== KindMetaFilename;
}

/** Every page under the vault's `wiki/` tree at root as sorted vault-relative
 * refs (ADR-0009), each filtered through [isPageRef]. `raw/` is never walked,
 * and a vault with no `wiki/` yields none, not an error. */
export function enumeratePageRefs(root: string): string[] {
  const wikiDir = path.join(root, "wiki");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(wikiDir, { withFileTypes: true });
  } catch (err) {
    if (isENOENT(err)) return [];
    throw err;
  }
  const refs: string[] = [];
  const walk = (dir: string, dirEntries: fs.Dirent[]): void => {
    for (const entry of dirEntries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs, fs.readdirSync(abs, { withFileTypes: true }));
      } else if (entry.name.endsWith(".md")) {
        const rel = toSlash(path.relative(root, abs));
        if (isPageRef(rel)) refs.push(rel);
      }
    }
  };
  walk(wikiDir, entries);
  return refs.sort();
}

function toSlash(p: string): string {
  return p.split(path.sep).join("/");
}

function isENOENT(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}
