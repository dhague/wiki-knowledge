/**
 * The lint body reader (ADR-0029): HEAD-pinned batch reads, the eligible-page
 * walk, and the per-run ledger that caches bodies and bounds the sweep.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as git from "isomorphic-git";
import { VaultGit } from "./vaultgit.js";
import {
  DefaultBudget,
  DefaultLimit,
  ErrBodies,
  ledgerPath,
  readBodies,
} from "./lintbodies.js";

const A = "wiki/concepts/a.md";
const B = "wiki/concepts/b.md";
const C = "wiki/concepts/c.md";

function page(title: string, body = "Body text.\n"): string {
  return `---\ntitle: ${title}\nsummary: ${title}.\n---\n${body}`;
}

/** Write a vault's files and commit them, so HEAD holds every page. */
async function committedVault(
  pages: Record<string, string>,
): Promise<{ root: string; head: string }> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enchiridion-bodies-"));
  for (const [rel, text] of Object.entries(pages)) {
    const abs = path.join(root, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  await git.init({ fs, dir: root });
  const head = await commit(root);
  return { root, head };
}

async function commit(root: string, message = "fixture"): Promise<string> {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === ".wiki-knowledge") continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else files.push(path.relative(root, abs).split(path.sep).join("/"));
    }
  };
  walk(root);
  await new VaultGit(root).add(files);
  return git.commit({
    fs,
    dir: root,
    message,
    author: {
      name: "t",
      email: "t@e.com",
      timestamp: 1700000000,
      timezoneOffset: 0,
    },
    committer: {
      name: "t",
      email: "t@e.com",
      timestamp: 1700000000,
      timezoneOffset: 0,
    },
  });
}

function refs(batch: { pages: Array<{ page_ref: string }> }): string[] {
  return batch.pages.map((page) => page.page_ref);
}

test("read-pages serves eligible bodies from one committed HEAD snapshot", async () => {
  const { root, head } = await committedVault({
    [A]: page("A"),
    [B]: page("B", "B's body.\n"),
  });

  const batch = await readBodies(root, { limit: 10 });

  assert.equal(batch.head, head);
  assert.deepEqual(refs(batch), [A, B]);
  assert.equal(batch.eligible, 2);
  assert.equal(batch.returned, 2);
  assert.equal(batch.next_after, null);
  assert.equal(batch.remaining, 0);
  assert.deepEqual(
    batch.pages.map((p) => p.body),
    ["Body text.\n", "B's body.\n"],
  );
  for (const body of batch.pages) {
    assert.match(body.blob_oid, /^[0-9a-f]{40}$/);
    assert.equal(body.bytes, Buffer.byteLength(body.body, "utf8"));
  }
});

test("eligibility is the page refs at HEAD: KIND.md, _index.md and a misplaced page are not pages", async () => {
  const { root } = await committedVault({
    [A]: page("A"),
    "wiki/concepts/KIND.md": "---\nkind: concept\n---\n",
    "wiki/_index.md": "# Index\n",
    "wiki/notes.md": page("Notes at the root"),
    "wiki/concepts/nested/deep.md": page("Nested"),
  });

  const batch = await readBodies(root, { limit: 10 });

  assert.deepEqual(refs(batch), [A]);
  assert.equal(batch.eligible, 1);
});

test("an uncommitted draft is not eligible", async () => {
  const { root } = await committedVault({ [A]: page("A") });
  const draft = path.join(root, "wiki", "concepts", "draft.md");
  fs.writeFileSync(draft, page("Draft"));

  const batch = await readBodies(root, { limit: 10 });

  assert.deepEqual(refs(batch), [A]);
});

test("--exclude drops the pages a mechanical check already flagged", async () => {
  const { root } = await committedVault({
    [A]: page("A"),
    [B]: page("B"),
    [C]: page("C"),
  });

  const batch = await readBodies(root, { limit: 10, exclude: [B] });

  assert.deepEqual(refs(batch), [A, C]);
  assert.equal(batch.eligible, 2);
});

test("a batch is bounded by --limit and the cursor continues without repeats", async () => {
  const { root } = await committedVault({
    [A]: page("A"),
    [B]: page("B"),
    [C]: page("C"),
  });

  const first = await readBodies(root, { limit: 2 });
  assert.deepEqual(refs(first), [A, B]);
  assert.equal(first.next_after, B);
  assert.equal(first.remaining, 1);

  const second = await readBodies(root, { limit: 2, after: first.next_after! });
  assert.deepEqual(refs(second), [C]);
  assert.equal(second.next_after, null);
  assert.equal(second.remaining, 0);
});

test("--limit defaults to a bounded batch", async () => {
  assert.equal(DefaultLimit, 12);
  assert.equal(DefaultBudget, 60);
  const pages: Record<string, string> = {};
  for (let i = 0; i < DefaultLimit + 3; i++) {
    pages[`wiki/concepts/p${String(i).padStart(2, "0")}.md`] = page(`P${i}`);
  }
  const { root } = await committedVault(pages);

  const batch = await readBodies(root);

  assert.equal(batch.returned, DefaultLimit);
  assert.equal(batch.remaining, 3);
});

test("--max-bytes bounds a batch, and one oversized page is still read", async () => {
  const { root } = await committedVault({
    [A]: page("A", "a".repeat(300)),
    [B]: page("B", "b".repeat(300)),
  });

  const bounded = await readBodies(root, { limit: 10, maxBytes: 400 });
  assert.deepEqual(refs(bounded), [A]);
  assert.equal(bounded.next_after, A);

  const { root: big } = await committedVault({
    [A]: page("A", "a".repeat(300)),
  });
  const oversized = await readBodies(big, { limit: 10, maxBytes: 50 });
  assert.deepEqual(refs(oversized), [A]);
});

test("a body read earlier in the run is served from the ledger and costs no budget", async () => {
  const { root } = await committedVault({ [A]: page("A"), [B]: page("B") });

  const explicit = await readBodies(root, { refs: [A] });
  assert.equal(explicit.pages[0].cached, false);
  assert.equal(explicit.budget.spent, 1);

  const batch = await readBodies(root, { limit: 10, budget: 2 });
  assert.deepEqual(refs(batch), [A, B]);
  assert.equal(batch.pages[0].cached, true);
  assert.equal(batch.pages[1].cached, false);
  assert.equal(batch.cached, 1);
  assert.equal(batch.budget.spent, 2);
  assert.equal(batch.budget.exhausted, false);
});

test("the run budget stops the sweep and reports exhaustion", async () => {
  const { root } = await committedVault({
    [A]: page("A"),
    [B]: page("B"),
    [C]: page("C"),
  });

  const batch = await readBodies(root, { limit: 10, budget: 2 });

  assert.deepEqual(refs(batch), [A, B]);
  assert.equal(batch.budget.spent, 2);
  assert.equal(batch.budget.cap, 2);
  assert.equal(batch.budget.exhausted, true);
  assert.equal(batch.remaining, 1);
  assert.equal(batch.next_after, B);

  // Spent already, so a later sweep adds nothing even with room in the batch.
  const stopped = await readBodies(root, { limit: 10, budget: 2, after: B });
  assert.deepEqual(refs(stopped), []);
  assert.equal(stopped.budget.exhausted, true);
});

test("--reset opens a fresh run: the cache is dropped and the budget restored", async () => {
  const { root } = await committedVault({ [A]: page("A"), [B]: page("B") });

  await readBodies(root, { limit: 10, budget: 1 });
  const reset = await readBodies(root, { limit: 10, budget: 1, reset: true });

  assert.deepEqual(refs(reset), [A]);
  assert.equal(reset.pages[0].cached, false);
  assert.equal(reset.budget.spent, 1);
});

test("a body is pinned to HEAD: an uncommitted edit is invisible, a commit invalidates the run", async () => {
  const { root } = await committedVault({ [A]: page("A", "First.\n") });
  const abs = path.join(root, A);

  await readBodies(root, { refs: [A] });
  fs.writeFileSync(abs, page("A", "Edited but uncommitted.\n"));

  const pinned = await readBodies(root, { refs: [A] });
  assert.match(pinned.pages[0].body, /First\./);
  assert.equal(pinned.pages[0].cached, true);

  await commit(root, "edit");
  const afterCommit = await readBodies(root, { refs: [A] });
  assert.match(afterCommit.pages[0].body, /Edited but uncommitted\./);
  assert.equal(afterCommit.pages[0].cached, false);
  // The ledger is per-HEAD, so a moved HEAD starts the run over.
  assert.equal(afterCommit.budget.spent, 1);
});

test("an explicit ref that is not a committed page fails, naming it", async () => {
  const { root } = await committedVault({ [A]: page("A") });

  await assert.rejects(
    () => readBodies(root, { refs: [A, "wiki/concepts/absent.md"] }),
    (err: unknown) =>
      err instanceof ErrBodies &&
      /wiki\/concepts\/absent\.md/.test(err.message),
  );
  await assert.rejects(
    () => readBodies(root, { refs: ["wiki/notes.md"] }),
    (err: unknown) => err instanceof ErrBodies,
  );
});

test("an explicit read is never truncated by a batch cap", async () => {
  const { root } = await committedVault({
    [A]: page("A", "a".repeat(300)),
    [B]: page("B", "b".repeat(300)),
    [C]: page("C", "c".repeat(300)),
  });

  const batch = await readBodies(root, {
    refs: [A, B, C],
    limit: 1,
    maxBytes: 1,
    budget: 1,
  });

  assert.deepEqual(refs(batch), [A, B, C]);
  assert.equal(batch.next_after, null);
});

test("a page whose frontmatter a check refuses is still eligible", async () => {
  // `related: junk` is not a markdown link, so no page record parses — but the
  // page has a body, and dropping it would hide it from the sweep's coverage.
  const { root } = await committedVault({
    [A]: page("A"),
    [B]: "---\ntitle: B\nrelated: junk\n---\nB's body.\n",
  });

  const batch = await readBodies(root, { limit: 10 });

  assert.deepEqual(refs(batch), [A, B]);
  assert.equal(batch.eligible, 2);
  assert.equal(batch.pages[1].body, "B's body.\n");
});

test("an explicit read serves a page the sweep would exclude", async () => {
  const { root } = await committedVault({ [A]: page("A"), [B]: page("B") });

  const sweep = await readBodies(root, { limit: 10, exclude: [B] });
  assert.deepEqual(refs(sweep), [A]);

  const explicit = await readBodies(root, { refs: [B] });
  assert.deepEqual(refs(explicit), [B]);
});

test("a malformed ledger fails open and is rewritten", async () => {
  const { root } = await committedVault({ [A]: page("A") });
  const file = ledgerPath(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "not json at all");

  const batch = await readBodies(root, { refs: [A] });

  assert.equal(batch.budget.spent, 1);
  assert.deepEqual(
    Object.keys(JSON.parse(fs.readFileSync(file, "utf8")).pages),
    [A],
  );
});

test("the ledger holds every body the run read, with its revision", async () => {
  const { root } = await committedVault({ [A]: page("A"), [B]: page("B") });

  const batch = await readBodies(root, { refs: [A, B] });
  const ledger = JSON.parse(fs.readFileSync(ledgerPath(root), "utf8"));

  assert.equal(ledger.head, batch.head);
  assert.equal(ledger.spent, 2);
  for (const body of batch.pages) {
    assert.deepEqual(ledger.pages[body.page_ref], {
      blob_oid: body.blob_oid,
      title: body.title,
      bytes: body.bytes,
      body: body.body,
    });
  }
});
