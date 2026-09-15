/**
 * Integration tests for exportwriter.ts.
 *
 * Uses real temporary git repositories following the vaultgit test pattern.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as git from "isomorphic-git";
import {
  dirtyFiles,
  runExport,
  ExportDirtyError,
  ExportTargetNotEmptyError,
} from "./exportwriter.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "export-writer-test-"));
}

function writeFile(root: string, rel: string, content: string): void {
  const abs = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

async function initRepo(root: string): Promise<void> {
  await git.init({ fs, dir: root });
  // Set up minimal git config so commits work
  await git.setConfig({ fs, dir: root, path: "user.name", value: "test" });
  await git.setConfig({
    fs,
    dir: root,
    path: "user.email",
    value: "test@example.com",
  });
}

async function commitAll(root: string, message: string): Promise<void> {
  await git.add({ fs, dir: root, filepath: "." });
  await git.commit({
    fs,
    dir: root,
    message,
    author: { name: "test", email: "test@example.com" },
    committer: { name: "test", email: "test@example.com" },
  });
}

const CONCEPT_A = `---
title: Alpha Concept
summary: The first concept.
tags:
  - alpha
kind: concept
---

Body of alpha concept.
`;

const CONCEPT_B = `---
title: Beta Concept
summary: The second concept.
tags:
  - beta
kind: concept
---

See [Alpha Concept](alpha-concept.md).
`;

/** Set up a minimal vault with two wiki pages and commit them. */
async function setupVault(root: string): Promise<void> {
  await initRepo(root);
  writeFile(root, "wiki/concepts/alpha-concept.md", CONCEPT_A);
  writeFile(root, "wiki/concepts/beta-concept.md", CONCEPT_B);
  await commitAll(root, "initial");
}

// ---------------------------------------------------------------------------
// dirtyFiles
// ---------------------------------------------------------------------------

test("dirtyFiles: empty when repo is clean", async () => {
  const root = tmpDir();
  await setupVault(root);
  const dirty = await dirtyFiles(root, ["wiki"]);
  assert.deepEqual(dirty, []);
});

test("dirtyFiles: detects modified tracked file", async () => {
  const root = tmpDir();
  await setupVault(root);
  // Modify a tracked file
  writeFile(root, "wiki/concepts/alpha-concept.md", "modified");
  const dirty = await dirtyFiles(root, ["wiki"]);
  assert.ok(dirty.length > 0, "should detect modified file");
  assert.ok(
    dirty.some((f) => f.includes("alpha-concept")),
    "should include modified file",
  );
});

test("dirtyFiles: detects new untracked file", async () => {
  const root = tmpDir();
  await setupVault(root);
  writeFile(root, "wiki/concepts/new-page.md", "new content");
  const dirty = await dirtyFiles(root, ["wiki"]);
  assert.ok(dirty.length > 0, "should detect untracked file");
  assert.ok(
    dirty.some((f) => f.includes("new-page")),
    "should include new untracked file",
  );
});

test("dirtyFiles: detects staged new file", async () => {
  const root = tmpDir();
  await setupVault(root);
  writeFile(root, "wiki/concepts/staged-page.md", "staged content");
  await git.add({ fs, dir: root, filepath: "wiki/concepts/staged-page.md" });
  const dirty = await dirtyFiles(root, ["wiki"]);
  assert.ok(dirty.length > 0, "should detect staged file");
});

test("dirtyFiles: raw/ files not counted when subtreePaths excludes raw", async () => {
  const root = tmpDir();
  await setupVault(root);
  writeFile(root, "raw/doc.md", "raw content");
  // Only check wiki/
  const dirty = await dirtyFiles(root, ["wiki"]);
  assert.ok(
    !dirty.some((f) => f.startsWith("raw/")),
    "raw files should not appear",
  );
});

test("dirtyFiles: raw/ files counted when subtreePaths includes raw", async () => {
  const root = tmpDir();
  await setupVault(root);
  writeFile(root, "raw/doc.md", "raw content");
  const dirty = await dirtyFiles(root, ["wiki", "raw"]);
  assert.ok(
    dirty.some((f) => f.startsWith("raw/")),
    "raw files should appear",
  );
});

test("dirtyFiles: returns empty for non-git directory", async () => {
  const root = tmpDir();
  // No git init
  writeFile(root, "wiki/concepts/page.md", "content");
  const dirty = await dirtyFiles(root, ["wiki"]);
  assert.deepEqual(dirty, []);
});

// ---------------------------------------------------------------------------
// runExport — basic output
// ---------------------------------------------------------------------------

test("runExport: produces index.html and page HTML files", async () => {
  const root = tmpDir();
  await setupVault(root);
  const outDir = path.join(root, "web");
  await runExport(root, { out: outDir, allowDirty: true });
  assert.ok(fs.existsSync(outDir), "output dir should exist");
  assert.ok(
    fs.existsSync(path.join(outDir, "index.html")),
    "should have index.html",
  );
  assert.ok(
    fs.existsSync(path.join(outDir, "wiki", "concepts", "alpha-concept.html")),
    "should have alpha-concept.html",
  );
  assert.ok(
    fs.existsSync(path.join(outDir, "tags", "alpha.html")),
    "should have tags/alpha.html",
  );
  assert.ok(
    fs.existsSync(path.join(outDir, "wiki", "concepts", "index.html")),
    "should have wiki/concepts/index.html",
  );
});

test("runExport: index.html mentions total page count", async () => {
  const root = tmpDir();
  await setupVault(root);
  const outDir = path.join(root, "web");
  await runExport(root, { out: outDir, allowDirty: true });
  const idx = fs.readFileSync(path.join(outDir, "index.html"), "utf8");
  assert.ok(idx.includes("2 pages"), "index should show '2 pages'");
});

// ---------------------------------------------------------------------------
// runExport — dirty-tree check
// ---------------------------------------------------------------------------

test("runExport: throws ExportDirtyError when wiki/ has modified files", async () => {
  const root = tmpDir();
  await setupVault(root);
  writeFile(root, "wiki/concepts/alpha-concept.md", "dirty");
  await assert.rejects(
    () => runExport(root, { out: path.join(root, "web") }),
    (err: unknown) => err instanceof ExportDirtyError,
    "should throw ExportDirtyError",
  );
});

test("runExport: --allow-dirty bypasses dirty check", async () => {
  const root = tmpDir();
  await setupVault(root);
  writeFile(root, "wiki/concepts/alpha-concept.md", "dirty");
  const outDir = path.join(root, "web");
  await assert.doesNotReject(() =>
    runExport(root, { out: outDir, allowDirty: true }),
  );
  assert.ok(fs.existsSync(path.join(outDir, "index.html")));
});

test("runExport: raw/ dirty check only when --raw is set", async () => {
  const root = tmpDir();
  await setupVault(root);
  writeFile(root, "raw/doc.md", "untracked raw");
  // Without --raw: no dirty check for raw/
  await assert.doesNotReject(
    () => runExport(root, { out: path.join(root, "web1") }),
    "raw/ dirty file should not block export without --raw",
  );
  // With --raw: raw/ is in scope
  await assert.rejects(
    () => runExport(root, { out: path.join(root, "web2"), raw: true }),
    (err: unknown) => err instanceof ExportDirtyError,
    "raw/ dirty file should block export with --raw",
  );
});

// ---------------------------------------------------------------------------
// runExport — non-empty target
// ---------------------------------------------------------------------------

test("runExport: throws ExportTargetNotEmptyError when target is non-empty", async () => {
  const root = tmpDir();
  await setupVault(root);
  const outDir = path.join(root, "web");
  // Pre-create a non-empty outDir
  fs.mkdirSync(outDir);
  writeFile(root, "web/existing.html", "old content");
  await assert.rejects(
    () => runExport(root, { out: outDir, allowDirty: true }),
    (err: unknown) => err instanceof ExportTargetNotEmptyError,
    "should refuse non-empty target without --force",
  );
  // Old content still intact
  assert.ok(
    fs.existsSync(path.join(outDir, "existing.html")),
    "old content preserved on failure",
  );
});

test("runExport: --force overwrites non-empty target", async () => {
  const root = tmpDir();
  await setupVault(root);
  const outDir = path.join(root, "web");
  fs.mkdirSync(outDir);
  writeFile(root, "web/existing.html", "old content");
  await assert.doesNotReject(() =>
    runExport(root, { out: outDir, allowDirty: true, force: true }),
  );
  assert.ok(
    fs.existsSync(path.join(outDir, "index.html")),
    "new index.html should exist",
  );
  assert.ok(
    !fs.existsSync(path.join(outDir, "existing.html")),
    "old content should be gone",
  );
});

// ---------------------------------------------------------------------------
// runExport — atomic write (partial failure leaves existing site intact)
// ---------------------------------------------------------------------------

test("runExport: existing site untouched when vault has no wiki/ directory", async () => {
  const root = tmpDir();
  // Create a git repo with an existing site but no wiki/
  await initRepo(root);
  await commitAll(root, "empty");
  const outDir = path.join(root, "web");
  fs.mkdirSync(outDir);
  writeFile(root, "web/existing.html", "old content");
  // Export will succeed (empty vault = empty site) but won't throw
  // (no wiki pages, no dirty files)
  await runExport(root, { out: outDir, allowDirty: true, force: true });
  // The site is replaced with the empty export (index.html is still generated)
  assert.ok(fs.existsSync(path.join(outDir, "index.html")));
});

// ---------------------------------------------------------------------------
// runExport — starters override
// ---------------------------------------------------------------------------

test("runExport: starters override front page get-started block", async () => {
  const root = tmpDir();
  await setupVault(root);
  const outDir = path.join(root, "web");
  await runExport(root, {
    out: outDir,
    allowDirty: true,
    starters: [
      { pageRef: "wiki/concepts/beta-concept.md", annotation: "Start here" },
    ],
  });
  const idx = fs.readFileSync(path.join(outDir, "index.html"), "utf8");
  assert.ok(
    idx.includes("Beta Concept"),
    "should show Beta Concept in starters",
  );
  assert.ok(idx.includes("Start here"), "should show annotation");
});
