/**
 * Tests for the eight mechanical vault health checks.
 *
 * Strategy: build minimal on-disk vault fixtures with writeVault(); for
 * staleSynthesis (check 4) also initialise a real git repo so that
 * VaultGit.lastCommitDate can return a controlled past/recent date.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as git from "isomorphic-git";
import {
  kindFolderConformance,
  ingestionSourceIntegrity,
  frontmatterLinkFormat,
  staleSynthesis,
  missingVolatilitySourceDate,
  unresolvedSupersession,
  contradictionCallouts,
  orphans,
  CHECKS,
} from "./check.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a temp dir with the given vault-relative paths written to disk.
 * Returns the vault root. */
function writeVault(pages: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enchiridion-check-"));
  for (const [rel, text] of Object.entries(pages)) {
    const abs = path.join(root, ...rel.split("/"));
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, text);
  }
  return root;
}

/** Minimal valid page frontmatter with given overrides. */
function page(title: string, extra = "", body = "Body text.\n"): string {
  return `---\ntitle: ${title}\n${extra}---\n${body}`;
}

/** Init a bare git repo at root, stage and commit all files with a specific
 * author timestamp (Unix seconds). */
async function gitCommit(root: string, timestamp: number): Promise<void> {
  const author = {
    name: "Test",
    email: "t@t.com",
    timestamp,
    timezoneOffset: 0,
  };
  await git.init({ fs, dir: root });
  const walk = (dir: string): string[] => {
    const out: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === ".git") continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) out.push(...walk(abs));
      else out.push(path.relative(root, abs).split(path.sep).join("/"));
    }
    return out;
  };
  for (const f of walk(root)) await git.add({ fs, dir: root, filepath: f });
  await git.commit({
    fs,
    dir: root,
    message: "init",
    author,
    committer: author,
  });
}

// ---------------------------------------------------------------------------
// Check 1 — kindFolderConformance
// ---------------------------------------------------------------------------

test("check 1: clean vault returns no findings", async () => {
  const root = writeVault({
    "wiki/concepts/foo.md": page("Foo"),
    "wiki/entities/bar.md": page("Bar"),
  });
  const findings = await kindFolderConformance(root);
  assert.deepEqual(findings, []);
});

test("check 1: page at wiki root is a violation", async () => {
  const root = writeVault({
    "wiki/stray.md": page("Stray"),
    "wiki/concepts/ok.md": page("OK"),
  });
  const findings = await kindFolderConformance(root);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].pageRef, "wiki/stray.md");
  assert.match(findings[0].detail, /wiki\/ root/);
});

test("check 1: page nested below kind-folder is a violation", async () => {
  const root = writeVault({
    "wiki/concepts/sub/deep.md": page("Deep"),
  });
  const findings = await kindFolderConformance(root);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].pageRef, "wiki/concepts/sub/deep.md");
  assert.match(findings[0].detail, /nested/);
});

test("check 1: KIND.md is excluded from findings", async () => {
  const root = writeVault({
    "wiki/decisions/KIND.md": "---\nkind: decision\nsummary: s\n---\n",
    "wiki/decisions/my-decision.md": page("My Decision"),
  });
  const findings = await kindFolderConformance(root);
  assert.deepEqual(findings, []);
});

test("check 1: wiki/_index.md is excluded from findings", async () => {
  const root = writeVault({
    "wiki/_index.md": "generated\n",
    "wiki/concepts/foo.md": page("Foo"),
  });
  const findings = await kindFolderConformance(root);
  assert.deepEqual(findings, []);
});

test("check 1: page in custom kind-folder is NOT a violation", async () => {
  const root = writeVault({
    "wiki/decisions/my-decision.md": page("My Decision"),
  });
  const findings = await kindFolderConformance(root);
  assert.deepEqual(findings, []);
});

// ---------------------------------------------------------------------------
// Check 2 — ingestionSourceIntegrity
// ---------------------------------------------------------------------------

test("check 2: source page with raw_source is clean", async () => {
  const root = writeVault({
    "wiki/sources/doc.md": page(
      "Doc",
      'raw_source: "[doc.md](../../raw/doc.md)"\n',
    ),
  });
  const findings = await ingestionSourceIntegrity(root);
  assert.deepEqual(findings, []);
});

test("check 2: source page missing raw_source is a violation", async () => {
  const root = writeVault({
    "wiki/sources/doc.md": page("Doc"),
  });
  const findings = await ingestionSourceIntegrity(root);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].pageRef, "wiki/sources/doc.md");
  assert.match(findings[0].detail, /raw_source/);
});

test("check 2: concept page without raw_source is NOT a violation", async () => {
  const root = writeVault({
    "wiki/concepts/foo.md": page("Foo"),
  });
  const findings = await ingestionSourceIntegrity(root);
  assert.deepEqual(findings, []);
});

// ---------------------------------------------------------------------------
// Check 3 — frontmatterLinkFormat
// ---------------------------------------------------------------------------

test("check 3: properly quoted and encoded links are clean", async () => {
  const root = writeVault({
    "wiki/concepts/foo.md": page(
      "Foo",
      'related:\n  - "[Bar](../entities/bar.md)"\n',
    ),
    "wiki/entities/bar.md": page("Bar"),
  });
  const findings = await frontmatterLinkFormat(root);
  assert.deepEqual(findings, []);
});

test("check 3: unquoted list item link is a violation", async () => {
  const root = writeVault({
    // YAML parses "- [Bar](...)" as a sequence, not a link string
    "wiki/concepts/foo.md":
      "---\ntitle: Foo\nrelated:\n  - [Bar](../entities/bar.md)\n---\nBody.\n",
  });
  const findings = await frontmatterLinkFormat(root);
  assert.ok(
    findings.some(
      (f) => f.pageRef === "wiki/concepts/foo.md" && /unquoted/.test(f.detail),
    ),
  );
});

test("check 3: unencoded # in filename destination is a violation", async () => {
  // A # in a filename must be encoded as %23; without encoding it is parsed as
  // an anchor separator, causing dest != reencoded(decodedPath).
  const root = writeVault({
    "wiki/concepts/foo.md": page(
      "Foo",
      'related:\n  - "[Bar](../entities/bar#baz.md)"\n',
    ),
  });
  const findings = await frontmatterLinkFormat(root);
  assert.ok(
    findings.some(
      (f) => f.pageRef === "wiki/concepts/foo.md" && /unencoded/.test(f.detail),
    ),
  );
});

// ---------------------------------------------------------------------------
// Check 4 — staleSynthesis (requires real git)
// ---------------------------------------------------------------------------

test("check 4: synthesis page committed recently is clean", async () => {
  const root = writeVault({
    "wiki/synthesis/recent.md": page(
      "Recent",
      "volatility: evolving\nsource_date: 2026-01-01\n",
    ),
  });
  const recentTs = Math.floor(Date.now() / 1000) - 5 * 24 * 60 * 60; // 5 days ago
  await gitCommit(root, recentTs);
  const findings = await staleSynthesis(root);
  assert.deepEqual(findings, []);
});

test("check 4: synthesis page committed >30 days ago is a violation", async () => {
  const root = writeVault({
    "wiki/synthesis/old.md": page("Old"),
  });
  const oldTs = Math.floor(Date.now() / 1000) - 45 * 24 * 60 * 60; // 45 days ago
  await gitCommit(root, oldTs);
  const findings = await staleSynthesis(root);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].pageRef, "wiki/synthesis/old.md");
  assert.match(findings[0].detail, /days ago/);
});

test("check 4: concept page >30 days old is NOT a violation", async () => {
  const root = writeVault({
    "wiki/concepts/old-concept.md": page("Old Concept"),
  });
  const oldTs = Math.floor(Date.now() / 1000) - 45 * 24 * 60 * 60;
  await gitCommit(root, oldTs);
  const findings = await staleSynthesis(root);
  assert.deepEqual(findings, []);
});

// ---------------------------------------------------------------------------
// Check 5 — missingVolatilitySourceDate
// ---------------------------------------------------------------------------

test("check 5: page with both fields is clean", async () => {
  const root = writeVault({
    "wiki/concepts/foo.md": page(
      "Foo",
      "volatility: stable\nsource_date: 2026-01-01\n",
    ),
  });
  const findings = await missingVolatilitySourceDate(root);
  assert.deepEqual(findings, []);
});

test("check 5: page missing volatility is a violation", async () => {
  const root = writeVault({
    "wiki/concepts/foo.md": page("Foo", "source_date: 2026-01-01\n"),
  });
  const findings = await missingVolatilitySourceDate(root);
  assert.equal(findings.length, 1);
  assert.match(findings[0].detail, /volatility/);
});

test("check 5: page missing source_date is a violation", async () => {
  const root = writeVault({
    "wiki/concepts/foo.md": page("Foo", "volatility: stable\n"),
  });
  const findings = await missingVolatilitySourceDate(root);
  assert.equal(findings.length, 1);
  assert.match(findings[0].detail, /source_date/);
});

// ---------------------------------------------------------------------------
// Check 6 — unresolvedSupersession
// ---------------------------------------------------------------------------

const contradictsFm = 'contradicts:\n  - "[Bar](../entities/bar.md)"\n';
const supersedesFm = 'supersedes:\n  - "[Old Bar](../entities/old-bar.md)"\n';
const calloutBody = "> [!warning] Contradiction\nSome conflict noted.\n";

test("check 6: contradicts + supersedes is clean", async () => {
  const root = writeVault({
    "wiki/concepts/foo.md": page("Foo", contradictsFm + supersedesFm),
  });
  const findings = await unresolvedSupersession(root);
  assert.deepEqual(findings, []);
});

test("check 6: contradicts + no supersedes + active callout is clean (live contradiction, check 7's domain)", async () => {
  const root = writeVault({
    "wiki/concepts/foo.md": page("Foo", contradictsFm, calloutBody),
  });
  const findings = await unresolvedSupersession(root);
  assert.deepEqual(findings, []);
});

test("check 6: contradicts + no supersedes + no callout is a violation", async () => {
  const root = writeVault({
    "wiki/concepts/foo.md": page("Foo", contradictsFm),
  });
  const findings = await unresolvedSupersession(root);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].pageRef, "wiki/concepts/foo.md");
  assert.match(findings[0].detail, /supersedes/);
});

// ---------------------------------------------------------------------------
// Check 7 — contradictionCallouts
// ---------------------------------------------------------------------------

test("check 7: page without callout is clean", async () => {
  const root = writeVault({
    "wiki/concepts/foo.md": page("Foo"),
  });
  const findings = await contradictionCallouts(root);
  assert.deepEqual(findings, []);
});

test("check 7: page with active Contradiction callout is a violation", async () => {
  const root = writeVault({
    "wiki/concepts/foo.md": page("Foo", "", calloutBody),
  });
  const findings = await contradictionCallouts(root);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].pageRef, "wiki/concepts/foo.md");
});

// ---------------------------------------------------------------------------
// Check 8 — orphans
// ---------------------------------------------------------------------------

test("check 8: page with inbound link is clean", async () => {
  const root = writeVault({
    "wiki/concepts/foo.md": page("Foo", "", "[Bar](../entities/bar.md)\n"),
    "wiki/entities/bar.md": page("Bar"),
  });
  const findings = await orphans(root);
  // bar.md has one inbound link from foo.md
  assert.ok(!findings.some((f) => f.pageRef === "wiki/entities/bar.md"));
});

test("check 8: page with zero inbound links is a violation", async () => {
  const root = writeVault({
    "wiki/concepts/lonely.md": page("Lonely"),
  });
  const findings = await orphans(root);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].pageRef, "wiki/concepts/lonely.md");
});

test("check 8: frontmatter edge counts as inbound link", async () => {
  const root = writeVault({
    "wiki/concepts/foo.md": page(
      "Foo",
      'related:\n  - "[Bar](../entities/bar.md)"\n',
    ),
    "wiki/entities/bar.md": page("Bar"),
  });
  const findings = await orphans(root);
  assert.ok(!findings.some((f) => f.pageRef === "wiki/entities/bar.md"));
});

// ---------------------------------------------------------------------------
// CHECKS registry
// ---------------------------------------------------------------------------

test("CHECKS registry contains all eight check names", () => {
  const expected = [
    "kind-folder-conformance",
    "ingestion-source-integrity",
    "frontmatter-link-format",
    "stale-synthesis",
    "missing-volatility-source-date",
    "unresolved-supersession",
    "contradiction-callouts",
    "orphans",
  ];
  for (const name of expected) {
    assert.ok(name in CHECKS, `CHECKS missing: ${name}`);
    assert.equal(typeof CHECKS[name], "function");
  }
  assert.equal(Object.keys(CHECKS).length, expected.length);
});
