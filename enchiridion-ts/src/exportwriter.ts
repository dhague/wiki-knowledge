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
import type { PageRecord } from "./pagerecord.js";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface ExportWriterOptions {
  /** Output directory — absolute path. Defaults to `<vaultRoot>/web/`. */
  out: string;
  /** Include raw/ pages. Default false. */
  raw?: boolean;
  /** Overwrite a non-empty output directory without error. Default false. */
  force?: boolean;
  /** Skip the dirty-tree check. Default false. */
  allowDirty?: boolean;
  /** Supplied starters override fallback ranking on the front page. */
  starters?: StarterEntry[];
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

function writeTempSite(
  tempDir: string,
  pages: IterableIterator<{ path: string; content: string }>,
): void {
  for (const { path: relPath, content } of pages) {
    const abs = path.join(tempDir, ...relPath.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
  }
}

// ---------------------------------------------------------------------------
// Main export runner
// ---------------------------------------------------------------------------

/**
 * Run the full export: dirty check → page load → render → write.
 * All writes go to a temp dir on the same filesystem as `opts.out`; the
 * temp dir is atomically renamed into place only after all writes succeed.
 * The existing `opts.out` is removed only after the temp build completes.
 */
export async function runExport(
  root: string,
  opts: ExportWriterOptions,
): Promise<void> {
  const outDir = opts.out;
  const includeRaw = opts.raw ?? false;
  const allowDirty = opts.allowDirty ?? false;
  const force = opts.force ?? false;
  const starters = opts.starters ?? [];

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

  // 2. Check for non-empty target
  if (!force && fs.existsSync(outDir)) {
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
  const exportOpts: ExportOptions = { includeRaw, starters };
  const meta = buildExportMeta(pagesMap, exportOpts);

  // 5. Render all pages
  function* allPages(): Generator<{ path: string; content: string }> {
    yield* renderPages(pagesMap, meta, exportOpts);
    yield* renderAggregatePages(pagesMap, meta, exportOpts);
  }

  // 6. Write to temp dir
  const outParent = path.dirname(outDir);
  fs.mkdirSync(outParent, { recursive: true });
  const tempDir = fs.mkdtempSync(path.join(outParent, ".export-tmp-"));
  try {
    writeTempSite(tempDir, allPages());

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
