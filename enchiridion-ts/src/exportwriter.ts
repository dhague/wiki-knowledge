import fs from "node:fs";
import path from "node:path";
import { Vault } from "./vault.js";
import { VaultGit } from "./vaultgit.js";
import {
  buildExportMeta,
  droppedStarters,
  type ExportOptions,
  type StarterEntry,
} from "./exportmeta.js";
import { renderPages } from "./exportrender.js";
import { renderAggregatePages } from "./exportaggregate.js";
import {
  renderSingleFile,
  singleFileRawAssetWarning,
  singleFileSizeWarning,
} from "./exportsingle.js";
import {
  isSupplied,
  resolveExportStartPage,
  resolveExportTitle,
} from "./exportconfig.js";
import {
  EXPORT_STYLESHEET,
  STYLESHEET_DIR,
  STYLESHEET_FILE,
} from "./exportstyle.js";
import type { PageRecord } from "./pagerecord.js";
import { emitDiagnostic } from "./output.js";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface ExportWriterOptions {
  /**
   * Absolute path of what to write: an output directory, or under `singleFile`
   * the output file itself. The caller resolves the default — it knows the mode.
   */
  out: string;
  /** Include raw/ pages. Default false. */
  raw?: boolean;
  /** Write the whole site as one self-contained HTML file at `out`. Default false. */
  singleFile?: boolean;
  /** Overwrite a non-empty output directory without error. Default false; a
   *  single file is replaced in place either way. */
  force?: boolean;
  /** Skip the dirty-tree check. Default false. */
  allowDirty?: boolean;
  /** Supplied starters override fallback ranking on the front page. */
  starters?: StarterEntry[];
  /** Wiki title for this run only; unset takes the vault's saved title, then
   *  the vault root directory name (see resolveExportTitle). */
  title?: string;
  /** Start page for this run only; unset takes the vault's saved start page,
   *  or failing that none (see resolveExportStartPage). */
  startPage?: string;
}

export class ExportDirtyError extends Error {
  constructor(
    message: string,
    public readonly dirtyFiles: string[],
  ) {
    super(message);
    this.name = "ExportDirtyError";
  }
}

export class ExportTargetNotEmptyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportTargetNotEmptyError";
  }
}

/** `--single-file` was pointed at an existing directory. Its own error rather
 *  than a rename failing with EISDIR, which names the syscall, not the mistake. */
export class ExportTargetIsDirectoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportTargetIsDirectoryError";
  }
}

/** The resolved start page is not a page this export carries. Deliberately
 *  fatal rather than falling back to the generated front page: that fallback is
 *  the silent behaviour the setting exists to replace. See ADR-0023. */
export class ExportStartPageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportStartPageError";
  }
}

/** A raw asset and a rendered raw page would write the same site path, so one
 *  would silently clobber the other. */
export class ExportRawCollisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportRawCollisionError";
  }
}

// ---------------------------------------------------------------------------
// Raw page enumeration
// ---------------------------------------------------------------------------

/** All non-dotfile files under `raw/`; empty when absent. A dotfile or hidden
 *  directory (`.gitkeep`, `.DS_Store`, `.obsidian/`) is a folder artifact, not a
 *  source, so it is skipped. */
function enumerateRawRefs(root: string): string[] {
  const rawDir = path.join(root, "raw");
  const refs: string[] = [];
  function walk(dir: string): void {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else {
        const rel = path.relative(root, abs).split(path.sep).join("/");
        refs.push(rel);
      }
    }
  }
  walk(rawDir);
  return refs.sort();
}

/** A raw/ file is a page when it is markdown; every other file is an asset
 *  copied verbatim. */
function isRawPage(ref: string): boolean {
  return ref.endsWith(".md");
}

/** Every page ref the vault holds — every `wiki/` page plus every markdown file
 *  under `raw/`. A raw asset is not a page. Save-time validation uses this, not
 *  the export's `--raw`-filtered set. */
export function vaultPageRefs(root: string): Set<string> {
  const refs = new Set<string>(Object.keys(new Vault(root).pagesWithText()));
  for (const ref of enumerateRawRefs(root)) {
    if (isRawPage(ref)) refs.add(ref);
  }
  return refs;
}

/** Names the source of the refused ref, and for a `raw/` page without `--raw`
 *  the flag that would make it legal. The two sources get different advice
 *  because only the flag can be fixed by re-running the same command. */
function startPageErrorMessage(
  root: string,
  ref: string,
  fromFlag: boolean,
  includeRaw: boolean,
): string {
  const source = fromFlag
    ? `--start-page "${ref}"`
    : `the saved start page "${ref}" (${path.join(".wiki-knowledge", "config.json")})`;

  if (
    !includeRaw &&
    ref.startsWith("raw/") &&
    isRawPage(ref) &&
    fs.existsSync(path.join(root, ...ref.split("/")))
  ) {
    return `${source} is a raw/ page, which this run does not include. Pass --raw to include raw/ pages, or nominate a wiki/ page.`;
  }

  if (fromFlag) {
    return `${source} does not name a page in this export. Check the ref, or drop --start-page to use the generated front page.`;
  }
  return `${source} does not name a page in this export. Re-save a different page with --save-start-page, clear it with a blank --save-start-page, or pass --raw if the page is a raw/ markdown file.`;
}

// ---------------------------------------------------------------------------
// Temp-dir write → atomic rename
// ---------------------------------------------------------------------------

/** Write one output file at a site-relative path, creating directories. */
function writeFileIn(tempDir: string, relPath: string, content: string): void {
  const abs = path.join(tempDir, ...relPath.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
}

/** Copy one raw asset byte-for-byte to its vault-relative site path. A failure
 *  names the ref before the host's own detail (ADR-0032). */
function copyRawAssetIn(tempDir: string, root: string, ref: string): void {
  const abs = path.join(tempDir, ...ref.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  try {
    fs.copyFileSync(path.join(root, ...ref.split("/")), abs);
  } catch (err) {
    throw new Error(
      `raw asset "${ref}" could not be copied into the export: ${(err as Error).message}`,
      { cause: err },
    );
  }
}

function writeTempSite(
  tempDir: string,
  pages: IterableIterator<{ path: string; content: string }>,
): void {
  for (const { path: relPath, content } of pages) {
    writeFileIn(tempDir, relPath, content);
  }
}

/**
 * Write through a temp file on the same filesystem and an atomic rename. The
 * existing output is replaced outright: the target *is* the export, so
 * re-running to refresh it is the normal case and needs no `--force`.
 */
function writeSingleFile(outFile: string, html: string): void {
  const tempFile = path.join(
    path.dirname(outFile),
    `.export-tmp-${path.basename(outFile)}-${process.pid}`,
  );
  try {
    fs.writeFileSync(tempFile, html, "utf8");
    fs.renameSync(tempFile, outFile);
  } catch (err) {
    try {
      fs.rmSync(tempFile, { force: true });
    } catch {
      // best-effort cleanup
    }
    throw err;
  }

  const warning = singleFileSizeWarning(fs.statSync(outFile).size, outFile);
  if (warning) emitDiagnostic(warning);
}

// ---------------------------------------------------------------------------
// Main export runner
// ---------------------------------------------------------------------------

/**
 * Run the full export: dirty check → page load → render → write. All writes
 * land in a temp path on the same filesystem as `opts.out` and are atomically
 * renamed into place only after they all succeed; `opts.out` is removed only
 * after the temp build completes.
 */
export async function runExport(
  root: string,
  opts: ExportWriterOptions,
): Promise<void> {
  const outDir = opts.out;
  const includeRaw = opts.raw ?? false;
  const singleFile = opts.singleFile ?? false;
  const allowDirty = opts.allowDirty ?? false;
  const force = opts.force ?? false;
  const starters = opts.starters ?? [];
  // The one place a vault-derived wiki title is resolved: flag → config →
  // directory name. Everything downstream reads the result, never the inputs.
  const title = resolveExportTitle(root, opts.title);
  // The one place the start page is resolved: flag → saved ref → none.
  const startPageRef = resolveExportStartPage(root, opts.startPage);
  const startPageFromFlag = isSupplied(opts.startPage);

  // 1. Dirty-tree check. The git fact comes from vaultgit, which owns every git
  // question about a vault.
  if (!allowDirty) {
    const subtrees = ["wiki"];
    if (includeRaw) subtrees.push("raw");
    const dirty = await new VaultGit(root).dirtyFiles(subtrees);
    if (dirty.length > 0) {
      throw new ExportDirtyError(
        `Exported subtree has uncommitted changes (${dirty.length} file${dirty.length === 1 ? "" : "s"}). ` +
          `Commit or stash them, or pass --allow-dirty to skip this check.\n  ` +
          dirty.slice(0, 10).join("\n  ") +
          (dirty.length > 10 ? `\n  … and ${dirty.length - 10} more` : ""),
        dirty,
      );
    }
  }

  // 2. Check the target: a single file is replaced without ceremony, a
  // directory tree only under --force.
  if (singleFile) {
    if (fs.existsSync(outDir) && fs.statSync(outDir).isDirectory()) {
      throw new ExportTargetIsDirectoryError(
        `Output "${outDir}" is a directory, and --single-file writes one file. ` +
          `Pass --out <file>, or drop --single-file to write a directory tree.`,
      );
    }
  } else if (!force && fs.existsSync(outDir)) {
    let hasContents = false;
    try {
      const entries = fs.readdirSync(outDir);
      hasContents = entries.length > 0;
    } catch {
      // Non-directory or inaccessible — let the rename fail naturally
    }
    if (hasContents) {
      throw new ExportTargetNotEmptyError(
        `Output directory "${outDir}" is not empty. Use --force to overwrite.`,
      );
    }
  }

  const vault = new Vault(root);
  const pagesMap = new Map<string, { record?: PageRecord; text: string }>();
  const copiedRawRefs: string[] = [];

  const wikiWithText = vault.pagesWithText();
  for (const [ref, { record, text }] of Object.entries(wikiWithText)) {
    pagesMap.set(ref, { record, text });
  }

  if (includeRaw) {
    for (const ref of enumerateRawRefs(root)) {
      // Non-markdown is copied, never decoded: a UTF-8 read corrupts the bytes.
      if (!isRawPage(ref)) {
        copiedRawRefs.push(ref);
        continue;
      }
      try {
        const text = fs.readFileSync(
          path.join(root, ...ref.split("/")),
          "utf8",
        );
        pagesMap.set(ref, { text });
      } catch {
        // Unreadable: skip.
      }
    }
  }

  const exportOpts: ExportOptions = {
    includeRaw,
    starters,
    title,
    startPage: startPageRef,
  };
  // A one-file export omits raw assets, so they are not part of the set it
  // carries; multi-page writes them and counts them as carried.
  const meta = buildExportMeta(
    pagesMap,
    exportOpts,
    singleFile ? [] : copiedRawRefs,
  );

  // The start page must be a page this export renders, checked before any
  // write. A copied raw asset is carried but is not a page: promoting it would
  // leave the site without a front page.
  if (startPageRef !== undefined && !meta.rendered.has(startPageRef)) {
    throw new ExportStartPageError(
      startPageErrorMessage(root, startPageRef, startPageFromFlag, includeRaw),
    );
  }

  // A raw asset can claim the path a raw markdown page renders to
  // (raw/x.html beside raw/x.md). Refuse rather than let one clobber the other.
  if (!singleFile) {
    const renderedPaths = new Map<string, string>();
    for (const ref of meta.rendered) {
      renderedPaths.set(meta.outputPathFor(ref), ref);
    }
    for (const ref of copiedRawRefs) {
      const pageRef = renderedPaths.get(ref);
      if (pageRef !== undefined) {
        throw new ExportRawCollisionError(
          `raw asset "${ref}" and the page rendered from "${pageRef}" both write "${ref}" in this export. Rename or remove one of them.`,
        );
      }
    }
  }

  // A supplied get-started set is meaningless beside a start page, but a
  // warning not a failure: the documented --candidates → pick → --starters
  // flow must keep working. A dropped ref is a warning for the same reason —
  // the export is still written, and an all-dropped set still falls back.
  if (startPageRef !== undefined && starters.length > 0) {
    emitDiagnostic(
      `Warning: --starters is ignored because "${startPageRef}" is the start page. Exporting the start page without a get-started block.`,
    );
  } else {
    for (const { pageRef } of droppedStarters(starters, meta)) {
      emitDiagnostic(
        `Warning: --starters ref "${pageRef}" names no page this export carries; it was dropped from the get-started block.`,
      );
    }
  }

  function* allPages(): Generator<{ path: string; content: string }> {
    yield* renderPages(pagesMap, meta, exportOpts);
    yield* renderAggregatePages(pagesMap, meta, exportOpts);
  }

  const outParent = path.dirname(outDir);
  fs.mkdirSync(outParent, { recursive: true });

  if (singleFile) {
    writeSingleFile(outDir, renderSingleFile(pagesMap, meta, exportOpts));
    const assetWarning = singleFileRawAssetWarning(copiedRawRefs);
    if (assetWarning) emitDiagnostic(assetWarning);
    return;
  }

  const tempDir = fs.mkdtempSync(path.join(outParent, ".export-tmp-"));
  try {
    writeTempSite(tempDir, allPages());
    for (const ref of copiedRawRefs) copyRawAssetIn(tempDir, root, ref);
    // Site-relative paths here are always "/"-separated, whichever platform we
    // are on.
    writeFileIn(
      tempDir,
      `${STYLESHEET_DIR}/${STYLESHEET_FILE}`,
      EXPORT_STYLESHEET,
    );

    if (fs.existsSync(outDir)) {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
    fs.renameSync(tempDir, outDir);
  } catch (err) {
    // Clean up temp dir on failure; leave outDir untouched
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Candidates (for --candidates flag)
// ---------------------------------------------------------------------------

/** The ranked get-started candidates for `enchiridion export --candidates`. */
export function buildCandidates(root: string) {
  const vault = new Vault(root);
  const wikiWithText = vault.pagesWithText();
  const pagesMap = new Map<string, { record?: PageRecord; text: string }>();
  for (const [ref, { record, text }] of Object.entries(wikiWithText)) {
    pagesMap.set(ref, { record, text });
  }
  const meta = buildExportMeta(pagesMap);
  return meta.getStarted;
}
