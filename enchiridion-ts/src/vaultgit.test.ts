/**
 * Integration tests for the vaultgit module (#256). These use real
 * isomorphic-git repositories in temp directories, with these acceptance
 * criteria:
 *
 *   - strict methods throw on failure; lenient methods return defaults
 *   - committedPages covers all three paths (HEAD == watermark, reachable
 *     range, unreachable-watermark full rebuild)
 *   - merge-commit-changed paths are enumerated but merge commits don't
 *     attribute dates
 *   - content is read from HEAD's git blobs, never files on disk
 *   - commit falls back to OS-user@hostname without error
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as git from "isomorphic-git";
import { VaultGit } from "./vaultgit.js";
import type { Snapshot } from "./vaultgit.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "vaultgit-test-"));
}

/** Vault-relative path helper: write `content` to `rel` (mkdirs parents). */
function writeFile(root: string, rel: string, content: string): void {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function removeFile(root: string, rel: string): void {
  fs.rmSync(path.join(root, rel));
}

function deterministicSignature(offsetHours: number) {
  // Deterministic but distinct per commit so LastCommitDate / date attribution
  // is testable: base time + offsetHours, in seconds.
  const base = new Date("2026-01-01T00:00:00Z").getTime() / 1000;
  const offset = offsetHours * 3600;
  return {
    name: "test",
    email: "test@example.com",
    timestamp: Math.floor(base + offset),
    timezoneOffset: 0,
  };
}

async function commitAll(
  root: string,
  message: string,
  signature = deterministicSignature(1),
): Promise<string> {
  await stageEverything(root);
  return git.commit({
    fs,
    dir: root,
    message,
    author: signature,
    committer: signature,
  });
}

/**
 * Stage the whole worktree including deletions — mirroring what the vaultgit
 * `add` does, since raw `git.add` alone won't stage a removal.
 */
async function stageEverything(root: string): Promise<void> {
  await git.add({ fs, dir: root, filepath: "." });
  let tracked: string[];
  try {
    tracked = await git.listFiles({ fs, dir: root, ref: "HEAD" });
  } catch {
    return; // no HEAD yet
  }
  for (const file of tracked) {
    if (!fs.existsSync(path.join(root, file))) {
      await git.remove({ fs, dir: root, filepath: file });
    }
  }
}

function pagesByRef(snap: Snapshot): Map<string, Snapshot["pages"][number]> {
  const out = new Map();
  for (const p of snap.pages) out.set(p.pageRef, p);
  return out;
}

// ---------------------------------------------------------------------------
// Strict / lenient surface
// ---------------------------------------------------------------------------

test("isWorkTree is false on a bare temp dir and true after init", async () => {
  const root = tmpRepo();
  const repo = new VaultGit(root);
  assert.equal(await repo.isWorkTree(), false);
  await repo.init();
  assert.equal(await repo.isWorkTree(), true);
});

test("init throws on an invalid root (strict)", async () => {
  // Root is a *file*, so git init can't create a repo inside it.
  const root = tmpRepo();
  const file = path.join(root, "not-a-dir");
  fs.writeFileSync(file, "x");
  const repo = new VaultGit(file);
  await assert.rejects(() => repo.init());
});

test("init/add/commit round-trip returns a 40-char SHA", async () => {
  const root = tmpRepo();
  const repo = new VaultGit(root);
  await repo.init();
  writeFile(root, "wiki/concepts/a.md", "one\n");
  await repo.add(["wiki"]);
  const sha = await repo.commit("first");
  assert.match(sha, /^[0-9a-f]{40}$/);
});

test("add throws on failure (strict)", async () => {
  const root = tmpRepo();
  const repo = new VaultGit(root);
  await assert.rejects(() => repo.add(["wiki/concepts/a.md"]));
});

test("commit throws when there is nothing to commit (strict)", async () => {
  const root = tmpRepo();
  const repo = new VaultGit(root);
  await repo.init();
  await assert.rejects(() => repo.commit("empty"));
});

test("commit falls back to OS-user@hostname without error", async () => {
  // A freshly-initialised repo has no user.name/user.email; committing must
  // fall back rather than fail.
  const root = tmpRepo();
  const repo = new VaultGit(root);
  await repo.init();
  writeFile(root, "wiki/concepts/a.md", "one\n");
  await repo.add(["."]);
  const sha = await repo.commit("first");
  assert.match(sha, /^[0-9a-f]{40}$/);

  // Commit landed with the fallback identity: the current branch's single
  // commit carries a name of `OS-user@host`.
  const { commit } = (await git.log({ fs, dir: root, depth: 1 }))[0];
  const expected = `${os.userInfo().username}@${os.hostname()}`;
  assert.equal(commit.author.email, expected);
});

// ---------------------------------------------------------------------------
// CommittedPages: full read (since == "")
// ---------------------------------------------------------------------------

test('committedPages("") is a full rebuild covering the root commit', async () => {
  const root = tmpRepo();
  const repo = new VaultGit(root);
  await repo.init();
  writeFile(root, "wiki/concepts/a.md", "one\n");
  writeFile(root, "raw/notes.md", "raw\n");
  await commitAll(root, "first", deterministicSignature(1));

  const snap = await repo.committedPages("");
  assert.equal(snap.fullRebuild, true);
  const byRef = pagesByRef(snap);
  const page = byRef.get("wiki/concepts/a.md");
  assert.ok(page, "a.md should be in the full tree");
  assert.match(page!.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(page!.content, "one\n");
  assert.ok(!byRef.has("raw/notes.md"), "raw/ must not be enumerated");
});

test('committedPages("") returns the latest committed bytes', async () => {
  const root = tmpRepo();
  const repo = new VaultGit(root);
  await repo.init();
  writeFile(root, "wiki/concepts/a.md", "one\n");
  await commitAll(root, "first");
  writeFile(root, "wiki/concepts/a.md", "one, edited\n");
  await commitAll(root, "second");

  const snap = await repo.committedPages("");
  const byRef = pagesByRef(snap);
  assert.ok(byRef.has("wiki/concepts/a.md"));
  assert.equal(byRef.get("wiki/concepts/a.md")!.content, "one, edited\n");
});

test('committedPages("") excludes a committed wiki/_index.md — never a page (#310)', async () => {
  // Q1 resolution: per ADR-0015 the index is a view of HEAD's committed wiki/
  // tree, but the generated index artifact is *never* a page, so even a
  // committed wiki/_index.md in HEAD's tree must not be enumerated — it can
  // never be indexed or counted. The git walk and the disk walk share the
  // page predicate, so they agree.
  const root = tmpRepo();
  const repo = new VaultGit(root);
  await repo.init();
  writeFile(root, "wiki/concepts/a.md", "one\n");
  writeFile(root, "wiki/_index.md", "generated table of contents\n");
  await commitAll(root, "first");

  const snap = await repo.committedPages("");
  const byRef = pagesByRef(snap);
  assert.ok(byRef.has("wiki/concepts/a.md"));
  assert.ok(!byRef.has("wiki/_index.md"), "generated index must not be a page");
});

test('committedPages("") excludes a committed nested page — a structural error (#310)', async () => {
  // Q2 resolution: the schema reader treats "directly under a kind-folder" as
  // the contract, so a nested page is a structural error, not a page — the git
  // walk must not enumerate it, matching the disk walk and the status count.
  const root = tmpRepo();
  const repo = new VaultGit(root);
  await repo.init();
  writeFile(root, "wiki/concepts/a.md", "one\n");
  writeFile(root, "wiki/concepts/nested/deep.md", "nested\n");
  writeFile(root, "wiki/loose.md", "loose\n");
  await commitAll(root, "first");

  const snap = await repo.committedPages("");
  const byRef = pagesByRef(snap);
  assert.deepEqual([...byRef.keys()], ["wiki/concepts/a.md"]);
});

test("committedPages is lenient on a non-repo (empty Snapshot)", async () => {
  const snap = await new VaultGit(tmpRepo()).committedPages("");
  assert.deepEqual(snap, { head: "", fullRebuild: false, pages: [] });
});

test("committedPages is lenient on an empty (no-commit) repo", async () => {
  const root = tmpRepo();
  const repo = new VaultGit(root);
  await repo.init();
  const snap = await repo.committedPages("");
  assert.deepEqual(snap, { head: "", fullRebuild: false, pages: [] });
});

// ---------------------------------------------------------------------------
// CommittedPages: range walk
// ---------------------------------------------------------------------------

test("committedPages range enumerates only changed paths", async () => {
  const root = tmpRepo();
  const repo = new VaultGit(root);
  await repo.init();
  writeFile(root, "wiki/concepts/a.md", "one\n");
  writeFile(root, "wiki/concepts/b.md", "b\n");
  await commitAll(root, "first");

  const first = await repo.committedPages("");
  const watermark = first.head;

  writeFile(root, "wiki/concepts/a.md", "one, edited\n");
  await commitAll(root, "second");

  const snap = await repo.committedPages(watermark);
  assert.equal(snap.fullRebuild, false, "reachable watermark must not rebuild");
  assert.notEqual(snap.head, watermark, "head must advance past watermark");
  const byRef = pagesByRef(snap);
  assert.deepEqual([...byRef.keys()], ["wiki/concepts/a.md"]);
  assert.equal(byRef.get("wiki/concepts/a.md")!.content, "one, edited\n");
});

test("committedPages range ignores a change to wiki/_index.md (#310)", async () => {
  // A commit touching only the generated index is not a page change, so the
  // range walk reports nothing — the index can never be indexed or counted.
  const root = tmpRepo();
  const repo = new VaultGit(root);
  await repo.init();
  writeFile(root, "wiki/concepts/a.md", "one\n");
  await commitAll(root, "first");
  const first = await repo.committedPages("");
  const watermark = first.head;

  writeFile(root, "wiki/_index.md", "generated table of contents\n");
  await commitAll(root, "second");

  const snap = await repo.committedPages(watermark);
  assert.equal(snap.fullRebuild, false);
  assert.deepEqual(snap.pages, [], "index artifact is not a page change");
});

test("committedPages at HEAD is a no-op", async () => {
  const root = tmpRepo();
  const repo = new VaultGit(root);
  await repo.init();
  writeFile(root, "wiki/concepts/a.md", "one\n");
  await commitAll(root, "first");
  const head = await repo.committedPages("");

  const snap = await repo.committedPages(head.head);
  assert.equal(snap.fullRebuild, false);
  assert.equal(snap.head, head.head);
  assert.deepEqual(snap.pages, []);
});

test("committedPages falls back to a full read on an unreachable watermark", async () => {
  const root = tmpRepo();
  const repo = new VaultGit(root);
  await repo.init();
  writeFile(root, "wiki/concepts/a.md", "one\n");
  await commitAll(root, "first");

  const snap = await repo.committedPages(
    "0000000000000000000000000000000000000000",
  );
  assert.equal(snap.fullRebuild, true);
  assert.ok(pagesByRef(snap).has("wiki/concepts/a.md"));
});

test("committedPages range enumerates deletions", async () => {
  const root = tmpRepo();
  const repo = new VaultGit(root);
  await repo.init();
  writeFile(root, "wiki/concepts/a.md", "one\n");
  await commitAll(root, "first");
  const first = await repo.committedPages("");

  removeFile(root, "wiki/concepts/a.md");
  await commitAll(root, "second");

  const snap = await repo.committedPages(first.head);
  const page = pagesByRef(snap).get("wiki/concepts/a.md");
  assert.ok(page, "a.md should be enumerated as deleted");
  assert.equal(page!.deleted, true);
  assert.equal(page!.content, "");
});

test("committedPages reads changed path from HEAD, not intermediate commits", async () => {
  const root = tmpRepo();
  const repo = new VaultGit(root);
  await repo.init();
  writeFile(root, "wiki/concepts/a.md", "v1\n");
  await commitAll(root, "first");
  const first = await repo.committedPages("");

  writeFile(root, "wiki/concepts/a.md", "v2\n");
  await commitAll(root, "second");
  writeFile(root, "wiki/concepts/a.md", "v3\n");
  await commitAll(root, "third");

  const snap = await repo.committedPages(first.head);
  const byRef = pagesByRef(snap);
  assert.deepEqual(
    [...byRef.keys()],
    ["wiki/concepts/a.md"],
    "enumerated once",
  );
  assert.equal(byRef.get("wiki/concepts/a.md")!.content, "v3\n");
});

// ---------------------------------------------------------------------------
// CommittedPages: merge-commit rules
// ---------------------------------------------------------------------------

/**
 * Create branch `branch` off master, switch to it, write `file`=`content`,
 * commit, and return the branch head — leaving the worktree back on master.
 */
async function mergeBranch(
  repoRoot: string,
  branch: string,
  file: string,
  content: string,
  message: string,
  signature: ReturnType<typeof deterministicSignature>,
): Promise<string> {
  await git.branch({ fs, dir: repoRoot, ref: branch });
  await git.checkout({ fs, dir: repoRoot, ref: branch });
  writeFile(repoRoot, file, content);
  await commitAll(repoRoot, message, signature);
  const head = await git.resolveRef({ fs, dir: repoRoot, ref: "HEAD" });
  await git.checkout({ fs, dir: repoRoot, ref: "master" });
  return head;
}

/**
 * Build a real two-parent merge commit with `git.commit({ parent: [...] })`,
 * exactly what `git merge` produces.
 */

test("merge commit-changed paths are enumerated but merge commits don't date them", async () => {
  const root = tmpRepo();
  const repo = new VaultGit(root);
  await repo.init();
  writeFile(root, "wiki/concepts/base.md", "base\n");
  writeFile(root, "wiki/concepts/conflict.md", "base version\n");
  await commitAll(root, "base", deterministicSignature(1));
  const base = await repo.committedPages("");

  // feature branch changes conflict.md
  const featureHead = await mergeBranch(
    root,
    "feature",
    "wiki/concepts/conflict.md",
    "feature version\n",
    "feature change",
    deterministicSignature(1),
  );
  // main branch changes conflict.md too — hour 25 lands this on 2026-01-02,
  // a day after the (hour-3, 2026-01-01) merge commit, so the assertion below
  // proves the date comes from the non-merge commit, not the merge.
  writeFile(root, "wiki/concepts/conflict.md", "main version\n");
  await commitAll(root, "main change", deterministicSignature(25));
  const mainHead = await git.resolveRef({ fs, dir: root, ref: "HEAD" });

  // Simulate the merge's conflict resolution: write the merged result, stage
  // it, and commit with both branch tips as parents.
  const boundaryRoot = root;
  writeFile(boundaryRoot, "wiki/concepts/conflict.md", "merged version\n");
  await git.add({ fs, dir: root, filepath: "." });
  const mergeHash = await git.commit({
    fs,
    dir: root,
    message: "merge feature",
    parent: [mainHead, featureHead],
    author: deterministicSignature(3),
    committer: deterministicSignature(3),
  });
  await git.writeRef({
    fs,
    dir: root,
    ref: "refs/heads/master",
    value: mergeHash,
    force: true,
  });

  const snap = await repo.committedPages(base.head);
  const byRef = pagesByRef(snap);
  const page = byRef.get("wiki/concepts/conflict.md");
  assert.ok(page, "conflict.md enumerated from the merge commit's own diff");
  assert.equal(
    page!.content,
    "merged version\n",
    "content is HEAD's merge blob",
  );
  // Merge commit itself must not attribute the date; the non-merge "main
  // change" commit (later of the two non-merge contributors) does.
  assert.equal(page!.date, "2026-01-02");
  // base.md is untouched by the merge range, so it must not appear.
  assert.ok(!byRef.has("wiki/concepts/base.md"));
});

test("committedPages attributes a date across a merge second parent", async () => {
  const root = tmpRepo();
  const repo = new VaultGit(root);
  await repo.init();
  writeFile(root, "wiki/concepts/base.md", "base\n");
  await commitAll(root, "base", deterministicSignature(1));
  const base = await repo.committedPages("");

  // feature branch adds x.md — hour 25 lands this on 2026-01-02
  const featureHead = await mergeBranch(
    root,
    "feature",
    "wiki/concepts/x.md",
    "x\n",
    "add x",
    deterministicSignature(25),
  );
  // main branch adds y.md
  writeFile(root, "wiki/concepts/y.md", "y\n");
  await commitAll(root, "add y", deterministicSignature(2));
  const mainHead = await git.resolveRef({ fs, dir: root, ref: "HEAD" });

  // Merge (no conflict): both x.md and y.md present in the merge tree — write
  // x.md back after the checkout to master removed it.
  writeFile(root, "wiki/concepts/x.md", "x\n");
  await git.add({ fs, dir: root, filepath: "." });
  const mergeHash = await git.commit({
    fs,
    dir: root,
    message: "merge feature",
    parent: [mainHead, featureHead],
    author: deterministicSignature(3),
    committer: deterministicSignature(3),
  });
  await git.writeRef({
    fs,
    dir: root,
    ref: "refs/heads/master",
    value: mergeHash,
    force: true,
  });

  const snap = await repo.committedPages(base.head);
  const byRef = pagesByRef(snap);
  const x = byRef.get("wiki/concepts/x.md");
  assert.ok(x, "x.md enumerated via the merge's own diff");
  assert.equal(
    x!.date,
    "2026-01-02",
    "x.md dated from the feature-branch commit",
  );
});

test("committedPages range falls back behind a merge for a page it can't date (#491)", async () => {
  // A page the bounded walk surfaces but can't date: only the merge touches it
  // inside the range, and the commit that introduced it sits on a side branch
  // older than the watermark — so the walk stops at `since` before reaching
  // it. The fallback must find that commit through the shared rule, whose
  // whole point is that a merge is skipped *over*, never read as "no date".
  const root = tmpRepo();
  const repo = new VaultGit(root);
  await repo.init();
  writeFile(root, "wiki/concepts/seed.md", "seed\n");
  await commitAll(root, "seed", deterministicSignature(1));

  // Feature branch (off hour 1) adds the page at hour 1.5 — older than the
  // watermark below, so the range walk never credits it.
  const featureHead = await mergeBranch(
    root,
    "feature-fallback",
    "wiki/concepts/aged.md",
    "aged\n",
    "feature add aged",
    deterministicSignature(1.5),
  );

  // Watermark: hour 2. Then a master commit inside the range, so the merge has
  // a non-empty range to walk.
  writeFile(root, "wiki/concepts/noted.md", "noted\n");
  await commitAll(root, "main add noted", deterministicSignature(2));
  const watermark = await git.resolveRef({ fs, dir: root, ref: "HEAD" });
  writeFile(root, "wiki/concepts/other.md", "other\n");
  await commitAll(root, "main add other", deterministicSignature(3));
  const rangeHead = await git.resolveRef({ fs, dir: root, ref: "HEAD" });

  // The merge brings aged.md across (checkout to master removed it), so its
  // own diff against its first parent surfaces the page.
  writeFile(root, "wiki/concepts/aged.md", "aged\n");
  await git.add({ fs, dir: root, filepath: "." });
  const mergeHash = await git.commit({
    fs,
    dir: root,
    message: "merge feature-fallback",
    parent: [rangeHead, featureHead],
    author: deterministicSignature(25),
    committer: deterministicSignature(25),
  });
  await git.writeRef({
    fs,
    dir: root,
    ref: "refs/heads/master",
    value: mergeHash,
    force: true,
  });

  const snap = await repo.committedPages(watermark);
  const aged = pagesByRef(snap).get("wiki/concepts/aged.md");
  assert.ok(aged, "aged.md enumerated from the merge's own diff");
  assert.equal(
    aged!.date,
    "2026-01-01",
    "dated from the commit behind the merge, not the merge and not empty",
  );
});

// ---------------------------------------------------------------------------
// LastCommitDate
// ---------------------------------------------------------------------------
test("lastCommitDate returns a date for a committed path", async () => {
  const root = tmpRepo();
  const repo = new VaultGit(root);
  await repo.init();
  writeFile(root, "raw/notes.md", "raw\n");
  await commitAll(root, "first", deterministicSignature(1));
  const got = await repo.lastCommitDate("raw/notes.md");
  assert.match(got, /^\d{4}-\d{2}-\d{2}$/);
});

test("lastCommitDate tracks the latest commit (strictly-newer)", async () => {
  const root = tmpRepo();
  const repo = new VaultGit(root);
  await repo.init();
  writeFile(root, "raw/notes.md", "v1\n");
  await commitAll(root, "first", deterministicSignature(1));
  const first = await repo.lastCommitDate("raw/notes.md");

  // Deterministic timestamps that cross a day boundary: hour 1 (2026-01-01)
  // vs hour 25 (2026-01-02), so the dates are distinguishable.
  writeFile(root, "raw/notes.md", "v2\n");
  await commitAll(root, "second", deterministicSignature(25));
  const second = await repo.lastCommitDate("raw/notes.md");
  assert.notEqual(second, first);
});

test("lastCommitDate is empty for an untracked / never-committed path", async () => {
  const root = tmpRepo();
  const repo = new VaultGit(root);
  await repo.init();
  assert.equal(await repo.lastCommitDate("raw/nope.md"), "");
});

test("lastCommitDate is lenient on a non-repo", async () => {
  assert.equal(
    await new VaultGit(tmpRepo()).lastCommitDate("raw/notes.md"),
    "",
  );
});

/**
 * A repo whose newest commit touching `wiki/concepts/merge-only.md` is a
 * merge. The feature branch adds the page at hour 2 (2026-01-01); master gains
 * an unrelated page; the two-parent merge at `mergeHours` writes the page back
 * — the shape `git merge` leaves for a page only one side ever had, and for a
 * conflict resolution both sides touched. The page's only non-merge
 * contributor is therefore the feature commit.
 *
 * `mergeHours` is the test's whole point: pass one on a *different day* from
 * hour 2 and the merge commit's own diff touches the page, so a
 * merge-inclusive read is distinguishable from a merge-excluded one.
 */
async function newestTouchingCommitIsAMerge(mergeHours: number): Promise<{
  repo: VaultGit;
  pageRef: string;
}> {
  const root = tmpRepo();
  const repo = new VaultGit(root);
  await repo.init();
  writeFile(root, "wiki/concepts/base.md", "base\n");
  await commitAll(root, "base", deterministicSignature(1));

  const featureHead = await mergeBranch(
    root,
    "feature-merge",
    "wiki/concepts/merge-only.md",
    "merge-only\n",
    "feature add merge-only",
    deterministicSignature(2),
  );
  // master's own commit, so the merge is a genuine two-sided merge rather
  // than a fast-forwardable one.
  writeFile(root, "wiki/concepts/other.md", "other\n");
  await commitAll(root, "main add other", deterministicSignature(10));
  const mainHead = await git.resolveRef({ fs, dir: root, ref: "HEAD" });

  // Merge: write merge-only.md back (checkout to master removed it), commit
  // with both branch tips as parents.
  writeFile(root, "wiki/concepts/merge-only.md", "merge-only\n");
  await git.add({ fs, dir: root, filepath: "." });
  const mergeHash = await git.commit({
    fs,
    dir: root,
    message: "merge feature-merge",
    parent: [mainHead, featureHead],
    author: deterministicSignature(mergeHours),
    committer: deterministicSignature(mergeHours),
  });
  await git.writeRef({
    fs,
    dir: root,
    ref: "refs/heads/master",
    value: mergeHash,
    force: true,
  });
  return { repo, pageRef: "wiki/concepts/merge-only.md" };
}

test("lastCommitDate does not attribute a merge commit (pruning rewrite, #419)", async () => {
  // merge-only.md first appeared on the feature branch (non-merge commit at
  // hour 2), but HEAD points to a merge commit a day later (hour 25). The
  // merge's own diff against its first parent touches the page, so an
  // unfiltered read returns 2026-01-02: the merge must not attribute a date,
  // and the feature-branch non-merge commit must.
  const { repo, pageRef } = await newestTouchingCommitIsAMerge(25);
  const date = await repo.lastCommitDate(pageRef);
  assert.equal(date, "2026-01-01", "date from non-merge feature commit");
});

test("lastCommitDate and the sweep's ScanFacts agree on a merge-only path (#491)", async () => {
  // The same path read two ways: the sweep reads precomputed maps
  // (ScanFacts, batched by #415), check.ts's staleSynthesis walks per call.
  // They must answer from the one rule — a merge sets no date, and the
  // non-merge commit behind it does (#491).
  const { repo, pageRef } = await newestTouchingCommitIsAMerge(25);
  const viaRepo = await repo.lastCommitDate(pageRef);
  const viaFacts = await (await repo.scanFacts()).lastCommitDate(pageRef);
  assert.equal(viaRepo, viaFacts, "the per-file read and the sweep must agree");
  assert.equal(
    viaFacts,
    "2026-01-01",
    "the merge is skipped over, not treated as no date",
  );
});

// ---------------------------------------------------------------------------
// PorcelainMentions
// ---------------------------------------------------------------------------

test("porcelainMentions reports an untracked file", async () => {
  const root = tmpRepo();
  const repo = new VaultGit(root);
  await repo.init();
  writeFile(root, "raw/notes.md", "raw\n");
  assert.equal(await repo.porcelainMentions("raw/notes.md"), true);
});

test("porcelainMentions reports a modified file", async () => {
  const root = tmpRepo();
  const repo = new VaultGit(root);
  await repo.init();
  writeFile(root, "raw/notes.md", "raw\n");
  await commitAll(root, "first");
  writeFile(root, "raw/notes.md", "raw, edited\n");
  assert.equal(await repo.porcelainMentions("raw/notes.md"), true);
});

test("porcelainMentions is false for a clean committed file", async () => {
  const root = tmpRepo();
  const repo = new VaultGit(root);
  await repo.init();
  writeFile(root, "raw/notes.md", "raw\n");
  await commitAll(root, "first");
  assert.equal(await repo.porcelainMentions("raw/notes.md"), false);
});

test("porcelainMentions ignores a CRLF/LF-only difference (autocrlf clean checkout)", async () => {
  // Under core.autocrlf=true (the Windows norm) a clean checkout stores LF in
  // the blob but writes CRLF to the working tree. isomorphic-git's status()
  // doesn't apply autocrlf reliably and would report this as *modified; the
  // working-tree-vs-blob comparison here must treat it as clean.
  const root = tmpRepo();
  const repo = new VaultGit(root);
  await repo.init();
  writeFile(root, "raw/notes.txt", "line one\nline two\n");
  await commitAll(root, "first");
  writeFile(root, "raw/notes.txt", "line one\r\nline two\r\n");
  assert.equal(await repo.porcelainMentions("raw/notes.txt"), false);
});

test("porcelainMentions still reports a real change on a CRLF file", async () => {
  const root = tmpRepo();
  const repo = new VaultGit(root);
  await repo.init();
  writeFile(root, "raw/notes.txt", "line one\nline two\n");
  await commitAll(root, "first");
  writeFile(root, "raw/notes.txt", "line one\r\nline two EDITED\r\n");
  assert.equal(await repo.porcelainMentions("raw/notes.txt"), true);
});

test("porcelainMentions is lenient on a non-repo", async () => {
  assert.equal(
    await new VaultGit(tmpRepo()).porcelainMentions("raw/notes.md"),
    false,
  );
});

test("porcelainMentions reports a staged (git add) modification (#366)", async () => {
  const root = tmpRepo();
  const repo = new VaultGit(root);
  await repo.init();
  writeFile(root, "raw/notes.md", "original\n");
  await commitAll(root, "first");
  writeFile(root, "raw/notes.md", "modified\n");
  await git.add({ fs, dir: root, filepath: "raw/notes.md" });
  // Working tree and index both have new content; HEAD has original.
  assert.equal(await repo.porcelainMentions("raw/notes.md"), true);
});

// ---------------------------------------------------------------------------
// stageAndCommit — concurrent-safety (#405)
// ---------------------------------------------------------------------------

test("stageAndCommit: two concurrent calls each commit exactly their own paths", async () => {
  const root = tmpRepo();
  const repo = new VaultGit(root);
  await repo.init();

  // Prime the repo with an initial commit so HEAD exists.
  writeFile(root, "wiki/concepts/seed.md", "seed\n");
  await commitAll(root, "seed");

  // Write both plans' pages to disk without staging.
  writeFile(root, "wiki/concepts/a.md", "a content\n");
  writeFile(root, "wiki/concepts/b.md", "b content\n");

  // Fire both stageAndCommit calls concurrently — no await between them.
  const [shaA, shaB] = await Promise.all([
    repo.stageAndCommit(
      ["wiki/concepts/a.md"],
      "ingest: A\n\ncreated: wiki/concepts/a.md\n",
    ),
    repo.stageAndCommit(
      ["wiki/concepts/b.md"],
      "ingest: B\n\ncreated: wiki/concepts/b.md\n",
    ),
  ]);

  // Both commits must be distinct, non-empty SHAs.
  assert.match(shaA, /^[0-9a-f]{40}$/);
  assert.match(shaB, /^[0-9a-f]{40}$/);
  assert.notEqual(shaA, shaB);

  // Each commit must contain exactly its own pages — no empty commits, no
  // cross-contamination.
  const log = await git.log({ fs, dir: root });
  // log[0] and log[1] are the two ingest commits (order not deterministic);
  // log[2] is "seed".
  const commitMessages = log.slice(0, 2).map((c) => c.commit.message);
  assert.ok(
    commitMessages.some((m) => m.includes("ingest: A")),
    "A's commit must be in history",
  );
  assert.ok(
    commitMessages.some((m) => m.includes("ingest: B")),
    "B's commit must be in history",
  );
});

// ---------------------------------------------------------------------------
// dirtyFiles
// ---------------------------------------------------------------------------

test("dirtyFiles returns [] for a non-git directory (lenient)", async () => {
  const root = tmpRepo();
  const repo = new VaultGit(root);
  const dirty = await repo.dirtyFiles(["wiki/"]);
  assert.deepEqual(dirty, []);
});

test("dirtyFiles returns [] when the subtree is clean", async () => {
  const root = tmpRepo();
  const repo = new VaultGit(root);
  await git.init({ fs, dir: root });
  writeFile(root, "wiki/concepts/foo.md", "# Foo\n");
  await commitAll(root, "seed");

  const dirty = await repo.dirtyFiles(["wiki/"]);
  assert.deepEqual(dirty, []);
});

test("dirtyFiles detects an untracked file in the subtree", async () => {
  const root = tmpRepo();
  const repo = new VaultGit(root);
  await git.init({ fs, dir: root });
  writeFile(root, "wiki/concepts/foo.md", "# Foo\n");
  await commitAll(root, "seed");

  // Add a new untracked file
  writeFile(root, "wiki/concepts/bar.md", "# Bar\n");

  const dirty = await repo.dirtyFiles(["wiki/"]);
  assert.equal(dirty.length, 1);
  assert.ok(dirty[0].includes("bar.md"), `expected bar.md in dirty: ${dirty}`);
});

test("dirtyFiles detects a modified tracked file", async () => {
  const root = tmpRepo();
  const repo = new VaultGit(root);
  await git.init({ fs, dir: root });
  writeFile(root, "wiki/concepts/foo.md", "# Foo\n");
  await commitAll(root, "seed");

  fs.writeFileSync(path.join(root, "wiki/concepts/foo.md"), "# Foo modified\n");

  const dirty = await repo.dirtyFiles(["wiki/"]);
  assert.equal(dirty.length, 1);
  assert.ok(dirty[0].includes("foo.md"), `expected foo.md in dirty: ${dirty}`);
});

test("dirtyFiles detects a staged file", async () => {
  const root = tmpRepo();
  const repo = new VaultGit(root);
  await git.init({ fs, dir: root });
  writeFile(root, "wiki/concepts/foo.md", "# Foo\n");
  await commitAll(root, "seed");

  writeFile(root, "wiki/concepts/bar.md", "# Bar\n");
  await git.add({ fs, dir: root, filepath: "wiki/concepts/bar.md" });

  const dirty = await repo.dirtyFiles(["wiki/"]);
  assert.equal(dirty.length, 1);
  assert.ok(dirty[0].includes("bar.md"), `expected bar.md in dirty: ${dirty}`);
});

test("dirtyFiles scopes to wiki/ — raw/ changes not reported when raw/ excluded", async () => {
  const root = tmpRepo();
  const repo = new VaultGit(root);
  await git.init({ fs, dir: root });
  writeFile(root, "wiki/concepts/foo.md", "# Foo\n");
  writeFile(root, "raw/inbox/doc.md", "raw content\n");
  await commitAll(root, "seed");

  // Modify raw file only
  fs.writeFileSync(path.join(root, "raw/inbox/doc.md"), "modified raw\n");

  const dirty = await repo.dirtyFiles(["wiki/"]);
  assert.deepEqual(dirty, [], "wiki/ scope should not see raw/ changes");

  const dirtyWithRaw = await repo.dirtyFiles(["wiki/", "raw/"]);
  assert.equal(
    dirtyWithRaw.length,
    1,
    "wiki/+raw/ scope should see raw/ changes",
  );
  assert.ok(dirtyWithRaw[0].includes("doc.md"));
});
