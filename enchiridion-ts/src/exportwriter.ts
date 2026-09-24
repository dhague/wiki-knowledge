import fs from "node:fs";
import path from "node:path";
import { Vault } from "./vault.js";
import { VaultGit } from "./vaultgit.js";
import {
  buildExportMeta,
  type ExportOptions,
  type StarterEntry,
} from "./exportmeta.js";
import { renderPages } from "./exportrender.js";
import { renderAggregatePages } from "./exportaggregate.js";
import { renderSingleFile, singleFileSizeWarning } from "./exportsingle.js";
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

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface ExportWriterOptions {
  /**
   * Absolute path of what to write. In multi-page mode an output directory
   * (default `<vaultRoot>/web/`); under `singleFile` the output *file* itself
   * (default `<vaultRoot>/wiki.html`). The caller resolves the default —
   * it is the layer that knows which mode was asked for.
   */
  out: string;
  /** Include raw/ pages. Default false. */
  raw?: boolean;
  /**
   * Write the whole site as one self-contained HTML file at `out` instead of
   * a directory tree. Default false.
   */
  singleFile?: boolean;
  /** Overwrite a non-empty output directory without error. Default false.
   *  Multi-page only: a single file is replaced in place either way. */
  force?: boolean;
  /** Skip the dirty-tree check. Default false. */
  allowDirty?: boolean;
  /** Supplied starters override fallback ranking on the front page. */
  starters?: StarterEntry[];
  /**
   * Wiki title for this run only — the per-run flag, not a resolved title.
   * Leave it unset to take the vault's saved title, or failing that the vault
   * root directory name (see resolveExportTitle).
   */
  title?: string;
  /**
   * Start page for this run only — the per-run flag, not a resolved ref.
   * Leave it unset to take the vault's saved start page, or failing that none
   * (the export keeps its generated front page). See resolveExportStartPage.
   */
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
 *  than a rename failing with EISDIR, which names the syscall and not the
 *  mistake. */
export class ExportTargetIsDirectoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportTargetIsDirectoryError";
  }
}

/** The resolved start page is not a page this export carries — an unknown
 *  ref, a raw/ page without `--raw`, or a saved ref the export no longer
 *  includes. Deliberately fatal rather than falling back to the generated
 *  front page: that fallback is the silent behaviour the setting exists to
 *  replace, and it is exactly where a `--save-start-page` that stopped
 *  matching would otherwise hide. See ADR-0023. */
export class ExportStartPageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportStartPageError";
  }
}

// ---------------------------------------------------------------------------
// Raw page enumeration
// ---------------------------------------------------------------------------

/**
 * Walk `raw/` and return all vault-relative paths of files found there.
 * Returns empty when `raw/` doesn't exist.
 */
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

/**
 * Every page ref the vault holds — every `wiki/` page plus every file under
 * `raw/`. This is the vault's page enumeration without the export's `--raw`
 * filter: `--save-start-page` validates a ref against *the vault*, because
 * whether the export carries a `raw/` page is a question only a run can
 * answer. A ref that names no page here is rejected at save time; a ref that
 * names a `raw/` page is saved, and validated again at export time.
 */
export function vaultPageRefs(root: string): Set<string> {
  const refs = new Set<string>(Object.keys(new Vault(root).pagesWithText()));
  for (const ref of enumerateRawRefs(root)) refs.add(ref);
  return refs;
}

/**
 * The refusal for a start page the export cannot fill the front page with.
 * Names the source — the flag, or the config file the operator has to re-save
 * or clear — and, for a `raw/` page without `--raw`, names the one flag that
 * would make it legal. The two sources get different advice because only the
 * flag can be fixed by re-running the same command.
 */
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
    fs.existsSync(path.join(root, ...ref.split("/")))
  ) {
    return `${source} is a raw/ page, which this run does not include. Pass --raw to include raw/ pages, or nominate a wiki/ page.`;
  }

  if (fromFlag) {
    return `${source} does not name a page in this export. Check the ref, or drop --start-page to use the generated front page.`;
  }
  return `${source} does not name a page in this export. Re-save a different page with --save-start-page, clear it with a blank --save-start-page, or pass --raw if the page is under raw/.`;
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

function writeTempSite(
  tempDir: string,
  pages: IterableIterator<{ path: string; content: string }>,
): void {
  for (const { path: relPath, content } of pages) {
    writeFileIn(tempDir, relPath, content);
  }
}

/**
 * Write the single-file document, through a temp file on the same filesystem
 * and an atomic rename — the same reasoning as the multi-page write, with one
 * file instead of a tree. The existing output is replaced outright: in this
 * mode the target *is* the export, so re-running to refresh it is the normal
 * case and needs no `--force`.
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
  if (warning) console.error(warning);
}

// ---------------------------------------------------------------------------
// Main export runner
// ---------------------------------------------------------------------------

/**
 * Run the full export: dirty check → page load → render → write.
 * All writes go to a temp path on the same filesystem as `opts.out`; it is
 * atomically renamed into place only after all writes succeed. The existing
 * `opts.out` is removed only after the temp build completes.
 *
 * The two output modes share everything up to the write: same dirty check,
 * same page load, same metadata, same page parts. `singleFile` chooses only
 * what shape those parts are assembled into and where they land.
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
  // The one place a vault-derived wiki title is resolved: flag → vault config
  // → directory name. Everything downstream — the nav bar and front page
  // heading — reads the result, never the inputs. (Renderers reached without a
  // vault fall back to a neutral label rather than an empty nav; see
  // exportTitle.)
  const title = resolveExportTitle(root, opts.title);
  // And the one place the start page is resolved: flag → saved ref → none.
  // Resolved here even though validation needs the exported set below, so no
  // caller can invent a different order (the same reason the title resolves
  // here).
  const startPageRef = resolveExportStartPage(root, opts.startPage);
  const startPageFromFlag = isSupplied(opts.startPage);

  // 1. Dirty-tree check. The fact comes from vaultgit, the module that owns
  // every git question about a vault — this module has no git opinion of its
  // own, only this refusal.
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

  // 2. Check the target. A single file is replaced without ceremony (re-running
  // is how it is refreshed); a directory tree is only replaced under --force.
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

  // 3. Load pages
  const vault = new Vault(root);
  const pagesMap = new Map<string, { record?: PageRecord; text: string }>();

  const wikiWithText = vault.pagesWithText();
  for (const [ref, { record, text }] of Object.entries(wikiWithText)) {
    pagesMap.set(ref, { record, text });
  }

  if (includeRaw) {
    const rawRefs = enumerateRawRefs(root);
    for (const ref of rawRefs) {
      try {
        const text = fs.readFileSync(
          path.join(root, ...ref.split("/")),
          "utf8",
        );
        pagesMap.set(ref, { text });
      } catch {
        // Skip unreadable raw files
      }
    }
  }

  // 4. Build metadata
  const exportOpts: ExportOptions = {
    includeRaw,
    starters,
    title,
    startPage: startPageRef,
  };
  const meta = buildExportMeta(pagesMap, exportOpts);

  // 4a. The start page must be a page this export carries. Checked before any
  // write, and fatal rather than falling back: silently reverting to the
  // generated front page is the behaviour the setting exists to replace.
  if (startPageRef !== undefined && !meta.exported.has(startPageRef)) {
    throw new ExportStartPageError(
      startPageErrorMessage(root, startPageRef, startPageFromFlag, includeRaw),
    );
  }

  // 4b. A supplied get-started set is meaningless beside a start page — the
  // page supplies its own entrance. Deletion is what --starters means, so this
  // is a note on stderr, not a failure: the documented skill flow
  // (--candidates → pick → --starters) must keep working.
  if (startPageRef !== undefined && starters.length > 0) {
    console.error(
      `Warning: --starters is ignored because "${startPageRef}" is the start page. Exporting the start page without a get-started block.`,
    );
  }

  // 5. Render all pages
  function* allPages(): Generator<{ path: string; content: string }> {
    yield* renderPages(pagesMap, meta, exportOpts);
    yield* renderAggregatePages(pagesMap, meta, exportOpts);
  }

  // 6. Write
  const outParent = path.dirname(outDir);
  fs.mkdirSync(outParent, { recursive: true });

  if (singleFile) {
    writeSingleFile(outDir, renderSingleFile(pagesMap, meta, exportOpts));
    return;
  }

  const tempDir = fs.mkdtempSync(path.join(outParent, ".export-tmp-"));
  try {
    writeTempSite(tempDir, allPages());
    // The shared stylesheet, written once at the output root. Every page
    // links it at its own depth; no page carries a copy. Site-relative paths
    // here are always "/"-separated, whichever platform we are on.
    writeFileIn(
      tempDir,
      `${STYLESHEET_DIR}/${STYLESHEET_FILE}`,
      EXPORT_STYLESHEET,
    );

    // 7. Atomic swap: remove existing outDir, rename temp into place
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

/**
 * Return the ranked get-started candidate list as a JSON-serialisable array.
 * Used by `enchiridion export --candidates`.
 */
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
