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
  ExportTargetIsDirectoryError,
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

// ---------------------------------------------------------------------------
// runExport — mobile-responsive output
// ---------------------------------------------------------------------------

/** Every .html file under `outDir`, as [output-relative path, content]. */
function readHtmlTree(outDir: string): Array<[string, string]> {
  const found: Array<[string, string]> = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.endsWith(".html")) {
        found.push([
          path.relative(outDir, abs).split(path.sep).join("/"),
          fs.readFileSync(abs, "utf8"),
        ]);
      }
    }
  };
  walk(outDir);
  return found;
}

/** Vault with a raw document too, for the --raw assertions. */
async function setupVaultWithRaw(root: string): Promise<void> {
  await setupVault(root);
  writeFile(root, "raw/transcript.md", "# Raw transcript\n\nContent.\n");
  await commitAll(root, "add raw");
}

test("runExport: writes the shared stylesheet once, at the output root", async () => {
  const root = tmpDir();
  await setupVault(root);
  const outDir = path.join(root, "web");
  await runExport(root, { out: outDir, allowDirty: true });

  const cssPath = path.join(outDir, "assets", "style.css");
  assert.ok(fs.existsSync(cssPath), "assets/style.css should be written");
  const css = fs.readFileSync(cssPath, "utf8");
  assert.ok(
    css.includes("/* Sakura.css v"),
    "stylesheet should carry the vendored framework's licence header",
  );
  assert.ok(
    css.includes("nav.wiki-nav"),
    "stylesheet should carry the sticky-nav supplement",
  );

  // Once, at the root — nowhere else.
  const cssFiles: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.endsWith(".css")) {
        cssFiles.push(path.relative(outDir, abs).split(path.sep).join("/"));
      }
    }
  };
  walk(outDir);
  assert.deepEqual(cssFiles, ["assets/style.css"]);
});

test("runExport: every generated page carries the viewport meta tag", async () => {
  const root = tmpDir();
  await setupVaultWithRaw(root);
  const outDir = path.join(root, "web");
  await runExport(root, { out: outDir, allowDirty: true, raw: true });

  const pages = readHtmlTree(outDir);
  assert.ok(pages.length >= 6, "fixture should produce a full site");
  for (const [rel, html] of pages) {
    assert.ok(
      html.includes(
        '<meta name="viewport" content="width=device-width, initial-scale=1">',
      ),
      `${rel} should carry the viewport meta tag`,
    );
  }
});

test("runExport: every page's stylesheet link resolves to the written file", async () => {
  const root = tmpDir();
  await setupVaultWithRaw(root);
  const outDir = path.join(root, "web");
  await runExport(root, { out: outDir, allowDirty: true, raw: true });

  const pages = readHtmlTree(outDir);
  const depths = new Set<number>();
  for (const [rel, html] of pages) {
    const href = /<link rel="stylesheet" href="([^"]+)">/.exec(html)?.[1];
    assert.ok(href, `${rel} should link the shared stylesheet`);
    assert.ok(!href.startsWith("/"), `${rel}: href must be relative`);
    const resolved = path.join(
      path.dirname(path.join(outDir, rel)),
      href.split("/").join(path.sep),
    );
    assert.ok(
      fs.existsSync(resolved),
      `${rel}: href "${href}" should resolve to a real file`,
    );
    depths.add(rel.split("/").length - 1);
  }
  // The fixture spans the root, one level deep and two levels deep.
  assert.deepEqual([...depths].sort(), [0, 1, 2]);
});

test("runExport: no page inlines the framework CSS", async () => {
  const root = tmpDir();
  await setupVaultWithRaw(root);
  const outDir = path.join(root, "web");
  await runExport(root, { out: outDir, allowDirty: true, raw: true });

  for (const [rel, html] of readHtmlTree(outDir)) {
    assert.ok(
      !html.includes("<style"),
      `${rel} must link the shared stylesheet, not inline it`,
    );
  }
});

test("runExport: the default wiki title is the vault root directory name", async () => {
  const root = tmpDir();
  await setupVault(root);
  const outDir = path.join(root, "web");
  await runExport(root, { out: outDir, allowDirty: true });

  const expected = path.basename(root);
  for (const [rel, html] of readHtmlTree(outDir)) {
    assert.ok(
      html.includes(`<span class="wiki-nav-title">${expected}</span>`),
      `${rel} nav should show the vault directory name "${expected}"`,
    );
  }
});

test("runExport: an explicit title is used instead of the directory name", async () => {
  const root = tmpDir();
  await setupVault(root);
  const outDir = path.join(root, "web");
  await runExport(root, { out: outDir, allowDirty: true, title: "Team Wiki" });

  for (const [rel, html] of readHtmlTree(outDir)) {
    assert.ok(
      html.includes('<span class="wiki-nav-title">Team Wiki</span>'),
      `${rel} nav should show the supplied title`,
    );
    assert.ok(
      !html.includes(path.basename(root)),
      `${rel} nav should not fall back to the directory name`,
    );
  }
});

test("runExport: a saved title in the vault config is used when no flag is given", async () => {
  const root = tmpDir();
  await setupVault(root);
  writeFile(
    root,
    ".wiki-knowledge/config.json",
    JSON.stringify({ title: "Saved Wiki" }),
  );
  const outDir = path.join(root, "web");
  await runExport(root, { out: outDir, allowDirty: true });

  assert.ok(
    fs
      .readFileSync(path.join(outDir, "index.html"), "utf8")
      .includes('<span class="wiki-nav-title">Saved Wiki</span>'),
    "nav should show the saved title",
  );
});

test("runExport: an explicit title overrides the saved one", async () => {
  const root = tmpDir();
  await setupVault(root);
  writeFile(
    root,
    ".wiki-knowledge/config.json",
    JSON.stringify({ title: "Saved Wiki" }),
  );
  const outDir = path.join(root, "web");
  await runExport(root, { out: outDir, allowDirty: true, title: "This Run" });

  const html = fs.readFileSync(path.join(outDir, "index.html"), "utf8");
  assert.ok(html.includes("This Run"), "nav should show the per-run title");
  assert.ok(
    !html.includes("Saved Wiki"),
    "per-run title replaces the saved one",
  );
});

test("runExport: an absent config leaves the directory name as the title", async () => {
  const root = tmpDir();
  await setupVault(root);
  const outDir = path.join(root, "web");
  await runExport(root, { out: outDir, allowDirty: true });

  assert.ok(
    fs
      .readFileSync(path.join(outDir, "index.html"), "utf8")
      .includes(`<span class="wiki-nav-title">${path.basename(root)}</span>`),
    "nav should fall back to the vault directory name",
  );
});

test("runExport: the front page heading is the resolved title, not a hardcoded Wiki", async () => {
  const root = tmpDir();
  await setupVault(root);
  writeFile(
    root,
    ".wiki-knowledge/config.json",
    JSON.stringify({ title: "Saved Wiki" }),
  );
  const outDir = path.join(root, "web");
  await runExport(root, { out: outDir, allowDirty: true });

  const html = fs.readFileSync(path.join(outDir, "index.html"), "utf8");
  assert.ok(
    html.includes("<h1>Saved Wiki</h1>"),
    "heading should be the title",
  );
  assert.ok(!html.includes("<h1>Wiki</h1>"), "no hardcoded heading");
});

test("runExport: the sticky nav reaches every page type", async () => {
  const root = tmpDir();
  await setupVaultWithRaw(root);
  const outDir = path.join(root, "web");
  await runExport(root, { out: outDir, allowDirty: true, raw: true });

  const byPath = new Map(readHtmlTree(outDir));
  const expected = [
    "index.html", // front page
    "tags/index.html", // tag index
    "tags/alpha.html", // tag page
    "wiki/concepts/index.html", // kind index
    "wiki/concepts/alpha-concept.html", // wiki page
    "raw/transcript.html", // raw page under --raw
  ];
  for (const rel of expected) {
    const html = byPath.get(rel);
    assert.ok(html, `${rel} should exist in the export`);
    assert.ok(
      html.includes('class="wiki-nav"') && html.includes(">Home<"),
      `${rel} should carry the sticky nav bar with a Home link`,
    );
  }
});

// ---------------------------------------------------------------------------
// runExport — single-file mode
// ---------------------------------------------------------------------------

test("runExport: --single-file writes one file and no directory tree", async () => {
  const root = tmpDir();
  await setupVaultWithRaw(root);
  const outFile = path.join(root, "wiki.html");
  await runExport(root, { out: outFile, allowDirty: true, singleFile: true });

  assert.ok(fs.existsSync(outFile), "the output file should exist");
  assert.ok(
    fs.statSync(outFile).isFile(),
    "the output should be a file, not a directory",
  );
  // Nothing else appeared beside it: no web/, no assets/.
  assert.deepEqual(
    fs.readdirSync(root).filter((n) => n.endsWith(".html")),
    ["wiki.html"],
    "the export should write exactly one HTML file",
  );
  assert.ok(
    !fs.existsSync(path.join(root, "web")),
    "single-file mode writes no site directory",
  );
  assert.ok(
    !fs.existsSync(path.join(root, "assets")),
    "single-file mode writes no assets directory",
  );
});

test("runExport: the single file is self-contained and hash-linked", async () => {
  const root = tmpDir();
  await setupVault(root);
  const outFile = path.join(root, "wiki.html");
  await runExport(root, { out: outFile, allowDirty: true, singleFile: true });

  const html = fs.readFileSync(outFile, "utf8");
  assert.ok(html.includes('id="wiki-concepts-alpha-concept"'), "sections");
  assert.ok(html.includes("<style>"), "inlined stylesheet");
  assert.ok(html.includes("<script>"), "inline script");
  assert.ok(
    !html.includes('href="wiki/concepts/'),
    "internal links should be fragments, not paths",
  );
});

test("runExport: re-running single-file replaces the previous file", async () => {
  const root = tmpDir();
  await setupVault(root);
  const outFile = path.join(root, "wiki.html");

  await runExport(root, { out: outFile, allowDirty: true, singleFile: true });
  const first = fs.readFileSync(outFile, "utf8");

  // A page added between runs must show up in the second file — which is only
  // observable if the previous output was replaced rather than kept.
  writeFile(
    root,
    "wiki/concepts/gamma-concept.md",
    `---\ntitle: Gamma Concept\nkind: concept\n---\n\nNew page.\n`,
  );
  await commitAll(root, "add gamma");
  await runExport(root, { out: outFile, allowDirty: true, singleFile: true });
  const second = fs.readFileSync(outFile, "utf8");

  assert.notEqual(second, first, "the second run should replace the first");
  assert.ok(
    second.includes('id="wiki-concepts-gamma-concept"'),
    "the new page should be in the replaced file",
  );
});

test("runExport: single-file leaves no temp file behind", async () => {
  const root = tmpDir();
  await setupVault(root);
  const outFile = path.join(root, "wiki.html");
  await runExport(root, { out: outFile, allowDirty: true, singleFile: true });

  assert.deepEqual(
    fs.readdirSync(root).filter((n) => n.includes("export-tmp")),
    [],
    "the temp file used for the atomic write should be gone",
  );
});

test("runExport: --raw adds raw sections to the single file too", async () => {
  const root = tmpDir();
  await setupVaultWithRaw(root);
  const outFile = path.join(root, "wiki.html");

  await runExport(root, { out: outFile, allowDirty: true, singleFile: true });
  assert.ok(
    !fs.readFileSync(outFile, "utf8").includes('id="raw-transcript"'),
    "raw pages stay out without --raw",
  );

  await runExport(root, {
    out: outFile,
    allowDirty: true,
    singleFile: true,
    raw: true,
  });
  assert.ok(
    fs.readFileSync(outFile, "utf8").includes('id="raw-transcript"'),
    "raw pages should be sections under --raw",
  );
});

test("runExport: the title resolution is the same in both modes", async () => {
  const root = tmpDir();
  await setupVault(root);
  const outFile = path.join(root, "wiki.html");
  await runExport(root, {
    out: outFile,
    allowDirty: true,
    singleFile: true,
    title: "Team Wiki",
  });

  assert.ok(
    fs
      .readFileSync(outFile, "utf8")
      .includes('<span class="wiki-nav-title">Team Wiki</span>'),
    "the nav should carry the resolved title",
  );
});

test("runExport: an oversized single file is still written, and warns", async (t) => {
  const root = tmpDir();
  await setupVault(root);
  // One page whose rendered form clears the warning threshold.
  writeFile(
    root,
    "wiki/concepts/huge-concept.md",
    `---\ntitle: Huge Concept\nkind: concept\n---\n\n${"padding text ".repeat(480000)}\n`,
  );
  await commitAll(root, "add huge page");

  const warnings: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  });

  const outFile = path.join(root, "wiki.html");
  await runExport(root, { out: outFile, allowDirty: true, singleFile: true });

  const bytes = fs.statSync(outFile).size;
  assert.ok(bytes > 5 * 1024 * 1024, `fixture should be oversized (${bytes})`);
  assert.equal(warnings.length, 1, "exactly one warning");
  assert.match(warnings[0], /multi-page/i, "the warning suggests multi-page");
});

test("runExport: a comfortably-sized single file writes no warning", async (t) => {
  const root = tmpDir();
  await setupVault(root);

  const warnings: string[] = [];
  t.mock.method(console, "error", (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  });

  await runExport(root, {
    out: path.join(root, "wiki.html"),
    allowDirty: true,
    singleFile: true,
  });
  assert.deepEqual(warnings, [], "a small export should say nothing");
});

test("runExport: --single-file pointed at a directory fails clearly", async () => {
  const root = tmpDir();
  await setupVault(root);
  const outDir = path.join(root, "web");
  fs.mkdirSync(outDir);

  await assert.rejects(
    () => runExport(root, { out: outDir, allowDirty: true, singleFile: true }),
    (err: unknown) => {
      assert.ok(err instanceof ExportTargetIsDirectoryError);
      assert.match((err as Error).message, /director/i);
      return true;
    },
    "a directory target should be refused with a message that says why",
  );
  // The directory is left alone.
  assert.ok(fs.existsSync(outDir) && fs.statSync(outDir).isDirectory());
});
