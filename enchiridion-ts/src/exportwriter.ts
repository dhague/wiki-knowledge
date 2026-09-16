import fs from "node:fs";
import path from "node:path";
import * as git from "isomorphic-git";
import { Vault } from "./vault.js";
import {
  buildExportMeta,
  type ExportOptions,
  type StarterEntry,
} from "./exportmeta.js";
import { renderPages } from "./exportrender.js";
import { renderAggregatePages } from "./exportaggregate.js";
import { renderSingleFile, singleFileSizeWarning } from "./exportsingle.js";
import { resolveExportTitle } from "./exportconfig.js";
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

// ---------------------------------------------------------------------------
// Dirty-tree check
// ---------------------------------------------------------------------------

/**
 * Return vault-relative paths of dirty files under `subtreePaths` (relative
 * to `root`). A file is dirty when it is staged, modified, or untracked.
 * Returns an empty array when the directory doesn't exist or isn't a git repo.
 */
export async function dirtyFiles(
  root: string,
  subtreePaths: string[],
): Promise<string[]> {
  if (subtreePaths.length === 0) return [];
  // Short-circuit: not a git repo
  try {
    await git.findRoot({ fs, filepath: root });
  } catch {
    return [];
  }
  try {
    const matrix = await git.statusMatrix({
      fs,
      dir: root,
      filter: (f) => subtreePaths.some((s) => f === s || f.startsWith(s + "/")),
    });
    const dirty: string[] = [];
    for (const [filepath, head, workdir, stage] of matrix) {
      // [1, 1, 1] = clean tracked file; [0, 0, 0] = absent/ignored
      if (head === 1 && workdir === 1 && stage === 1) continue;
      if (head === 0 && workdir === 0 && stage === 0) continue;
      dirty.push(filepath);
    }
    return dirty;
  } catch {
    return [];
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

  // 1. Dirty-tree check
  if (!allowDirty) {
    const subtrees = ["wiki"];
    if (includeRaw) subtrees.push("raw");
    const dirty = await dirtyFiles(root, subtrees);
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
  const exportOpts: ExportOptions = { includeRaw, starters, title };
  const meta = buildExportMeta(pagesMap, exportOpts);

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
