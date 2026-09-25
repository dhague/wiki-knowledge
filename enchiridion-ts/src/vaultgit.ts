/**
 * vaultgit — the one module for git facts about the vault, on isomorphic-git
 * (ADR-0017).
 *
 * Strict methods (`init`/`add`/`commit`) throw on failure; lenient ones return
 * their documented default and never throw. ADR-0015: content is always read
 * from HEAD's git blobs, never from intermediate commits or files on disk.
 */

import * as git from "isomorphic-git";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isPageRef } from "./pagepredicate.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * One `wiki/**.md` page's committed state as of a `Snapshot`'s `head`.
 */
export interface PageChange {
  /** Vault-relative (ADR-0009). */
  pageRef: string;
  /** Latest non-merge commit date (YYYY-MM-DD), or "" when unattributable. */
  date: string;
  /** Bytes at HEAD — never the intermediate commit that changed it. Empty when
   * `deleted`. */
  content: string;
  /** Whether the page no longer exists in HEAD's tree. */
  deleted: boolean;
}

/** One `VaultGit.committedPages` read. */
export interface Snapshot {
  /** Resolved HEAD commit SHA, or "" for a repo with no commits. */
  head: string;
  /** A full tree read rather than a delta — `pages` then holds every
   * `wiki/**.md` page in HEAD. */
  fullRebuild: boolean;
  /** Per-page delta (or, when fullRebuild, the whole tree). */
  pages: PageChange[];
}

/**
 * The read-only git surface a consumer (here the search index) needs.
 *
 * Defined here per the consumer-first convention (ADR-0017); an implementing
 * class satisfies it structurally.
 */
export interface Git {
  committedPages(since: string): Promise<Snapshot>;
}

/** Error thrown by a strict method (init/add/commit) on failure. */
export class VaultGitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultGitError";
  }
}

// ---------------------------------------------------------------------------
// VaultGit
// ---------------------------------------------------------------------------

/**
 * Git verbs and facts over one vault root, backed by isomorphic-git.
 *
 * Constructing one never touches the filesystem — it just pins the root, and
 * all probing is lazy.
 */
export class VaultGit implements Git {
  constructor(private readonly root: string) {}

  // -- Strict: throw on failure ---------------------------------------------

  /** Initialise a git repository at root. Strict: throws on failure. */
  async init(): Promise<void> {
    try {
      await git.init({ fs, dir: this.root });
    } catch (err) {
      throw new VaultGitError(`git init ${this.root}: ${messageOf(err)}`);
    }
  }

  /**
   * Stage vault-relative paths (a directory is staged recursively). Strict:
   * throws on failure.
   *
   * A path missing from disk but tracked at HEAD is a **removal** — a
   * Consolidation's deleted loser (ADR-0021), which is why `Manifest.deleted`
   * joins created and updated refs in one `add(paths)` call. It is skipped here
   * and left to [stageRemovals]: `git.add` would throw NotFoundError for it. A
   * path git has never tracked is a typo, not a removal, and still throws.
   */
  async add(paths: string[]): Promise<void> {
    const tracked = await this.trackedFiles();
    for (const pagePath of paths) {
      if (!fs.existsSync(path.join(this.root, pagePath))) {
        if (!tracked.some((file) => coveredByPaths(file, [pagePath]))) {
          throw new VaultGitError(
            `git add ${pagePath}: no such file or directory`,
          );
        }
        continue;
      }
      try {
        await git.add({ fs, dir: this.root, filepath: pagePath });
      } catch (err) {
        throw new VaultGitError(`git add ${pagePath}: ${messageOf(err)}`);
      }
    }
    // isomorphic-git's `git.add` stages additions/modifications but not
    // removals, so stage those explicitly.
    await this.stageRemovals(tracked, paths);
  }

  /** Every path in HEAD's tree, or [] when there is no HEAD yet (first commit). */
  private async trackedFiles(): Promise<string[]> {
    try {
      return await git.listFiles({ fs, dir: this.root, ref: "HEAD" });
    } catch {
      return [];
    }
  }

  /** Remove from the index any tracked file, under a staged path, missing on disk. */
  private async stageRemovals(
    tracked: string[],
    paths: string[],
  ): Promise<void> {
    for (const file of tracked) {
      if (!coveredByPaths(file, paths)) continue;
      if (!fs.existsSync(path.join(this.root, file))) {
        await git.remove({ fs, dir: this.root, filepath: file });
      }
    }
  }

  /**
   * Stage `paths` and commit with `message`, holding a file lock across the
   * whole add+commit sequence so concurrent ingests can't cross-contaminate each
   * other's commits. Returns the new commit SHA.
   *
   * The lock lives at `.wiki-knowledge/ingest.lock` and times out after 30 s —
   * long enough for any realistic commit, short enough to surface a stuck
   * process.
   */
  async stageAndCommit(paths: string[], message: string): Promise<string> {
    const lockPath = path.join(this.root, ".wiki-knowledge", "ingest.lock");
    return withCommitLock(lockPath, async () => {
      if (paths.length > 0) {
        await this.add(paths);
      }
      return this.commit(message);
    });
  }

  /** Write one commit with `message` and return its SHA. Strict: throws. */
  async commit(message: string): Promise<string> {
    const signature = await this.signature();
    try {
      // statusMatrix mis-reports staged deletions (an index removal reports
      // STAGE == HEAD), so compare the HEAD tree to the index at blob level.
      if (!(await this.hasStagedChanges())) {
        throw new VaultGitError("git commit: nothing to commit");
      }
      return await git.commit({
        fs,
        dir: this.root,
        message,
        author: signature,
        committer: signature,
      });
    } catch (err) {
      if (err instanceof VaultGitError) throw err;
      throw new VaultGitError(`git commit: ${messageOf(err)}`);
    }
  }

  /** Whether any blob differs between HEAD's tree and the staged index. */
  private async hasStagedChanges(): Promise<boolean> {
    let staged = false;
    await git.walk({
      fs,
      dir: this.root,
      trees: [git.TREE({ ref: "HEAD" }), git.STAGE()],
      map: async (
        filepath: string,
        [head, stage]: (git.WalkerEntry | null)[],
      ) => {
        const headType = head ? await head.type() : null;
        const stageType = stage ? await stage.type() : null;
        // Only blobs have meaningful content worth committing; a tree-oid
        // difference alone isn't a reliable "staged change" signal.
        if (headType === "blob" || stageType === "blob") {
          const headOid = head ? await head.oid() : null;
          const stageOid = stage ? await stage.oid() : null;
          if (headOid !== stageOid) staged = true;
        }
        return headType === "tree" || stageType === "tree" ? filepath : null;
      },
    });
    return staged;
  }

  // -- Lenient: never throw, return the documented default -------------------

  /** Whether root is a git work tree. Lenient: false when absent/unreadable. */
  async isWorkTree(): Promise<boolean> {
    try {
      await git.findRoot({ fs, filepath: this.root });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The vault's `wiki/**.md` pages changed since commit `since`, read from
   * HEAD's tree. `since == ""` means "all of HEAD's tree", so a first build and
   * a full rebuild are the same call.
   *
   * Lenient: a missing repository or one with no commits yields an empty
   * Snapshot (`head == ""`), never an error.
   *
   * Reachability is not a separate query: reaching a history that doesn't
   * contain `since` — an amend, rebase, `reset --hard`, or re-clone over an
   * existing index — falls back to a full tree read (`fullRebuild == true`).
   */
  async committedPages(since: string): Promise<Snapshot> {
    let headOid: string;
    try {
      headOid = await git.resolveRef({ fs, dir: this.root, ref: "HEAD" });
    } catch {
      // Missing or empty repo — nothing committed, nothing indexed.
      return { head: "", fullRebuild: false, pages: [] };
    }

    if (!since) {
      return this.fullSnapshot(headOid);
    }

    const range = await this.rangeSnapshot(headOid, since);
    if (range.found) {
      return { head: headOid, fullRebuild: false, pages: range.pages };
    }
    // since unreachable (or unrecognisable) — fall back to a full read.
    return this.fullSnapshot(headOid);
  }

  /**
   * The last commit date of `rel` (YYYY-MM-DD), or "" when root isn't a work
   * tree, rel was never committed, or the history can't be walked. Lenient.
   *
   * Deliberately not `git.log({ filepath: rel })`: isomorphic-git's per-file
   * log stops at the first commit whose tree lacks the path, and a merge looks
   * exactly like that from the side whose branch never had it — so the per-file
   * log can neither skip a merge nor see the non-merge commit behind one.
   * [latestCommitDates] is the one implementation of the rule; [scanFacts]
   * batches the same walk.
   */
  async lastCommitDate(rel: string): Promise<string> {
    let headOid: string;
    try {
      headOid = await git.resolveRef({ fs, dir: this.root, ref: "HEAD" });
    } catch {
      return "";
    }
    return this.lastCommitDateAt(headOid, rel);
  }

  /**
   * [lastCommitDate] against a caller-supplied head — the range walk's fallback
   * needs to date a page against the head that walk already resolved.
   */
  private async lastCommitDateAt(
    headOid: string,
    rel: string,
  ): Promise<string> {
    const dates = await this.latestCommitDates(headOid, (p) => p === rel);
    return dates.get(rel) ?? "";
  }

  /**
   * Whether `rel` is modified or untracked in the working tree — the
   * `git status --porcelain -- rel` signal. Untracked counts: a brand-new file
   * isn't in git's index at all, and finding it is the point.
   * Lenient: false when root isn't a work tree or the status can't be read.
   *
   * The working-tree-vs-blob comparison is done here, not via isomorphic-git's
   * `status`: that doesn't apply `core.autocrlf` reliably (it reads only the
   * *local* config and compares to the literal string `"true"`), so a clean CRLF
   * checkout of an LF blob — the norm under `core.autocrlf=true` on Windows —
   * reports `*modified`. We compare line-ending-insensitively instead.
   */
  async porcelainMentions(rel: string): Promise<boolean> {
    try {
      let headBlob: Buffer | null = null;
      try {
        const headOid = await git.resolveRef({
          fs,
          dir: this.root,
          ref: "HEAD",
        });
        const oid = await resolveFilePath(this.root, headOid, rel);
        const { blob } = await git.readBlob({ fs, dir: this.root, oid });
        headBlob = Buffer.from(blob);
      } catch {
        headBlob = null; // no HEAD, or not in HEAD
      }
      return await porcelainDiff(path.join(this.root, rel), headBlob);
    } catch {
      return false;
    }
  }

  /**
   * Vault-relative paths under any of `subtrees` that are staged,
   * modified-tracked, or untracked — the dirty set the export subcommand checks
   * before writing. Lenient: [] when root is not a work tree.
   */
  async dirtyFiles(subtrees: string[]): Promise<string[]> {
    try {
      const matrix = await git.statusMatrix({
        fs,
        dir: this.root,
        filter: (f: string) => coveredByPaths(f, subtrees),
      });
      const dirty: string[] = [];
      for (const [filepath, head, workdir, stage] of matrix) {
        const isClean = head === 1 && workdir === 1 && stage === 1;
        const isIgnored = head === 0 && workdir === 0 && stage === 0;
        if (!isClean && !isIgnored) dirty.push(filepath as string);
      }
      return dirty;
    } catch {
      return [];
    }
  }

  /**
   * The two lenient facts the ingest sweep needs ([ScanFacts.lastCommitDate] and
   * [ScanFacts.porcelainMentions]), computed in a single HEAD tree walk plus a
   * single history walk rather than one walk per file. Answers per-file queries
   * from in-memory maps, so a sweep over N files costs O(tree + history) instead
   * of O(N × (tree + history)).
   *
   * Lenient like the per-file surface: empty maps when the repository is
   * unreadable, so `lastCommitDate` returns "" and `porcelainMentions` reads a
   * file as untracked.
   */
  async scanFacts(): Promise<ScanFacts> {
    let headOid: string;
    try {
      headOid = await git.resolveRef({ fs, dir: this.root, ref: "HEAD" });
    } catch {
      return new ScanFacts(this.root, new Map(), new Map());
    }
    const cache: object = {};
    const treeOids = await this.headBlobOids(headOid, cache);
    const dates = await this.allCommitDates(headOid, cache);
    return new ScanFacts(this.root, treeOids, dates);
  }

  /** `{path: blob oid}` for every blob in head's tree — one tree walk. */
  private async headBlobOids(
    headOid: string,
    cache: object = {},
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    await this.walkTree(
      headOid,
      async (filepath, entry) => {
        out.set(filepath, await entry.oid());
      },
      cache,
    );
    return out;
  }

  /**
   * `{path: YYYY-MM-DD}` — the latest non-merge commit date per path over every
   * commit reachable from head, for *all* paths (not just `wiki/**.md`).
   */
  private async allCommitDates(
    headOid: string,
    cache: object = {},
  ): Promise<Map<string, string>> {
    return this.latestCommitDates(headOid, KEEP_ALL, cache);
  }

  // -------------------------------------------------------------------------

  /**
   * Committer identity from git config, falling back to `OS-user@hostname`
   * without error when unset. ADR-0003: attribution comes from ingested content,
   * not git identity, so the committer here is bookkeeping, not provenance.
   */
  private async signature(): Promise<{
    name: string;
    email: string;
    timestamp: number;
    timezoneOffset: number;
  }> {
    let name = await this.tryConfig("user.name");
    let email = await this.tryConfig("user.email");
    if (!name) name = fallbackUser();
    if (!email) email = `${name}@${fallbackHost()}`;
    const timestamp = Math.floor(Date.now() / 1000);
    return {
      name,
      email,
      timestamp,
      timezoneOffset: new Date().getTimezoneOffset(),
    };
  }

  private async tryConfig(path: string): Promise<string> {
    try {
      const value = await git.getConfig({ fs, dir: this.root, path });
      return typeof value === "string" ? value : "";
    } catch {
      return "";
    }
  }

  /**
   * Range walk: the `wiki/**.md` paths touched from head's history back to
   * `since`, read from HEAD's tree. `found` is false when the history is walked
   * without ever seeing `since` — the caller's cue to fall back to a full read.
   */
  private async rangeSnapshot(
    headOid: string,
    since: string,
  ): Promise<{ pages: PageChange[]; found: boolean }> {
    if (since === headOid) {
      // HEAD already accounted for — no pages to report, no filesystem work.
      return { pages: [], found: true };
    }

    let commits: git.ReadCommitResult[];
    try {
      commits = await git.log({
        fs,
        dir: this.root,
        ref: headOid,
        includeChanges: true,
      });
    } catch {
      return { pages: [], found: false };
    }

    const changed = new Set<string>();
    // path -> latest non-merge commit timestamp (ms); max kept, not log order.
    const latest = new Map<string, number>();
    let found = false;

    for (const commit of commits) {
      if (commit.oid === since) {
        found = true;
        break;
      }
      const paths = changedWikiPaths(commit);
      if (paths.length === 0) continue;
      for (const p of paths) changed.add(p);
      // Merge commits contribute to path enumeration above (so a path touched
      // only by a conflict resolution is still enumerated) but not to date
      // attribution — [attributeDate] carries that half of the rule.
      await attributeDate(commit, () => paths, KEEP_ALL, latest);
    }

    if (!found) return { pages: [], found: false };
    if (changed.size === 0) return { pages: [], found: true };

    const pages: PageChange[] = [];
    for (const filePath of changed) {
      const result = await this.tryReadFromHead(headOid, filePath);
      const when = latest.get(filePath);
      // A path surfaced by a merge's own diff whose introducing commit lies on
      // a side branch the walk didn't credit: fall back to a dedicated per-path
      // walk, rare enough that the extra cost stays bounded.
      const date =
        when !== undefined
          ? formatDate(when / 1000)
          : await this.lastCommitDateAt(headOid, filePath);
      pages.push({
        pageRef: filePath,
        content: result ?? "",
        date,
        deleted: !result,
      });
    }
    return { pages, found: true };
  }

  /** Read every `wiki/**.md` page out of head's tree. */
  private async fullSnapshot(headOid: string): Promise<Snapshot> {
    const dates = await this.commitDates(headOid);
    const pages: PageChange[] = [];
    await this.walkTree(headOid, async (filepath, entry) => {
      if (!isPageRef(filepath)) return;
      const oid = await entry.oid();
      const content = await readBlobAsString(this.root, oid);
      pages.push({
        pageRef: filepath,
        content,
        date: dates.get(filepath) ?? "",
        deleted: false,
      });
    });
    return { head: headOid, fullRebuild: true, pages };
  }

  /**
   * `{path: YYYY-MM-DD}` — the most recent non-merge commit date per
   * `wiki/**.md` path over every commit reachable from head.
   */
  private async commitDates(headOid: string): Promise<Map<string, string>> {
    return this.latestCommitDates(headOid, isPageRef);
  }

  /**
   * `{path: YYYY-MM-DD}` — the most recent non-merge commit date per path
   * accepted by `keep`, over every commit reachable from head. The one
   * implementation of the rule: [lastCommitDate] is this walk narrowed to one
   * path. Newest timestamp wins, never log order.
   *
   * Uses [changedBlobPaths] instead of `includeChanges` so unchanged subtrees
   * are pruned — per-commit cost is proportional to what actually changed, not
   * to total vault size — and [attributeDate] takes the paths as a thunk, so a
   * merge is rejected before that diff is computed.
   *
   * Lenient: empty dates when the history can't be walked.
   */
  private async latestCommitDates(
    headOid: string,
    keep: (p: string) => boolean,
    cache: object = {},
  ): Promise<Map<string, string>> {
    const latest = new Map<string, number>();
    try {
      const commits = await git.log({
        fs,
        dir: this.root,
        ref: headOid,
        cache,
      });
      for (const commit of commits) {
        const parentOid = commit.commit.parent[0] ?? EMPTY_TREE;
        await attributeDate(
          commit,
          () => changedBlobPaths(this.root, commit.oid, parentOid, cache),
          keep,
          latest,
        );
      }
    } catch {
      // Lenient: empty dates when the history can't be walked.
    }
    const out = new Map<string, string>();
    for (const [path, when] of latest) out.set(path, formatDate(when / 1000));
    return out;
  }

  /** Read `filePath` from head's tree, or null when it's deleted there. */
  private async tryReadFromHead(
    headOid: string,
    filePath: string,
  ): Promise<string | null> {
    try {
      const oid = await resolveFilePath(this.root, headOid, filePath);
      return await readBlobAsString(this.root, oid);
    } catch {
      return null;
    }
  }

  /**
   * Walk every blob in head's tree, invoking `visit` for each one.
   * isomorphic-git prunes a directory whose `map` returns null, so directories
   * must return a truthy value.
   */
  private async walkTree(
    headOid: string,
    visit: (filepath: string, entry: git.WalkerEntry) => Promise<void>,
    cache: object = {},
  ): Promise<void> {
    await git.walk({
      fs,
      dir: this.root,
      cache,
      trees: [git.TREE({ ref: headOid })],
      map: async (filepath: string, [entry]: (git.WalkerEntry | null)[]) => {
        if (!entry) return null;
        const type = await entry.type();
        if (type !== "blob") return filepath; // keep descending into trees
        await visit(filepath, entry);
        return null;
      },
    });
  }
}

// ---------------------------------------------------------------------------
// ScanFacts
// ---------------------------------------------------------------------------

/**
 * The batched result of [VaultGit.scanFacts] — answers the ingest sweep's two
 * lenient per-file questions from in-memory maps built in one tree walk + one
 * history walk. Structurally satisfies the sweep's `Git` interface in
 * `ingestscan.ts`, so it drops straight into `scan()`.
 *
 * `dates` is [VaultGit.latestCommitDates]' output, so a path answers here
 * exactly as [VaultGit.lastCommitDate] answers it.
 */
export class ScanFacts {
  constructor(
    private readonly root: string,
    /** Vault-relative path → blob oid in HEAD's tree. */
    private readonly treeOids: Map<string, string>,
    /** Vault-relative path → latest non-merge commit date (YYYY-MM-DD). */
    private readonly dates: Map<string, string>,
  ) {}

  /** The last commit date of rel, or "" when absent from the date map. */
  async lastCommitDate(rel: string): Promise<string> {
    return this.dates.get(rel) ?? "";
  }

  /** Whether rel is modified or untracked, using the precomputed HEAD tree. */
  async porcelainMentions(rel: string): Promise<boolean> {
    let headBlob: Buffer | null = null;
    const oid = this.treeOids.get(rel);
    if (oid !== undefined) {
      try {
        const { blob } = await git.readBlob({ fs, dir: this.root, oid });
        headBlob = Buffer.from(blob);
      } catch {
        headBlob = null;
      }
    }
    return porcelainDiff(path.join(this.root, rel), headBlob);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * The working-tree-vs-HEAD-blob comparison behind `porcelainMentions`, shared
 * by the per-file [VaultGit.porcelainMentions] and the batched [ScanFacts].
 * `headBlob` is the file's bytes at HEAD, or null when it isn't in HEAD.
 *
 * Line-ending-insensitive only for text (no NUL byte): binary files aren't
 * subject to autocrlf, so a differing binary file is genuinely modified.
 */
async function porcelainDiff(
  diskPath: string,
  headBlob: Buffer | null,
): Promise<boolean> {
  let work: Buffer | null;
  try {
    work = await fs.promises.readFile(diskPath);
  } catch {
    work = null; // not on disk
  }
  const onDisk = work !== null;
  const inHead = headBlob !== null;

  if (!inHead && !onDisk) return false; // absent everywhere
  if (!inHead && onDisk) return true; // untracked (a brand-new file)
  if (inHead && !onDisk) return true; // deleted from the working tree

  if (headBlob!.equals(work!)) return false;
  if (!headBlob!.includes(0) && !work!.includes(0)) {
    if (
      normalizeEol(headBlob!.toString("utf8")) ===
      normalizeEol(work!.toString("utf8"))
    ) {
      return false;
    }
  }
  return true;
}

/** SHA-1 of the empty tree — used as the parent oid for root commits. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** The `keep` of a walk that wants every path it finds. */
const KEEP_ALL = (): boolean => true;

/**
 * Whether a commit sets a path's commit date. CONTEXT.md, **Commit date**: the
 * date of the latest commit touching a page, and *merge commits don't set it*.
 *
 * One predicate, because a path's date is read four ways in this module; a rule
 * restated at each site is free to disagree with itself.
 */
function setsCommitDate(commit: git.ReadCommitResult): boolean {
  return commit.commit.parent.length <= 1;
}

/**
 * The one application of that rule: attribute `commit`'s date to the paths it
 * touched, or to nothing at all when the commit is a merge. `into` maps a path
 * to the newest timestamp (ms) that set its date — newest wins, never log order.
 *
 * `touched` is a thunk so a merge is rejected before the tree diff behind the
 * paths is computed, and `keep` narrows a caller's walk to the paths it wants.
 */
async function attributeDate(
  commit: git.ReadCommitResult,
  touched: () => string[] | Promise<string[]>,
  keep: (p: string) => boolean,
  into: Map<string, number>,
): Promise<void> {
  if (!setsCommitDate(commit)) return;
  const when = commit.commit.author.timestamp * 1000;
  for (const p of await touched()) {
    if (!keep(p)) continue;
    const prev = into.get(p);
    if (prev === undefined || when > prev) into.set(p, when);
  }
}

/**
 * The blob (leaf) paths that differ between `commitOid` and `parentOid`, pruning
 * a subtree when both sides carry the same tree oid. Per-commit cost is
 * proportional to what the commit actually changed; output is identical to
 * `getChanges`, which drops unchanged entries anyway.
 */
async function changedBlobPaths(
  root: string,
  commitOid: string,
  parentOid: string,
  cache: object,
): Promise<string[]> {
  const out: string[] = [];
  await git.walk({
    fs,
    dir: root,
    cache,
    trees: [git.TREE({ ref: commitOid }), git.TREE({ ref: parentOid })],
    map: async (
      filepath: string,
      [current, previous]: (git.WalkerEntry | null)[],
    ) => {
      if (filepath === ".") return true; // always descend root

      const [curType, prevType] = await Promise.all([
        current?.type(),
        previous?.type(),
      ]);

      // Both trees: prune identical subtrees, otherwise descend.
      if (curType === "tree" || prevType === "tree") {
        if (curType === "tree" && prevType === "tree") {
          const [curOid, prevOid] = await Promise.all([
            current!.oid(),
            previous!.oid(),
          ]);
          if (curOid === prevOid) return null;
        }
        return true;
      }

      // Blob level — record if added, removed, or changed.
      const [curOid, prevOid] = await Promise.all([
        current?.oid(),
        previous?.oid(),
      ]);
      if (curOid !== prevOid) out.push(filepath);
      return null;
    },
  });
  return out;
}

/** The `wiki/**.md` paths a logged commit (with includeChanges) touched. */
function changedWikiPaths(commit: git.ReadCommitResult): string[] {
  const changes = commit.commit.changes;
  if (!changes) return [];
  const out: string[] = [];
  for (const change of changes) {
    const filepath = change[2];
    if (filepath && isPageRef(filepath)) out.push(filepath);
  }
  return out;
}

// The page predicate is pagepredicate's `isPageRef`; the git walk and the disk
// walk share it, so both count exactly the same pages.

/** Whether a vault-relative `file` is under one of the staged `paths`. */
function coveredByPaths(file: string, paths: string[]): boolean {
  return paths.some((p) => {
    if (p === "." || p === "./") return true;
    return file === p || file.startsWith(p.endsWith("/") ? p : p + "/");
  });
}

function formatDate(timestampSeconds: number): string {
  return new Date(timestampSeconds * 1000).toISOString().slice(0, 10);
}

/** Collapse CRLF to LF — the `core.autocrlf` clean-filter comparison. */
function normalizeEol(s: string): string {
  return s.replace(/\r\n/g, "\n");
}

function fallbackUser(): string {
  try {
    const u = os.userInfo();
    if (u.username) return u.username;
  } catch {
    // os.userInfo() throws when the user can't be resolved; fall through.
  }
  return "enchiridion";
}

function fallbackHost(): string {
  const host = os.hostname();
  return host || "localhost";
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Acquire an exclusive lock on `lockPath` (created with the `wx` flag for
 * atomicity), run `fn`, then release. Retries every 5 ms until the lock is free
 * or `LOCK_TIMEOUT_MS` elapses.
 *
 * Async, unlike the sync `withExclusiveLock` in watch.ts, because the add+commit
 * sequence uses isomorphic-git's Promise-based API.
 */
async function withCommitLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  const LOCK_TIMEOUT_MS = 30_000;
  const RETRY_MS = 5;

  fs.mkdirSync(path.dirname(lockPath), { recursive: true });

  const start = Date.now();
  let fd: number | undefined;
  for (;;) {
    try {
      fd = fs.openSync(lockPath, "wx");
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      if (Date.now() - start > LOCK_TIMEOUT_MS) {
        throw new VaultGitError(
          `git stageAndCommit: lock timeout after ${LOCK_TIMEOUT_MS} ms (${lockPath}) — a previous ingest may have crashed`,
        );
      }
      await new Promise<void>((r) => setTimeout(r, RETRY_MS));
    }
  }
  try {
    return await fn();
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try {
      fs.unlinkSync(lockPath);
    } catch {
      // best-effort: ENOENT means another process already cleaned up
    }
  }
}

async function readBlobAsString(root: string, oid: string): Promise<string> {
  const { blob } = await git.readBlob({ fs, dir: root, oid });
  return Buffer.from(blob).toString("utf8");
}

/** Walk HEAD's tree to find the oid for `filePath`; throws if absent. */
async function resolveFilePath(
  root: string,
  headOid: string,
  filePath: string,
): Promise<string> {
  let foundOid: string | null = null;
  await git.walk({
    fs,
    dir: root,
    trees: [git.TREE({ ref: headOid })],
    map: async (fp: string, [entry]: (git.WalkerEntry | null)[]) => {
      if (!entry) return null;
      const type = await entry.type();
      if (type !== "tree" && fp === filePath) {
        foundOid = await entry.oid();
      }
      return type === "tree" ? fp : null; // keep descending into trees
    },
  });
  if (!foundOid) throw new Error(`${filePath} not found in HEAD`);
  return foundOid;
}
