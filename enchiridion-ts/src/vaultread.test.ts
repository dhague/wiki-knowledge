import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Vault } from "./vault.js";
import { VaultRead } from "./vaultread.js";
import type { LoadRecordsOptions } from "./pagerecord.js";

const TOLERANT: LoadRecordsOptions = { skipMalformedEdges: true };

function writeVault(pages: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enchiridion-vaultread-"));
  for (const [rel, text] of Object.entries(pages)) {
    const abs = path.join(root, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  return root;
}

function page(title: string, extra = ""): string {
  return `---\ntitle: ${title}\n${extra}---\nBody.\n`;
}

/** A page whose `related` edge value is a bare path, which the record parser
 * refuses. */
const malformedPage = page("Bad", "related:\n  - wiki/concepts/good.md\n");

function throwMessage(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  assert.fail("expected the read to throw");
}

test("records() defaults to the same strict read as Vault.pages()", () => {
  const root = writeVault({
    "wiki/concepts/good.md": page("Good"),
    "wiki/concepts/bad.md": malformedPage,
  });
  assert.match(
    throwMessage(() => new VaultRead(root).records()),
    /^wiki\/concepts\/bad\.md: /,
  );
  assert.equal(
    throwMessage(() => new VaultRead(root).records()),
    throwMessage(() => new Vault(root).pages()),
  );
});

test("records() skips malformed edges when the caller asks", () => {
  const root = writeVault({
    "wiki/concepts/good.md": page("Good"),
    "wiki/concepts/bad.md": malformedPage,
  });
  const records = new VaultRead(root).records(TOLERANT);
  assert.deepEqual(Object.keys(records).sort(), [
    "wiki/concepts/bad.md",
    "wiki/concepts/good.md",
  ]);
  assert.deepEqual(records["wiki/concepts/bad.md"].edges, []);
});

test("pagesWithText() defaults to the same strict read as Vault.pagesWithText()", () => {
  const root = writeVault({
    "wiki/concepts/good.md": page("Good"),
    "wiki/concepts/bad.md": malformedPage,
  });
  assert.equal(
    throwMessage(() => new VaultRead(root).pagesWithText()),
    throwMessage(() => new Vault(root).pagesWithText()),
  );
});

test("pagesWithText() skips malformed edges when the caller asks", () => {
  const root = writeVault({
    "wiki/concepts/good.md": page("Good"),
    "wiki/concepts/bad.md": malformedPage,
  });
  const pages = new VaultRead(root).pagesWithText(TOLERANT);
  assert.equal(pages["wiki/concepts/bad.md"].record.title, "Bad");
  assert.match(pages["wiki/concepts/bad.md"].text, /title: Bad/);
});

test("recordsFor() decodes the caller's text without reading the vault", () => {
  const root = writeVault({ "wiki/concepts/good.md": page("Good") });
  const read = new VaultRead(root);
  const records = read.recordsFor(
    { "wiki/concepts/off-disk.md": malformedPage },
    TOLERANT,
  );
  assert.deepEqual(Object.keys(records), ["wiki/concepts/off-disk.md"]);
  assert.deepEqual(records["wiki/concepts/off-disk.md"].edges, []);
});

test("each read is loaded at most once", () => {
  const root = writeVault({ "wiki/concepts/good.md": page("Good") });
  const read = new VaultRead(root);
  assert.strictEqual(read.texts(), read.texts());
  assert.strictEqual(read.allRefs(), read.allRefs());
  assert.strictEqual(read.records(), read.records());
  assert.strictEqual(read.records(TOLERANT), read.records(TOLERANT));
  assert.strictEqual(read.consolidatableKinds(), read.consolidatableKinds());
  assert.strictEqual(read.registryFiles(), read.registryFiles());
});

test("allRefs() names every markdown file, including ones that are not pages", () => {
  const root = writeVault({
    "wiki/concepts/good.md": page("Good"),
    "wiki/concepts/KIND.md": "---\nkind: concept\n---\n",
    "wiki/_index.md": "# Index\n",
    "wiki/stray.md": page("Stray"),
  });
  const read = new VaultRead(root);
  assert.deepEqual(read.allRefs(), [
    "wiki/_index.md",
    "wiki/concepts/KIND.md",
    "wiki/concepts/good.md",
    "wiki/stray.md",
  ]);
  assert.deepEqual(Object.keys(read.texts()), ["wiki/concepts/good.md"]);
});
