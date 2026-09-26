/**
 * The I/O half of the vault: where the vault is and what's inside it.
 *
 * [resolveRoot] answers "where is the vault" (ADR-0004); [Vault] owns every
 * read and write plus the cross-page link fixups; [Page] is pure, no I/O.
 */

import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { mkdirSafe } from "./fsutil.js";
import {
  Page,
  planConsolidate,
  planMove,
  splitFrontmatter,
} from "./wikipage.js";
import { loadRecords } from "./pagerecord.js";
import type { LoadRecordsOptions, PageRecord } from "./pagerecord.js";
import { FolderKinds, KindFolders, folderToKind } from "./place.js";
import { enumeratePageRefs } from "./pagepredicate.js";

/** The filenames that make a directory a vault root. */
export const Markers = ["wiki", ".wiki-root"] as const;

/** A lookupEnv matching `process.env`'s semantics: (value, wasPresent). */
export type LookupEnv = (key: string) => [string | undefined, boolean];

function processLookupEnv(key: string): [string | undefined, boolean] {
  const value = process.env[key];
  return [value, value !== undefined];
}

/** Whether dir itself carries a vault marker. */
export function hasMarker(dir: string): boolean {
  for (const marker of Markers) {
    try {
      fs.statSync(path.join(dir, marker));
      return true;
    } catch {
      // keep walking up
    }
  }
  return false;
}

/**
 * Resolve the vault root (ADR-0004): `$WIKI_ROOT` if set and non-empty, else
 * the nearest ancestor of `start` carrying a marker, else `start` itself.
 *
 * `start` defaults to cwd; both parameters are injectable for tests.
 */
export function resolveRoot(
  start = "",
  lookupEnv: LookupEnv = processLookupEnv,
): { root: string } {
  const [wikiRoot, ok] = lookupEnv("WIKI_ROOT");
  if (ok && wikiRoot !== "" && wikiRoot !== undefined) {
    return { root: resolve(wikiRoot) };
  }

  const startPath = resolve(start === "" ? process.cwd() : start);

  for (let dir = startPath; ;) {
    if (hasMarker(dir)) return { root: dir };
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { root: startPath };
}

/** Absolute path with symlinks followed; a path that doesn't exist yet still
 * resolves (init scaffolds one that doesn't). */
function resolve(p: string): string {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync(abs);
  } catch {
    return abs;
  }
}

function isENOENT(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}

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

/** The kind value [Index] stores for a folder: canonical folders resolve from
 * [FolderKinds], custom ones strip a trailing `s`. The index ignores a declared
 * kind, so the scope rule must speak its vocabulary. */
function indexedKind(folder: string): string {
  return FolderKinds[folder] ?? folderToKind(folder);
}

/** ADR-0027's scope rule, on the kind the index stores: `concept` always,
 * `entity`/`source` never — their identity forbids consolidation (ADR-0021) —
 * and every other kind exactly as `declared`. */
function isConsolidatableKind(indexKind: string, declared: boolean): boolean {
  if (indexKind === "concept") return true;
  if (indexKind === "entity" || indexKind === "source") return false;
  return declared;
}

/** A decoded record paired with the page text it was decoded from. */
export interface PageWithText {
  record: PageRecord;
  text: string;
}

/**
 * Vault I/O and cross-page operations over the pages at root.
 *
 * Root is an absolute path; every page ref taken or returned is vault-relative
 * with `/` separators (ADR-0009), so a ref passes straight to another method or
 * into an ingest plan.
 */
export class Vault {
  constructor(readonly root: string) {}

  /** Singular kind-folders left over from before ADR-0008, sorted —
   * `wiki/concept/` where the vault should hold `wiki/concepts/`.
   *
   * The migration script that used to fix these is gone, but the check stays:
   * [place.path] resolves canonical kinds from [KindFolders], so an unmigrated
   * vault would split one kind across two spellings. A writer refuses instead. */
  legacyKindFolders(): string[] {
    const legacy: string[] = [];
    for (const folder of this.wikiSubdirectories()) {
      // Legacy means the singular of a canonical kind but not itself canonical
      // — `concept` yes, `synthesis` no (folder and kind are the same word).
      if (FolderKinds[folder] !== undefined) continue;
      const canonical = KindFolders[folder];
      if (canonical !== undefined && canonical !== folder) legacy.push(folder);
    }
    return legacy;
  }

  /** The `wiki/` subdirectory names, sorted; empty when there is no `wiki/`. */
  private wikiSubdirectories(): string[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(this.root, "wiki"), {
        withFileTypes: true,
      });
    } catch (err) {
      if (isENOENT(err)) return [];
      throw err;
    }
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  }

  /** The absolute filesystem path for a vault-relative page ref. */
  path(pageRef: string): string {
    return path.join(this.root, ...pageRef.split("/"));
  }

  /** Read the page at pageRef (vault-relative) into a [Page]. */
  load(pageRef: string): Page {
    return new Page(fs.readFileSync(this.path(pageRef), "utf8"));
  }

  /** Whether pageRef names an existing *file*; a directory at that path is not
   * a page, so this is false. */
  exists(pageRef: string): boolean {
    try {
      return !fs.statSync(this.path(pageRef)).isDirectory();
    } catch {
      return false;
    }
  }

  /** Report whether anything at all sits at pageRef, directory included. */
  occupied(pageRef: string): boolean {
    try {
      fs.statSync(this.path(pageRef));
      return true;
    } catch {
      return false;
    }
  }

  /** Write page to pageRef (vault-relative), creating parent directories as
   * needed. */
  write(pageRef: string, page: Page): void {
    const abs = this.path(pageRef);
    mkdirSafe(path.dirname(abs), 0o755);
    fs.writeFileSync(abs, page.text, { mode: 0o644 });
  }

  /** Return `{kind: folder}` for every `wiki/` subdirectory that is not already
   * a canonical kind-folder. The folder must pre-exist — the plugin never
   * auto-creates custom kind-folders. */
  discoveredKinds(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const folder of this.wikiSubdirectories()) {
      if (FolderKinds[folder] !== undefined) continue;
      const meta = readKindMeta(path.join(this.root, "wiki", folder));
      out[meta?.kind ?? folderToKind(folder)] = folder;
    }
    return out;
  }

  /** Whether the kind-folder `folder` is consolidatable (ADR-0027), reading its
   * `KIND.md` declaration from the working tree. */
  isConsolidatable(folder: string): boolean {
    const declared =
      readKindMeta(path.join(this.root, "wiki", folder))?.consolidatable ??
      false;
    return isConsolidatableKind(indexedKind(folder), declared);
  }

  /** The kind values `concept-fragmentation` scores, in [Index]'s vocabulary:
   * `concept` plus every folder whose `KIND.md` declares `consolidatable: true`
   * (ADR-0027). Read from the working tree, where `KIND.md` lives — the members
   * scored stay a view of HEAD (ADR-0015). */
  consolidatableKinds(): string[] {
    const kinds = new Set<string>(["concept"]);
    for (const folder of this.wikiSubdirectories()) {
      if (this.isConsolidatable(folder)) kinds.add(indexedKind(folder));
    }
    return [...kinds].sort();
  }

  /** Every `wiki/**` page as a {pageRef: text} map. Never walks `raw/`. */
  loadWikiPages(): Record<string, string> {
    const refs = enumeratePageRefs(this.root);
    const pages: Record<string, string> = {};
    for (const ref of refs)
      pages[ref] = fs.readFileSync(this.path(ref), "utf8");
    return pages;
  }

  /** Every `wiki/**` page as a {pageRef: record + text} map. `opts` per
   * [LoadRecordsOptions] — a tolerant check run sets `skipMalformedEdges`. */
  pagesWithText(opts: LoadRecordsOptions = {}): Record<string, PageWithText> {
    const pages = this.loadWikiPages();
    const discovered = this.discoveredKinds(); // {kind: folder}
    const kindByFolder: Record<string, string> = {};
    for (const [kind, folder] of Object.entries(discovered)) {
      kindByFolder[folder] = kind;
    }
    const records = loadRecords(pages, kindByFolder, opts);
    const out: Record<string, PageWithText> = {};
    for (const ref of Object.keys(records)) {
      out[ref] = { record: records[ref], text: pages[ref] };
    }
    return out;
  }

  /** Every `wiki/**` page as a {pageRef: record} map; `raw/` is never walked.
   * Options pass through to [pagesWithText]. */
  pages(opts: LoadRecordsOptions = {}): Record<string, PageRecord> {
    const withText = this.pagesWithText(opts);
    const out: Record<string, PageRecord> = {};
    for (const ref of Object.keys(withText)) out[ref] = withText[ref].record;
    return out;
  }

  /** Load, [Page.set], and write back the page at pageRef. */
  set(pageRef: string, key: string, value: unknown): Page {
    const page = this.load(pageRef);
    const updated = page.set(key, value);
    this.write(pageRef, updated);
    return updated;
  }

  /** Load, [Page.merge], and write back the page at pageRef. */
  merge(pageRef: string, key: string, values: unknown[]): Page {
    const page = this.load(pageRef);
    const updated = page.merge(key, values);
    this.write(pageRef, updated);
    return updated;
  }

  /** Write every page in planned whose text differs from before, returning the
   * changed vault-relative paths, sorted. */
  private writeChanged(
    planned: Record<string, string>,
    before: Record<string, string>,
  ): string[] {
    const changed: string[] = [];
    for (const [pageRef, text] of Object.entries(planned)) {
      // Absent from before always means written, even when the text is empty:
      // "unchanged" is the file already holding this text, not falsy text.
      const prev = before[pageRef];
      if (prev !== undefined && text === prev) continue;
      this.write(pageRef, new Page(text));
      changed.push(pageRef);
    }
    return changed.sort();
  }

  /** Move a page and fix every inbound and outbound link.
   *
   * Reads every `wiki/**` page (never `raw/`), writes back only the pages whose
   * text changed, then removes the original. Returns the changed refs, sorted;
   * empty for oldRef == newRef. */
  movePage(oldRef: string, newRef: string): string[] {
    const files = this.loadWikiPages();
    if (!(oldRef in files)) {
      throw new Error(`${oldRef} not found under ${this.root}`);
    }

    // planMove keys the moved page under newRef, so writing every changed page
    // also lays the moved file down; only the original is left to drop.
    const changed = this.writeChanged(planMove(files, oldRef, newRef), files);
    if (this.path(oldRef) !== this.path(newRef)) {
      fs.unlinkSync(this.path(oldRef));
    }
    return changed;
  }

  /** Repoint `wiki/**` pages' inbound links from oldRel to newRel.
   *
   * The target itself is never read, parsed, or written — for a non-page target
   * such as an externally renamed `raw/` artifact, only other pages change.
   * Returns the changed refs, sorted. */
  rewriteInboundLinks(oldRel: string, newRel: string): string[] {
    const pages = this.loadWikiPages();
    return this.writeChanged(planMove(pages, oldRel, newRel), pages);
  }

  /** Absorb losers into the survivor (ADR-0021), repointing inbound links.
   *
   * Writes before it deletes, deliberately: an interrupted run has already laid
   * the absorbed content down, so only the deletes can be half-done. The
   * survivor need not already exist. Returns the changed refs, sorted. */
  consolidate(survivorRef: string, survivor: Page, losers: string[]): string[] {
    const files = this.loadWikiPages();
    const planned = planConsolidate(
      { ...files, [survivorRef]: survivor.text },
      losers,
      survivorRef,
    );
    const changed = this.writeChanged(planned, files);
    for (const ref of losers) this.remove(ref);
    return changed;
  }

  /** Delete the page at pageRef. Idempotent — an already-gone page is not an
   * error, so an interrupted Consolidation can be re-run. Every other failure
   * throws. */
  remove(pageRef: string): void {
    try {
      fs.unlinkSync(this.path(pageRef));
    } catch (err) {
      if (!isENOENT(err)) throw err;
    }
  }
}

/**
 * The vault a **file** lives in and that file's vault-relative directory.
 *
 * Not [resolveRoot]'s question: `$WIKI_ROOT` pointing at another vault must not
 * redirect an edit handed an explicit path, so the file's own nearest-ancestor
 * marker wins and cwd never enters it.
 */
export function vaultForFile(file: string): { vault: Vault; pageDir: string } {
  // [resolveRoot] realpaths the root it finds, so realpath the file too or
  // `path.relative` mismatches across a symlink (/tmp on macOS being the
  // everyday case). The fallback covers a path realpath refuses.
  let abs: string;
  try {
    abs = fs.realpathSync(path.resolve(file));
  } catch {
    abs = path.resolve(file);
  }
  const { root } = resolveRoot(path.dirname(abs), () => [undefined, false]);
  const rel = path.relative(root, abs).split(path.sep).join("/");
  const dir = path.posix.dirname(rel);
  return { vault: new Vault(root), pageDir: dir === "." ? "" : dir };
}
