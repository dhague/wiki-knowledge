/**
 * Tests for exportconfig.ts — the vault config file and the one place the
 * wiki title is resolved.
 *
 * The config file is plain JSON on disk, so these tests write real files in a
 * temp directory; no git repo is needed (nothing here reads vault content).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  exportConfigPath,
  readExportConfig,
  writeExportConfig,
  saveExportTitle,
  resolveExportTitle,
} from "./exportconfig.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "export-config-test-"));
}

/** A temp directory whose basename is known, so the directory-name fallback
 *  is asserted against a value the test chose rather than a mkdtemp suffix. */
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
