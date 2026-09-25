/**
 * Integration tests for vaultgit, against real isomorphic-git repositories in
 * temp directories.
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

/** Write `content` to vault-relative `rel`, creating parents. */
function writeFile(root: string, rel: string, content: string): void {
  const p = path.join(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function removeFile(root: string, rel: string): void {
  fs.rmSync(path.join(root, rel));
}

function deterministicSignature(offsetHours: number) {
  // Distinct per commit so date attribution is testable: base + offsetHours.
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
 * Stage the whole worktree including deletions — raw `git.add` alone won't
 * stage a removal.
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

test("add stages a tracked file missing on disk as a removal", async () => {
  const root = tmpRepo();
  const repo = new VaultGit(root);
  await repo.init();
  writeFile(root, "wiki/concepts/a.md", "one\n");
  await repo.add(["wiki/concepts/a.md"]);
  await repo.commit("first");

  // A Consolidation deletes its losers before committing, so the staged path
  // names a file that is gone — a removal, not a typo (ADR-0021).
  removeFile(root, "wiki/concepts/a.md");
  await repo.add(["wiki/concepts/a.md"]);
  const sha = await repo.commit("second");

  const log = await git.log({ fs, dir: root, depth: 1 });
  assert.equal(log[0].oid, sha);
  const head = await git.listFiles({ fs, dir: root, ref: "HEAD" });
  assert.deepEqual(
    head.filter((file) => file.endsWith(".md")),
    [],
  );
});

test("add still throws for a path git has never tracked", async () => {
  const root = tmpRepo();
  const repo = new VaultGit(root);
  await repo.init();
  writeFile(root, "wiki/concepts/a.md", "one\n");
  await repo.add(["wiki/concepts/a.md"]);
  await repo.commit("first");

  await assert.rejects(() => repo.add(["wiki/concepts/missing.md"]));
});

test("commit throws when there is nothing to commit (strict)", async () => {
  const root = tmpRepo();
  const repo = new VaultGit(root);
  await repo.init();
  await assert.rejects(() => repo.commit("empty"));
});

test("commit falls back to OS-user@hostname without error", async () => {
  // A freshly-initialised repo has no user.name/user.email.
  const root = tmpRepo();
  const repo = new VaultGit(root);
  await repo.init();
  writeFile(root, "wiki/concepts/a.md", "one\n");
  await repo.add(["."]);
  const sha = await repo.commit("first");
  assert.match(sha, /^[0-9a-f]{40}$/);

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
  // The generated index artifact is never a page, even when committed
  // (ADR-0015).
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
  // A nested page is a structural error, not a page — the git walk must match
  // the disk walk.
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
  // A commit touching only the generated index is not a page change.
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

  const featureHead = await mergeBranch(
    root,
    "feature",
    "wiki/concepts/conflict.md",
    "feature version\n",
    "feature change",
    deterministicSignature(1),
  );
  // Hour 25 lands this on 2026-01-02, a day after the hour-3 merge, so the
  // assertion below proves the date comes from the non-merge commit.
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
  // Merge commit must not attribute the date; the later non-merge "main change"
  // commit does.
  assert.equal(page!.date, "2026-01-02");
  assert.ok(!byRef.has("wiki/concepts/base.md"));
});

test("committedPages attributes a date across a merge second parent", async () => {
  const root = tmpRepo();
  const repo = new VaultGit(root);
  await repo.init();
  writeFile(root, "wiki/concepts/base.md", "base\n");
  await commitAll(root, "base", deterministicSignature(1));
  const base = await repo.committedPages("");

  // Feature branch adds x.md at hour 25 — 2026-01-02.
  const featureHead = await mergeBranch(
    root,
    "feature",
    "wiki/concepts/x.md",
    "x\n",
    "add x",
    deterministicSignature(25),
  );
  writeFile(root, "wiki/concepts/y.md", "y\n");
  await commitAll(root, "add y", deterministicSignature(2));
  const mainHead = await git.resolveRef({ fs, dir: root, ref: "HEAD" });

  // Both x.md and y.md are in the merge tree; write x.md back after the
  // checkout to master removed it.
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
  // Only the merge touches this page inside the range, and the commit that
  // introduced it sits on a side branch older than the watermark — so the walk
  // stops at `since` before reaching it. The fallback must find that commit
  // through the shared rule: a merge is skipped *over*, never read as "no date".
  const root = tmpRepo();
  const repo = new VaultGit(root);
  await repo.init();
  writeFile(root, "wiki/concepts/seed.md", "seed\n");
  await commitAll(root, "seed", deterministicSignature(1));

  // Feature add at hour 1.5 — older than the watermark, so never credited by
  // the range walk.
  const featureHead = await mergeBranch(
    root,
    "feature-fallback",
    "wiki/concepts/aged.md",
    "aged\n",
    "feature add aged",
    deterministicSignature(1.5),
  );

  // Watermark hour 2; a later master commit gives the merge a non-empty range.
  writeFile(root, "wiki/concepts/noted.md", "noted\n");
  await commitAll(root, "main add noted", deterministicSignature(2));
  const watermark = await git.resolveRef({ fs, dir: root, ref: "HEAD" });
  writeFile(root, "wiki/concepts/other.md", "other\n");
  await commitAll(root, "main add other", deterministicSignature(3));
  const rangeHead = await git.resolveRef({ fs, dir: root, ref: "HEAD" });

  // The merge brings aged.md across (the checkout to master removed it), so its
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

  // Hour 1 (2026-01-01) vs hour 25 (2026-01-02) — distinguishable dates.
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
 * A repo whose newest commit touching `wiki/concepts/merge-only.md` is a merge:
 * the page's only non-merge contributor is the feature commit at hour 2.
 *
 * `mergeHours` must be on a different day from hour 2 so the merge's own diff
 * touches the page, making a merge-inclusive read distinguishable from a
 * merge-excluded one.
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
  // master's own commit, so the merge is genuinely two-sided.
  writeFile(root, "wiki/concepts/other.md", "other\n");
  await commitAll(root, "main add other", deterministicSignature(10));
  const mainHead = await git.resolveRef({ fs, dir: root, ref: "HEAD" });

  // Write merge-only.md back (the checkout to master removed it) and commit with
  // both branch tips as parents.
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
  // merge-only.md's only non-merge commit is at hour 2; HEAD is a merge a day
  // later (hour 25) whose diff touches the page. An unfiltered read would return
  // 2026-01-02, so this proves the merge is excluded.
  const { repo, pageRef } = await newestTouchingCommitIsAMerge(25);
  const date = await repo.lastCommitDate(pageRef);
  assert.equal(date, "2026-01-01", "date from non-merge feature commit");
});

test("lastCommitDate and the sweep's ScanFacts agree on a merge-only path (#491)", async () => {
  // The same path read two ways must agree on the one rule: a merge sets no
  // date, the non-merge commit behind it does.
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
  // Under core.autocrlf=true a clean checkout stores LF in the blob but writes
  // CRLF on disk; isomorphic-git's status() would misreport this as *modified.
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
  assert.equal(await repo.porcelainMentions("raw/notes.md"), true);
});

// ---------------------------------------------------------------------------
// stageAndCommit — concurrent safety
// ---------------------------------------------------------------------------

test("stageAndCommit: two concurrent calls each commit exactly their own paths", async () => {
  const root = tmpRepo();
  const repo = new VaultGit(root);
  await repo.init();

  writeFile(root, "wiki/concepts/seed.md", "seed\n");
  await commitAll(root, "seed");

  writeFile(root, "wiki/concepts/a.md", "a content\n");
  writeFile(root, "wiki/concepts/b.md", "b content\n");

  // Fire both concurrently — no await between them.
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

  const log = await git.log({ fs, dir: root });
  // log[0..1] are the two ingest commits in nondeterministic order; log[2] is
  // "seed".
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
