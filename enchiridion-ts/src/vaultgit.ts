/**
 * vaultgit — the one module for git facts about the vault (#126), realised
 * on isomorphic-git (ADR-0017, #256).
 *
 * Each caller's absent-git policy reads as one of two surfaces:
 *
 *   - **Strict** — `VaultGit.init`, `VaultGit.add`, `VaultGit.commit`: throw
 *     an error when the operation can't be performed. This is `commit`'s "git
 *     is a hard dependency" reading.
 *   - **Lenient** — `VaultGit.isWorkTree`, `VaultGit.committedPages`,
 *     `VaultGit.lastCommitDate`, `VaultGit.porcelainMentions`: a missing or
 *     broken repository yields the documented default (false / an empty
 *     Snapshot / "") rather than throwing. `search` reads "no commits means
 *     nothing to index, never a failure" off this, and a lenient method never
 *     throws.
 *
 * ADR-0015: content is always read from HEAD's git blobs, never from
 * intermediate commits or files on disk.
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
  /**
   * Latest non-merge commit date touching this page (YYYY-MM-DD), or "" if
   * it can't be attributed within the read that produced this Snapshot.
   */
  date: string;
  /**
   * The page's bytes at HEAD — always read from HEAD's tree, never from the
   * intermediate commit that changed it. Empty when `deleted`.
   */
  content: string;
  /** Whether the page no longer exists in HEAD's tree. */
  deleted: boolean;
}

/** One `VaultGit.committedPages` read. */
export interface Snapshot {
  /** Resolved HEAD commit SHA, or "" for a repo with no commits. */
  head: string;
  /**
   * Whether this read fell back to (or was asked for) a full tree read rather
   * than an enumerated delta — `pages` then holds every `wiki/**.md` page in
   * HEAD's tree, not a changed subset.
   */
  fullRebuild: boolean;
  /** Per-page delta (or, when fullRebuild, the whole tree). */
  pages: PageChange[];
}

/**
 * The read-only git surface a consumer (here the search index) needs.
 *
 * Defined here per the consumer-first convention (ADR-0017/CLAUDE.md): the
 * interface lives in the module that owns the type it returns, and consumers
 * depend on it; an implementing class satisfies it structurally.
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
 * `root` is never resolved or validated here. All probing is lazy, so a
 * caller can build one, ask an availability question, and never pay for
 * opening a repository if git isn't needed.
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
   * Stage vault-relative paths (a directory is staged recursively).
   * Strict: throws on failure.
   */
  async add(paths: string[]): Promise<void> {
    for (const path of paths) {
      try {
        await git.add({ fs, dir: this.root, filepath: path });
      } catch (err) {
        throw new VaultGitError(`git add ${path}: ${messageOf(err)}`);
      }
    }
    // isomorphic-git's `git.add` stages additions/modifications but not
    // removals — a deleted-but-tracked file stays in the index. Stage the
    // removals explicitly, matching isomorphic-git's own `git.remove` surface.
    await this.stageRemovals(paths);
  }

  /** Remove from the index any tracked file, under a staged path, missing on disk. */
  private async stageRemovals(paths: string[]): Promise<void> {
    let tracked: string[];
    try {
      tracked = await git.listFiles({ fs, dir: this.root, ref: "HEAD" });
    } catch {
      // No HEAD yet (first commit) — nothing is tracked, so nothing to remove.
      return;
    }
    for (const file of tracked) {
      if (!coveredByPaths(file, paths)) continue;
      if (!fs.existsSync(path.join(this.root, file))) {
        await git.remove({ fs, dir: this.root, filepath: file });
      }
    }
  }

  /**
   * Stage `paths` and commit with `message`, holding a file lock for the
   * entire add+commit sequence so concurrent ingests can't cross-contaminate
   * each other's commits (#405). Returns the new commit SHA.
   *
   * The lock lives at `.wiki-knowledge/ingest.lock` under the vault root.
   * It times out after 30 s — long enough for any realistic commit, short
   * enough to surface a stuck process rather than block forever.
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
      // Refuse an empty commit: make sure something is staged
      // against HEAD before committing. statusMatrix mis-reports staged
      // deletions (an index removal reports STAGE == HEAD), so compare the
      // HEAD tree to the index at the blob level instead.
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
        // Only blobs have meaningful on-disk content worth committing; a tree
        // oid difference alone isn't a reliable "staged change" signal.
        if (headType === "blob" || stageType === "blob") {
          const headOid = head ? await head.oid() : null;
          const stageOid = stage ? await stage.oid() : null;
          if (headOid !== stageOid) staged = true;
        }
        // Keep descending into directories on either side.
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
   * HEAD's tree. `since == ""` means "all of HEAD's tree", so a first build
   * and a full rebuild are the same call.
   *
   * Lenient: a missing repository or a repository with no commits yields an
   * empty Snapshot (`head == ""`), never an error.
   *
   * Reachability is not a separate query: the range walk stops the moment it
   * finds `since`, and reaching a history that doesn't contain it — an
   * unreachable or unrecognised watermark, from an amend, rebase, `reset
   * --hard`, or a re-clone over an existing index — falls back to a full tree
   * read (`fullRebuild == true`).
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
   * tree, rel was never committed, or the history can't be walked.
   * Lenient: "" is the default, never an error.
   */
  async lastCommitDate(rel: string): Promise<string> {
    try {
      const commits = await git.log({
        fs,
        dir: this.root,
        ref: "HEAD",
        filepath: rel,
      });
      if (commits.length === 0) return "";
      return formatDate(commits[0].commit.author.timestamp);
    } catch {
      return "";
    }
  }

  /**
   * Whether `rel` is modified or untracked in the working tree — the
   * `git status --porcelain -- rel` signal. Untracked counts: a brand-new
   * file isn't in git's index at all, and finding it is the point.
   * Lenient: false when root isn't a work tree or the status can't be read.
   *
   * The working-tree-vs-blob content comparison is done here, not via
   * isomorphic-git's `status`: it doesn't apply `core.autocrlf` reliably (its
   * normalisation only reads the *local* config and compares the value to the
   * literal string `"true"`), so a clean CRLF checkout of an LF blob — the
   * norm under `core.autocrlf=true` on Windows — reports `*modified`. We read
   * the blob and the working-tree file ourselves and compare them
   * line-ending-insensitively, so a CRLF/LF-only difference is not a false
   * "modified".
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
   * A batched read of the two lenient facts the ingest sweep needs
   * ([ScanFacts.lastCommitDate] and [ScanFacts.porcelainMentions]), computed in
   * a single HEAD tree walk plus a single history walk rather than one walk per
   * file (#415). The returned object answers per-file queries from in-memory
   * maps, so a folder sweep over N files costs O(tree + history) instead of
   * O(N × (tree + history)) — the difference between "returns" and "hangs" on a
   * vault of thousands of raw files.
   *
   * Lenient like the per-file surface: a missing or unreadable repository yields
   * empty maps, so `lastCommitDate` returns "" and `porcelainMentions` reads a
   * file as untracked — the same fail-toward-offering defaults the sweep relies
   * on.
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
   * commit reachable from head, for *all* paths (not just `wiki/**.md`). One
   * history walk feeds the sweep's date comparison for every raw file and every
   * back-pointer page at once.
   */
  private async allCommitDates(
    headOid: string,
    cache: object = {},
  ): Promise<Map<string, string>> {
    return this.latestCommitDates(headOid, () => true, cache);
  }

  // -------------------------------------------------------------------------

  /**
   * Committer identity from git config, falling back to `OS-user@hostname`
   * without error when unset (the same fallback the `git` CLI derives).
   * ADR-0003: attribution comes from ingested content, not git identity, so
   * the committer here is bookkeeping, not provenance.
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
   * `since`, read from HEAD's tree. `found` is false when the history is
   * walked without ever seeing `since` — the caller's cue to fall back to a
   * full tree read.
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
      // attribution (non-merge-only dates keep git_date semantics stable).
      if (commit.commit.parent.length <= 1) {
        const when = commit.commit.author.timestamp * 1000;
        for (const p of paths) {
          const prev = latest.get(p);
          if (prev === undefined || when > prev) latest.set(p, when);
        }
      }
    }

    if (!found) return { pages: [], found: false };
    if (changed.size === 0) return { pages: [], found: true };

    const pages: PageChange[] = [];
    for (const filePath of changed) {
      const result = await this.tryReadFromHead(headOid, filePath);
      const when = latest.get(filePath);
      // If the bounded walk couldn't attribute a date (a path surfaced by a
      // merge's own diff but whose introducing commit lies on a side branch
      // the walk didn't credit), fall back to a dedicated per-path walk —
      // rare, so the extra cost stays bounded to the pages that need it.
      const date =
        when !== undefined
          ? formatDate(when / 1000)
          : await this.pathDate(headOid, filePath);
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
   * `wiki/**.md` path over every commit reachable from head. Used by the full
   * read; the range-walk counterpart is inlined in `rangeSnapshot`.
   */
  private async commitDates(headOid: string): Promise<Map<string, string>> {
    return this.latestCommitDates(headOid, isPageRef);
  }

  /**
   * `{path: YYYY-MM-DD}` — the most recent non-merge commit date per path
   * accepted by `keep`, over every commit reachable from head. Merge commits
   * are skipped before any diff so date attribution stays stable (ADR-0015),
   * and the newest timestamp wins, not log order.
   *
   * Uses [changedBlobPaths] instead of `includeChanges` so unchanged subtrees
   * are pruned — per-commit cost is proportional to what actually changed, not
   * to total vault size (#419).
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
        if (commit.commit.parent.length > 1) continue;
        const parentOid = commit.commit.parent[0] ?? EMPTY_TREE;
        const paths = await changedBlobPaths(
          this.root,
          commit.oid,
          parentOid,
          cache,
        );
        const when = commit.commit.author.timestamp * 1000;
        for (const p of paths) {
          if (!keep(p)) continue;
          const prev = latest.get(p);
          if (prev === undefined || when > prev) latest.set(p, when);
        }
      }
    } catch {
      // Lenient: empty dates when the history can't be walked.
    }
    const out = new Map<string, string>();
    for (const [path, when] of latest) out.set(path, formatDate(when / 1000));
    return out;
  }

  /**
   * Latest non-merge commit date touching `path`, walking back from head with
   * no stopping point short of the root commit — the per-path fallback the
   * range walk uses when its bounded walk can't attribute a date.
   */
  private async pathDate(headOid: string, path: string): Promise<string> {
    try {
      const commits = await git.log({
        fs,
        dir: this.root,
        ref: headOid,
        filepath: path,
      });
      for (const commit of commits) {
        if (commit.commit.parent.length > 1) continue;
        return formatDate(commit.commit.author.timestamp);
      }
    } catch {
      // Lenient fallthrough to "".
    }
    return "";
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
   * Walk every blob in head's tree, invoking `visit` for each one. Directories
   * keep being descended into (isomorphic-git's walk prunes a directory whose
   * `map` returns null, so we must return a truthy value for them).
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
 * history walk (#415). Structurally satisfies the sweep's `Git` interface in
 * `ingestscan.ts`, so it drops straight into `scan()`.
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
 * The CRLF/LF-insensitive text comparison is deliberate: isomorphic-git's own
 * `status` doesn't apply `core.autocrlf` reliably, so a clean CRLF checkout of
 * an LF blob (the norm under `core.autocrlf=true` on Windows) would report
 * `*modified`. We read the blob and working-tree file ourselves and compare
 * them line-ending-insensitively — but only for text (no NUL byte); binary
 * files aren't subject to autocrlf, so a differing binary file is genuinely
 * modified.
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

/**
 * The blob (leaf) paths that differ between `commitOid` and `parentOid`,
 * diffing the commit tree against its parent with pruning: when both sides of
 * a directory have the same tree oid, the subtree is skipped entirely (#419).
 * Per-commit cost is therefore proportional to what the commit actually
 * changed, not to total vault size. Output is identical to what `getChanges`
 * (`isomorphic-git` internal) would return, because pruning only skips entries
 * that `getChanges` would have found unchanged and dropped anyway.
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

      // Both are trees: compare oids to decide whether to descend.
      if (curType === "tree" || prevType === "tree") {
        if (curType === "tree" && prevType === "tree") {
          const [curOid, prevOid] = await Promise.all([
            current!.oid(),
            previous!.oid(),
          ]);
          // Equal oids — identical subtree, nothing to report; prune.
          if (curOid === prevOid) return null;
        }
        return true; // descend
      }

      // Blob level — record if added, removed, or changed.
      const [curOid, prevOid] = await Promise.all([
        current?.oid(),
        previous?.oid(),
      ]);
      if (curOid !== prevOid) out.push(filepath);
      return null; // don't descend blobs
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

/**
 * The shared page predicate (pagepredicate, #310): a page is
 * `wiki/<kind-folder>/<file>.md`, never the generated `wiki/_index.md`, never
 * a nested page. Replaces the loose `isWikiPage` predicate (any `wiki/**`
 * `.md`), which would have counted a committed generated-index artifact and
 * a nested page — diverging from the disk walk and the schema reader. The git
 * walk and the disk walk now share one predicate, so a page the index counts
 * is exactly a page the git walk can hand it (#310).
 */

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
 * atomicity), run `fn`, then release. Retries every 5 ms until the lock is
 * free or `LOCK_TIMEOUT_MS` elapses.
 *
 * Mirrors the sync `withExclusiveLock` in watch.ts but accepts an async
 * critical section — necessary because the add+commit sequence uses
 * isomorphic-git's Promise-based API.
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
