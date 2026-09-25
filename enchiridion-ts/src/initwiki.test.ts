/** initwiki tests — scaffolding a fresh vault and converting an existing tree. */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as git from "isomorphic-git";
import {
  init,
  isVault,
  ModeDedicated,
  ModeQueryFromAnywhere,
} from "./initwiki.js";
import { KindFolders } from "./place.js";
import { VaultGit } from "./vaultgit.js";

function tmpVault(): string {
  return path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "enchiridion-initwiki-")),
    "vault",
  );
}

test("init scaffolds the kind-axed layout", async () => {
  const root = tmpVault();
  const got = await init(root, ModeDedicated, "");
  assert.equal(got, path.resolve(root));
  for (const folder of Object.values(KindFolders)) {
    assert.ok(
      fs.existsSync(path.join(root, "wiki", folder, ".gitkeep")),
      `${folder} missing`,
    );
  }
  assert.ok(fs.existsSync(path.join(root, "raw", ".gitkeep")));
  assert.ok(fs.existsSync(path.join(root, ".gitignore")));
});

test("init writes the standard gitignore", async () => {
  const root = tmpVault();
  await init(root, ModeDedicated, "");
  const content = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
  for (const line of [
    "*.rsls",
    // `**/`-prefixed: a pattern containing `/` is anchored to the .gitignore's
    // own directory, so a nested state tree would stay committable.
    "**/.claude/wiki-knowledge/sessions/",
    "**/.opencode/wiki-knowledge/sessions/",
    ".wiki-knowledge/",
    // Navigation scaffolding is not knowledge.
    "log.md",
    "index.md",
    "_index.md",
  ]) {
    assert.ok(
      content.split("\n").includes(line),
      `.gitignore is missing "${line}"; got:\n${content}`,
    );
  }
});

test("init commits the scaffold", async () => {
  const root = tmpVault();
  await init(root, ModeDedicated, "");
  const repo = new VaultGit(root);
  assert.ok(await repo.isWorkTree(), "Init left no git work tree behind");
  // A clean work tree proves the scaffold was committed.
  await assert.rejects(repo.commit("should fail: nothing left to commit"));
});

test("init query-from-anywhere registers the plugin", async () => {
  const root = tmpVault();
  const pluginRoot = "/somewhere/wiki-plugin";
  await init(root, ModeQueryFromAnywhere, pluginRoot);
  const settings = JSON.parse(
    fs.readFileSync(path.join(root, ".claude", "settings.json"), "utf8"),
  ) as {
    extraKnownMarketplaces: Record<
      string,
      { source: { source: string; path: string } }
    >;
    enabledPlugins: Record<string, boolean>;
  };
  const marketplace = settings.extraKnownMarketplaces["wiki-knowledge-plugin"];
  assert.ok(marketplace, "settings.json registers no marketplace");
  assert.equal(marketplace.source.source, "directory");
  assert.equal(marketplace.source.path, pluginRoot);
  assert.equal(
    settings.enabledPlugins["wiki-knowledge@wiki-knowledge-plugin"],
    true,
  );
});

test("init dedicated writes no settings", async () => {
  const root = tmpVault();
  await init(root, ModeDedicated, "");
  assert.ok(
    !fs.existsSync(path.join(root, ".claude", "settings.json")),
    "dedicated mode wrote a settings.json",
  );
});

test("init refuses to run twice", async () => {
  const root = tmpVault();
  await init(root, ModeDedicated, "");
  await assert.rejects(init(root, ModeDedicated, ""));
});

test("init refuses a vault carrying a wiki-root sentinel and git", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enchiridion-initwiki-"));
  fs.writeFileSync(path.join(root, ".wiki-root"), "");
  // Only a marker plus a git work tree is a vault, so this needs a repo.
  const repo = new VaultGit(root);
  await repo.init();
  await assert.rejects(init(root, ModeDedicated, ""));
});

test("init validates its arguments", async () => {
  const cases: Array<[string, string]> = [
    ["sideways", ""],
    [ModeQueryFromAnywhere, ""],
  ];
  for (const [mode, pluginRoot] of cases) {
    const root = tmpVault();
    await assert.rejects(init(root, mode, pluginRoot));
    assert.ok(
      !fs.existsSync(root),
      "validation failed but the vault directory was still created",
    );
  }
});

test("isVault requires a marker AND a git work tree (#323)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enchiridion-initwiki-"));
  assert.equal(await isVault(root), false);
  fs.mkdirSync(path.join(root, "wiki"));
  // A marker without git is not a vault; init seeds a repo around it.
  assert.equal(await isVault(root), false);
  const repo = new VaultGit(root);
  await repo.init();
  assert.equal(await isVault(root), true);
});

test("init converts an existing wiki/ tree without git (#323)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enchiridion-initwiki-"));
  fs.mkdirSync(path.join(root, "wiki", "concepts"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "wiki", "concepts", "existing.md"),
    "---\ntitle: Existing\n---\n\nA pre-existing page.\n",
  );

  const got = await init(root, ModeDedicated, "");
  assert.equal(got, path.resolve(root));

  assert.ok(fs.existsSync(path.join(root, "wiki", "concepts", "existing.md")));
  for (const folder of Object.values(KindFolders)) {
    assert.ok(
      fs.existsSync(path.join(root, "wiki", folder)),
      `${folder} missing`,
    );
  }
  const repo = new VaultGit(root);
  assert.ok(await repo.isWorkTree(), "conversion left no git work tree");
  const files = await git.listFiles({ fs, dir: root, ref: "HEAD" });
  assert.ok(files.includes("wiki/concepts/existing.md"), files.join("\n"));
  assert.ok(files.includes(".gitignore"), files.join("\n"));
});

test("init conversion does not synthesize a raw/ inbox (#323)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enchiridion-initwiki-"));
  fs.mkdirSync(path.join(root, "wiki", "concepts"), { recursive: true });
  await init(root, ModeDedicated, "");
  assert.ok(
    !fs.existsSync(path.join(root, "raw")),
    "conversion synthesized a raw/ inbox",
  );
});

test("init conversion sweeps an existing raw/ inbox in (#323)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enchiridion-initwiki-"));
  fs.mkdirSync(path.join(root, "wiki", "concepts"), { recursive: true });
  // A conversion's existing inbox carries content, not a scaffold .gitkeep.
  fs.mkdirSync(path.join(root, "raw", "conversations"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "raw", "conversations", "transcript.md"),
    "raw\n",
  );
  await init(root, ModeDedicated, "");
  const files = await git.listFiles({ fs, dir: root, ref: "HEAD" });
  assert.ok(
    files.includes("raw/conversations/transcript.md"),
    files.join("\n"),
  );
});

test("init conversion leaves navigation scaffolding uncommitted (#323)", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enchiridion-initwiki-"));
  fs.mkdirSync(path.join(root, "wiki", "concepts"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "wiki", "concepts", "a.md"),
    "---\ntitle: A\n---\n\nBody.\n",
  );
  for (const name of ["log.md", "index.md", "_index.md"]) {
    fs.writeFileSync(path.join(root, "wiki", name), "navigation\n");
  }

  await init(root, ModeDedicated, "");

  const files = await git.listFiles({ fs, dir: root, ref: "HEAD" });
  assert.ok(files.includes("wiki/concepts/a.md"), files.join("\n"));
  for (const name of ["log.md", "index.md", "_index.md"]) {
    assert.ok(
      !files.includes(`wiki/${name}`),
      `gitignored navigation file wiki/${name} was committed:\n${files.join("\n")}`,
    );
  }
});
