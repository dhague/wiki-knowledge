/**
 * Tests for exportconfig.ts. The config is plain JSON, so each test writes real
 * files in a temp dir; no git repo is needed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  exportConfigPath,
  normalizeStartPageRef,
  readExportConfig,
  writeExportConfig,
  saveExportStartPage,
  saveExportTitle,
  resolveExportStartPage,
  resolveExportTitle,
} from "./exportconfig.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "export-config-test-"));
}

/** A temp directory with a chosen basename, so the directory-name fallback
 *  asserts against a known value rather than a mkdtemp suffix. */
function tmpDirNamed(name: string): string {
  const parent = tmpDir();
  const dir = path.join(parent, name);
  fs.mkdirSync(dir);
  return dir;
}

function writeConfigFile(root: string, contents: string): void {
  fs.mkdirSync(path.join(root, ".wiki-knowledge"), { recursive: true });
  fs.writeFileSync(exportConfigPath(root), contents);
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

test("readExportConfig: an absent file reads as an empty config", () => {
  const root = tmpDir();
  assert.deepEqual(readExportConfig(root), {});
});

test("readExportConfig: malformed JSON reads as an empty config, not an error", () => {
  const root = tmpDir();
  writeConfigFile(root, "{ this is not json");
  assert.deepEqual(readExportConfig(root), {});
});

test("readExportConfig: a JSON array reads as an empty config", () => {
  const root = tmpDir();
  writeConfigFile(root, '["title"]');
  assert.deepEqual(readExportConfig(root), {});
});

test("readExportConfig: a non-string title is ignored", () => {
  const root = tmpDir();
  writeConfigFile(root, '{"title": 42}');
  assert.deepEqual(readExportConfig(root), {});
});

test("readExportConfig: reads a title and leaves other keys visible", () => {
  const root = tmpDir();
  writeConfigFile(root, '{"title": "Team Wiki", "future_key": true}');
  const config = readExportConfig(root);
  assert.equal(config.title, "Team Wiki");
  assert.equal(config.future_key, true);
});

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

test("writeExportConfig: round-trips a written title", () => {
  const root = tmpDir();
  writeExportConfig(root, { title: "Team Wiki" });
  assert.deepEqual(readExportConfig(root), { title: "Team Wiki" });
});

test("writeExportConfig: creates .wiki-knowledge/ beside the search index", () => {
  const root = tmpDir();
  writeExportConfig(root, { title: "Team Wiki" });
  assert.equal(
    exportConfigPath(root),
    path.join(root, ".wiki-knowledge", "config.json"),
  );
  assert.ok(fs.existsSync(exportConfigPath(root)));
});

test("saveExportTitle: round-trips the title", () => {
  const root = tmpDir();
  saveExportTitle(root, "My Knowledge Base");
  assert.equal(readExportConfig(root).title, "My Knowledge Base");
});

test("saveExportTitle: preserves other keys already in the file", () => {
  const root = tmpDir();
  writeConfigFile(root, '{"title": "Old", "future_key": "keep me"}');
  saveExportTitle(root, "New");
  const config = readExportConfig(root);
  assert.equal(config.title, "New");
  assert.equal(config.future_key, "keep me");
});

test("saveExportTitle: repairs a malformed file rather than failing", () => {
  const root = tmpDir();
  writeConfigFile(root, "not json at all");
  saveExportTitle(root, "Recovered");
  assert.equal(readExportConfig(root).title, "Recovered");
});

test("saveExportTitle: a blank title is refused", () => {
  const root = tmpDir();
  assert.throws(() => saveExportTitle(root, "   "), /title/i);
  assert.ok(
    !fs.existsSync(exportConfigPath(root)),
    "nothing should be written",
  );
});

// ---------------------------------------------------------------------------
// Resolution order
// ---------------------------------------------------------------------------

test("resolveExportTitle: the flag wins over the config", () => {
  const root = tmpDirNamed("vault-dir");
  saveExportTitle(root, "Saved Title");
  assert.equal(resolveExportTitle(root, "Flag Title"), "Flag Title");
});

test("resolveExportTitle: the config wins over the vault directory name", () => {
  const root = tmpDirNamed("vault-dir");
  saveExportTitle(root, "Saved Title");
  assert.equal(resolveExportTitle(root), "Saved Title");
});

test("resolveExportTitle: the vault directory name is the fallback", () => {
  const root = tmpDirNamed("vault-dir");
  assert.equal(resolveExportTitle(root), "vault-dir");
});

test("resolveExportTitle: an absent config falls through to the directory name", () => {
  const root = tmpDirNamed("vault-dir");
  assert.ok(!fs.existsSync(exportConfigPath(root)));
  assert.equal(resolveExportTitle(root), "vault-dir");
});

test("resolveExportTitle: a malformed config falls through to the directory name", () => {
  const root = tmpDirNamed("vault-dir");
  writeConfigFile(root, "}{");
  assert.equal(resolveExportTitle(root), "vault-dir");
});

test("resolveExportTitle: a blank flag falls through to the config", () => {
  const root = tmpDirNamed("vault-dir");
  saveExportTitle(root, "Saved Title");
  assert.equal(resolveExportTitle(root, "   "), "Saved Title");
});

test("resolveExportTitle: a blank config title falls through to the directory name", () => {
  const root = tmpDirNamed("vault-dir");
  // Written by hand, not saved: saveExportTitle refuses a blank.
  writeConfigFile(root, '{"title": "   "}');
  assert.equal(resolveExportTitle(root), "vault-dir");
});

test("resolveExportTitle: titles are trimmed", () => {
  const root = tmpDirNamed("vault-dir");
  assert.equal(resolveExportTitle(root, "  Padded  "), "Padded");
});

// ---------------------------------------------------------------------------
// Start page — normalisation, save, clear, resolution
// ---------------------------------------------------------------------------

test("normalizeStartPageRef: strips a leading ./", () => {
  assert.equal(
    normalizeStartPageRef("./wiki/home/home.md"),
    "wiki/home/home.md",
  );
});

test("normalizeStartPageRef: appends .md when the extension is absent", () => {
  assert.equal(normalizeStartPageRef("wiki/home/home"), "wiki/home/home.md");
});

test("normalizeStartPageRef: leaves an already-normalised ref alone", () => {
  assert.equal(normalizeStartPageRef("wiki/home/home.md"), "wiki/home/home.md");
});

test("normalizeStartPageRef: a blank ref stays blank", () => {
  assert.equal(normalizeStartPageRef("   "), "");
});

test("readExportConfig: a non-string startPage is ignored", () => {
  const root = tmpDir();
  writeConfigFile(root, '{"startPage": 42, "title": "Keep"}');
  const config = readExportConfig(root);
  assert.equal(config.startPage, undefined);
  assert.equal(config.title, "Keep");
});

test("saveExportStartPage: round-trips the ref, normalised", () => {
  const root = tmpDir();
  saveExportStartPage(root, "./wiki/home/home");
  assert.equal(readExportConfig(root).startPage, "wiki/home/home.md");
});

test("saveExportStartPage: preserves other keys already in the file", () => {
  const root = tmpDir();
  writeConfigFile(root, '{"title": "Team Wiki", "future_key": "keep me"}');
  saveExportStartPage(root, "wiki/home/home.md");
  const config = readExportConfig(root);
  assert.equal(config.startPage, "wiki/home/home.md");
  assert.equal(config.title, "Team Wiki");
  assert.equal(config.future_key, "keep me");
});

test("saveExportTitle: preserves a saved start page", () => {
  const root = tmpDir();
  saveExportStartPage(root, "wiki/home/home.md");
  saveExportTitle(root, "Team Wiki");
  const config = readExportConfig(root);
  assert.equal(config.title, "Team Wiki");
  assert.equal(config.startPage, "wiki/home/home.md");
});

test("saveExportStartPage: a blank ref clears the key", () => {
  const root = tmpDir();
  writeConfigFile(
    root,
    '{"title": "Team Wiki", "startPage": "wiki/home/home.md"}',
  );
  saveExportStartPage(root, "   ");
  const config = readExportConfig(root);
  assert.equal(config.startPage, undefined);
  assert.equal(config.title, "Team Wiki", "other keys survive the clear");
});

test("saveExportStartPage: a blank ref on an absent config writes nothing new", () => {
  const root = tmpDir();
  saveExportStartPage(root, "");
  assert.deepEqual(readExportConfig(root), {});
});

test("resolveExportStartPage: the flag wins over the saved ref", () => {
  const root = tmpDir();
  saveExportStartPage(root, "wiki/saved/saved.md");
  assert.equal(
    resolveExportStartPage(root, "wiki/flag/flag.md"),
    "wiki/flag/flag.md",
  );
});

test("resolveExportStartPage: the saved ref is used when no flag is given", () => {
  const root = tmpDir();
  saveExportStartPage(root, "wiki/saved/saved.md");
  assert.equal(resolveExportStartPage(root), "wiki/saved/saved.md");
});

test("resolveExportStartPage: no flag and no saved ref resolves to none", () => {
  const root = tmpDir();
  assert.equal(resolveExportStartPage(root), undefined);
});

test("resolveExportStartPage: normalises the flag", () => {
  const root = tmpDir();
  assert.equal(
    resolveExportStartPage(root, "./wiki/home/home"),
    "wiki/home/home.md",
  );
});

test("resolveExportStartPage: a blank flag falls through to the saved ref", () => {
  const root = tmpDir();
  saveExportStartPage(root, "wiki/saved/saved.md");
  assert.equal(resolveExportStartPage(root, "   "), "wiki/saved/saved.md");
});

test("resolveExportStartPage: a malformed config resolves to none", () => {
  const root = tmpDir();
  writeConfigFile(root, "}{");
  assert.equal(resolveExportStartPage(root), undefined);
});

test("resolveExportStartPage: a hand-written blank saved ref resolves to none", () => {
  const root = tmpDir();
  writeConfigFile(root, '{"startPage": "   "}');
  assert.equal(resolveExportStartPage(root), undefined);
});

test("resolveExportStartPage: a ref that normalises away falls through", () => {
  const root = tmpDir();
  saveExportStartPage(root, "wiki/saved/saved.md");
  assert.equal(
    resolveExportStartPage(root, "./"),
    "wiki/saved/saved.md",
    "a bare ./ is not a ref, so the saved one applies",
  );
});

test("resolveExportStartPage: a ref that normalises away with nothing saved resolves to none", () => {
  const root = tmpDir();
  assert.equal(resolveExportStartPage(root, "./"), undefined);
  writeConfigFile(root, '{"startPage": "./"}');
  assert.equal(resolveExportStartPage(root), undefined);
});
