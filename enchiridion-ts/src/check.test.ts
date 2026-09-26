/** Tests for the twelve mechanical vault health checks. staleSynthesis and
 * conceptFragmentation need a real git commit: the index is a view of HEAD
 * (ADR-0015). */

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
  tagsShape,
  unresolvedSupersession,
  contradictionCallouts,
  orphans,
  splitLinks,
  duplicateFrontmatter,
  conceptFragmentation,
  DefaultMinSimilarity,
  titleTokens,
  CHECKS,
  fixFrontmatterLinkFormat,
  fixIngestionSourceIntegrity,
  fixMissingCrossReferences,
  fixSplitLinks,
  fixDuplicateFrontmatter,
  FIXES,
} from "./check.js";
import { newPageRecord } from "./pagerecord.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

/** Init a git repo at root and commit everything with the given author
 * timestamp (Unix seconds). */
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
// kindFolderConformance
// ---------------------------------------------------------------------------

test("kind-folder-conformance: clean vault returns no findings", async () => {
  const root = writeVault({
    "wiki/concepts/foo.md": page("Foo"),
    "wiki/entities/bar.md": page("Bar"),
  });
  const findings = await kindFolderConformance(root);
  assert.deepEqual(findings, []);
});

test("kind-folder-conformance: page at wiki root is a violation", async () => {
  const root = writeVault({
    "wiki/stray.md": page("Stray"),
    "wiki/concepts/ok.md": page("OK"),
  });
  const findings = await kindFolderConformance(root);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].pageRef, "wiki/stray.md");
  assert.match(findings[0].detail, /wiki\/ root/);
});

test("kind-folder-conformance: page nested below kind-folder is a violation", async () => {
  const root = writeVault({
    "wiki/concepts/sub/deep.md": page("Deep"),
  });
  const findings = await kindFolderConformance(root);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].pageRef, "wiki/concepts/sub/deep.md");
  assert.match(findings[0].detail, /nested/);
});

test("kind-folder-conformance: KIND.md is excluded from findings", async () => {
  const root = writeVault({
    "wiki/decisions/KIND.md": "---\nkind: decision\nsummary: s\n---\n",
    "wiki/decisions/my-decision.md": page("My Decision"),
  });
  const findings = await kindFolderConformance(root);
  assert.deepEqual(findings, []);
});

test("kind-folder-conformance: wiki/_index.md is excluded from findings", async () => {
  const root = writeVault({
    "wiki/_index.md": "generated\n",
    "wiki/concepts/foo.md": page("Foo"),
  });
  const findings = await kindFolderConformance(root);
  assert.deepEqual(findings, []);
});

test("kind-folder-conformance: page in custom kind-folder is NOT a violation", async () => {
  const root = writeVault({
    "wiki/decisions/my-decision.md": page("My Decision"),
  });
  const findings = await kindFolderConformance(root);
  assert.deepEqual(findings, []);
});

// ---------------------------------------------------------------------------
// ingestionSourceIntegrity
// ---------------------------------------------------------------------------

test("ingestion-source-integrity: source page with raw_source is clean", async () => {
  const root = writeVault({
    "wiki/sources/doc.md": page(
      "Doc",
      'raw_source: "[doc.md](../../raw/doc.md)"\n',
    ),
  });
  const findings = await ingestionSourceIntegrity(root);
  assert.deepEqual(findings, []);
});

test("ingestion-source-integrity: source page missing raw_source is a violation", async () => {
  const root = writeVault({
    "wiki/sources/doc.md": page("Doc"),
  });
  const findings = await ingestionSourceIntegrity(root);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].pageRef, "wiki/sources/doc.md");
  assert.match(findings[0].detail, /raw_source/);
});

test("ingestion-source-integrity: concept page without raw_source is NOT a violation", async () => {
  const root = writeVault({
    "wiki/concepts/foo.md": page("Foo"),
  });
  const findings = await ingestionSourceIntegrity(root);
  assert.deepEqual(findings, []);
});

// ---------------------------------------------------------------------------
// frontmatterLinkFormat
// ---------------------------------------------------------------------------

test("frontmatter-link-format: properly quoted and encoded links are clean", async () => {
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

test("frontmatter-link-format: unquoted list item link is a violation", async () => {
  const root = writeVault({
    // YAML reads "- [Bar](...)" as a sequence, not a link string.
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

// A bare path is valid YAML but not a markdown link, so the record parser
// refuses it — this raw-text check is the only one that can name it.
test("frontmatter-link-format: an edge value that is not a markdown link is a finding", async () => {
  const root = writeVault({
    "wiki/concepts/a.md": page("A"),
    "wiki/concepts/b.md": page("B", "related:\n  - wiki/concepts/a.md\n"),
  });
  const findings = await frontmatterLinkFormat(root);
  assert.deepEqual(findings, [
    {
      pageRef: "wiki/concepts/b.md",
      detail: 'related: not a markdown link: "wiki/concepts/a.md"',
    },
  ]);
});

test("frontmatter-link-format: a non-string edge entry is a finding", async () => {
  const root = writeVault({
    "wiki/concepts/b.md": page("B", "related:\n  - 42\n"),
  });
  const findings = await frontmatterLinkFormat(root);
  assert.deepEqual(findings, [
    {
      pageRef: "wiki/concepts/b.md",
      detail: "related entry is not a markdown link: 42",
    },
  ]);
});

// The anchor rule (`wiki-conventions`): `#` introducing an anchor is literal; a
// `#` inside a filename is spelled `%23`.
test("frontmatter-link-format: frontmatter destination carrying a genuine anchor is clean", async () => {
  const root = writeVault({
    "wiki/concepts/foo.md": page(
      "Foo",
      'related:\n  - "[Cache TTL](../concepts/caching.md#ttl)"\n',
    ),
    "wiki/concepts/caching.md": page("Caching"),
  });
  const findings = await frontmatterLinkFormat(root);
  assert.deepEqual(findings, []);
});

test("frontmatter-link-format: an unencoded # is the anchor separator, not a filename character", async () => {
  const root = writeVault({
    "wiki/concepts/foo.md": page(
      "Foo",
      'related:\n  - "[Bar](../entities/bar#baz.md)"\n',
    ),
  });
  const findings = await frontmatterLinkFormat(root);
  assert.deepEqual(findings, []);
});

test("frontmatter-link-format: %23 in a filename destination is the encoded spelling, and clean", async () => {
  const root = writeVault({
    "wiki/concepts/foo.md": page(
      "Foo",
      'related:\n  - "[Bar](../entities/bar%23baz.md)"\n',
    ),
  });
  const findings = await frontmatterLinkFormat(root);
  assert.deepEqual(findings, []);
});

test("frontmatter-link-format: an anchor is no hiding place for an unencoded path", async () => {
  const root = writeVault({
    "wiki/concepts/foo.md": page(
      "Foo",
      'related:\n  - "[Bar](../entities/my(page).md#ttl)"\n',
    ),
  });
  const findings = await frontmatterLinkFormat(root);
  assert.ok(
    findings.some(
      (f) => f.pageRef === "wiki/concepts/foo.md" && /unencoded/.test(f.detail),
    ),
  );
  assert.ok(
    findings.some((f) =>
      f.detail.includes(`should be "../entities/my%28page%29.md#ttl"`),
    ),
  );
});

test("frontmatter-link-format: a folded destination is checked, not skipped", async () => {
  const root = writeVault({
    "wiki/concepts/foo.md": page(
      "Foo",
      'related:\n  - "[Bar](../entities/some-rather-long-bar-page-name-here\\\n    (draft).md#ttl)"\n',
    ),
  });
  const findings = await frontmatterLinkFormat(root);
  assert.ok(
    findings.some(
      (f) => f.pageRef === "wiki/concepts/foo.md" && /unencoded/.test(f.detail),
    ),
  );
});

test("frontmatter-link-format: a boundary fold does not hide an unencoded destination", async () => {
  const root = writeVault({
    "wiki/concepts/foo.md": page(
      "Foo",
      'related:\n  - "[Bar]\\\n    (../entities/my(page).md#ttl)"\n',
    ),
  });
  const findings = await frontmatterLinkFormat(root);
  assert.ok(
    findings.some(
      (f) =>
        f.pageRef === "wiki/concepts/foo.md" &&
        f.detail.includes(`should be "../entities/my%28page%29.md#ttl"`),
    ),
  );
});

test("frontmatter-link-format: an unquoted boundary-shaped line is reported once, not twice", async () => {
  // A plain scalar is not a link, but the quote-blind scan still matches the
  // boundary shape — so suppression must key on the line the link opens on, or
  // a bogus second finding appears beside the real unquoted one.
  const root = writeVault({
    "wiki/concepts/foo.md": page(
      "Foo",
      "related:\n  - [A]\\\n    (../entities/my(page).md)\n",
    ),
  });
  const findings = await frontmatterLinkFormat(root);
  assert.deepEqual(findings, [
    {
      pageRef: "wiki/concepts/foo.md",
      detail: "unquoted markdown link in frontmatter: - [A]\\",
    },
  ]);
});

// ---------------------------------------------------------------------------
// staleSynthesis — requires real git
// ---------------------------------------------------------------------------

test("stale-synthesis: synthesis page committed recently is clean", async () => {
  const root = writeVault({
    "wiki/synthesis/recent.md": page(
      "Recent",
      "volatility: evolving\nsource_date: 2026-01-01\n",
    ),
  });
  const recentTs = Math.floor(Date.now() / 1000) - 5 * 24 * 60 * 60;
  await gitCommit(root, recentTs);
  const findings = await staleSynthesis(root);
  assert.deepEqual(findings, []);
});

test("stale-synthesis: synthesis page committed >30 days ago is a violation", async () => {
  const root = writeVault({
    "wiki/synthesis/old.md": page("Old"),
  });
  const oldTs = Math.floor(Date.now() / 1000) - 45 * 24 * 60 * 60;
  await gitCommit(root, oldTs);
  const findings = await staleSynthesis(root);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].pageRef, "wiki/synthesis/old.md");
  assert.match(findings[0].detail, /days ago/);
});

test("stale-synthesis: concept page >30 days old is NOT a violation", async () => {
  const root = writeVault({
    "wiki/concepts/old-concept.md": page("Old Concept"),
  });
  const oldTs = Math.floor(Date.now() / 1000) - 45 * 24 * 60 * 60;
  await gitCommit(root, oldTs);
  const findings = await staleSynthesis(root);
  assert.deepEqual(findings, []);
});

// ---------------------------------------------------------------------------
// missingVolatilitySourceDate
// ---------------------------------------------------------------------------

test("missing-volatility-source-date: page with both fields is clean", async () => {
  const root = writeVault({
    "wiki/concepts/foo.md": page(
      "Foo",
      "volatility: stable\nsource_date: 2026-01-01\n",
    ),
  });
  const findings = await missingVolatilitySourceDate(root);
  assert.deepEqual(findings, []);
});

test("missing-volatility-source-date: page missing volatility is a violation", async () => {
  const root = writeVault({
    "wiki/concepts/foo.md": page("Foo", "source_date: 2026-01-01\n"),
  });
  const findings = await missingVolatilitySourceDate(root);
  assert.equal(findings.length, 1);
  assert.match(findings[0].detail, /volatility/);
});

test("missing-volatility-source-date: page missing source_date is a violation", async () => {
  const root = writeVault({
    "wiki/concepts/foo.md": page("Foo", "volatility: stable\n"),
  });
  const findings = await missingVolatilitySourceDate(root);
  assert.equal(findings.length, 1);
  assert.match(findings[0].detail, /source_date/);
});

// A malformed edge must not abort the run: the malformed page still reports its
// own findings, and the rest of the run carries on.
test("missing-volatility-source-date: a malformed edge does not abort the run", async () => {
  const root = writeVault({
    "wiki/concepts/a-missing-both.md": page("A"),
    "wiki/concepts/b-malformed.md": page(
      "B",
      "related:\n  - wiki/concepts/a-missing-both.md\n",
    ),
  });
  const findings = await missingVolatilitySourceDate(root);
  assert.deepEqual(findings, [
    {
      pageRef: "wiki/concepts/a-missing-both.md",
      detail: "missing volatility field",
    },
    {
      pageRef: "wiki/concepts/a-missing-both.md",
      detail: "missing source_date field",
    },
    {
      pageRef: "wiki/concepts/b-malformed.md",
      detail: "missing volatility field",
    },
    {
      pageRef: "wiki/concepts/b-malformed.md",
      detail: "missing source_date field",
    },
  ]);
});

// ---------------------------------------------------------------------------
// tagsShape
// ---------------------------------------------------------------------------

test("tags-shape: a list of plain tags is clean", async () => {
  const root = writeVault({
    "wiki/concepts/foo.md": page(
      "Foo",
      "tags:\n  - caching\n  - performance\n",
    ),
  });
  assert.deepEqual(await tagsShape(root), []);
});

test("tags-shape: no tags, an empty list and an explicit null are all clean", async () => {
  const root = writeVault({
    "wiki/concepts/absent.md": page("Absent"),
    "wiki/concepts/empty.md": page("Empty", "tags: []\n"),
    "wiki/concepts/null.md": page("Null", "tags:\n"),
  });
  assert.deepEqual(await tagsShape(root), []);
});

// A delimited list collapsed into one string still reads as a value, but
// indexes as one junk tag no filter matches.
test("tags-shape: a comma-and-quote-bearing entry is a finding naming the value", async () => {
  const root = writeVault({
    "wiki/concepts/foo.md": page(
      "Foo",
      'tags:\n  - windsor", "campaign-tactics", "ground-game\n',
    ),
  });
  assert.deepEqual(await tagsShape(root), [
    {
      pageRef: "wiki/concepts/foo.md",
      detail:
        'tags entry is not a plain tag: "windsor\\", \\"campaign-tactics\\", \\"ground-game"',
    },
  ]);
});

test("tags-shape: a delimited entry folded across two lines is a finding", async () => {
  const root = writeVault({
    "wiki/concepts/foo.md": page(
      "Foo",
      'tags:\n  - campaign-tactics", "canvassing",\n    "ground-game\n',
    ),
  });
  assert.deepEqual(await tagsShape(root), [
    {
      pageRef: "wiki/concepts/foo.md",
      detail:
        'tags entry is not a plain tag: "campaign-tactics\\", \\"canvassing\\", \\"ground-game"',
    },
  ]);
});

test("tags-shape: a scalar value is a finding", async () => {
  const root = writeVault({
    "wiki/concepts/foo.md": page("Foo", "tags: alpha\n"),
  });
  assert.deepEqual(await tagsShape(root), [
    { pageRef: "wiki/concepts/foo.md", detail: 'tags is not a list: "alpha"' },
  ]);
});

test("tags-shape: an entry with whitespace, a comma, a quote or no text is a finding", async () => {
  const root = writeVault({
    "wiki/concepts/foo.md": page(
      "Foo",
      'tags:\n  - ground game\n  - caching,performance\n  - O\'Brien\n  - ""\n',
    ),
  });
  assert.deepEqual(
    (await tagsShape(root)).map((f) => f.detail),
    [
      'tags entry is not a plain tag: "ground game"',
      'tags entry is not a plain tag: "caching,performance"',
      'tags entry is not a plain tag: "O\'Brien"',
      'tags entry is not a plain tag: ""',
    ],
  );
});

// `stringList` renders these to the strings the index stores, so a numeric or
// boolean entry is a reachable tag — only null renders to nothing.
test("tags-shape: a null entry is a finding, a numeric or boolean one is not", async () => {
  const root = writeVault({
    "wiki/concepts/foo.md": page("Foo", "tags:\n  - 42\n  - true\n  -\n"),
  });
  assert.deepEqual(await tagsShape(root), [
    {
      pageRef: "wiki/concepts/foo.md",
      detail: 'tags entry is not a plain tag: ""',
    },
  ]);
});

test("tags-shape: a malformed block is not this check's finding, and does not abort it", async () => {
  const root = writeVault({
    "wiki/concepts/broken.md": "---\ntags: [\n---\nBody.\n",
    "wiki/concepts/foo.md": page("Foo", "tags: alpha\n"),
  });
  assert.deepEqual(await tagsShape(root), [
    { pageRef: "wiki/concepts/foo.md", detail: 'tags is not a list: "alpha"' },
  ]);
});

// ---------------------------------------------------------------------------
// unresolvedSupersession
// ---------------------------------------------------------------------------

const contradictsFm = 'contradicts:\n  - "[Bar](../entities/bar.md)"\n';
const supersedesFm = 'supersedes:\n  - "[Old Bar](../entities/old-bar.md)"\n';
const calloutBody = "> [!warning] Contradiction\nSome conflict noted.\n";

test("unresolved-supersession: contradicts + supersedes is clean", async () => {
  const root = writeVault({
    "wiki/concepts/foo.md": page("Foo", contradictsFm + supersedesFm),
  });
  const findings = await unresolvedSupersession(root);
  assert.deepEqual(findings, []);
});

test("unresolved-supersession: contradicts + no supersedes + active callout is clean (live contradiction, `contradiction-callouts`' domain)", async () => {
  const root = writeVault({
    "wiki/concepts/foo.md": page("Foo", contradictsFm, calloutBody),
  });
  const findings = await unresolvedSupersession(root);
  assert.deepEqual(findings, []);
});

test("unresolved-supersession: contradicts + no supersedes + no callout is a violation", async () => {
  const root = writeVault({
    "wiki/concepts/foo.md": page("Foo", contradictsFm),
  });
  const findings = await unresolvedSupersession(root);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].pageRef, "wiki/concepts/foo.md");
  assert.match(findings[0].detail, /supersedes/);
});

// ---------------------------------------------------------------------------
// contradictionCallouts
// ---------------------------------------------------------------------------

test("contradiction-callouts: page without callout is clean", async () => {
  const root = writeVault({
    "wiki/concepts/foo.md": page("Foo"),
  });
  const findings = await contradictionCallouts(root);
  assert.deepEqual(findings, []);
});

test("contradiction-callouts: page with active Contradiction callout is a violation", async () => {
  const root = writeVault({
    "wiki/concepts/foo.md": page("Foo", "", calloutBody),
  });
  const findings = await contradictionCallouts(root);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].pageRef, "wiki/concepts/foo.md");
});

// ---------------------------------------------------------------------------
// orphans
// ---------------------------------------------------------------------------

test("orphans: page with inbound link is clean", async () => {
  const root = writeVault({
    "wiki/concepts/foo.md": page("Foo", "", "[Bar](../entities/bar.md)\n"),
    "wiki/entities/bar.md": page("Bar"),
  });
  const findings = await orphans(root);
  assert.ok(!findings.some((f) => f.pageRef === "wiki/entities/bar.md"));
});

test("orphans: page with zero inbound links is a violation", async () => {
  const root = writeVault({
    "wiki/concepts/lonely.md": page("Lonely"),
  });
  const findings = await orphans(root);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].pageRef, "wiki/concepts/lonely.md");
});

test("orphans: frontmatter edge counts as inbound link", async () => {
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

test("orphans: folded frontmatter edge counts as inbound link", async () => {
  // A destination folded past the line width with a trailing backslash (YAML
  // escaped line break).
  const root = writeVault({
    "wiki/concepts/foo.md": page(
      "Foo",
      'related:\n  - "[A rather long target page title](../entities/a-rather-long-tar\\\n    get-page-title-that-will-definitely-wrap.md)"\n',
    ),
    "wiki/entities/a-rather-long-target-page-title-that-will-definitely-wrap.md":
      page("A rather long target page title"),
  });
  const findings = await orphans(root);
  assert.ok(
    !findings.some(
      (f) =>
        f.pageRef ===
        "wiki/entities/a-rather-long-target-page-title-that-will-definitely-wrap.md",
    ),
  );
});

// ---------------------------------------------------------------------------
// splitLinks
// ---------------------------------------------------------------------------
//
// Every fixture here is hand-written: the writer emits no fold since ADR-0024.

test("split-links: folded destination is a finding", async () => {
  const root = writeVault({
    "wiki/concepts/foo.md": page(
      "Foo",
      'related:\n  - "[Some long title](../sources/a-really-long-slug-that-wraps-across-l\\\n    ines.md)"\n',
    ),
  });
  const findings = await splitLinks(root);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].pageRef, "wiki/concepts/foo.md");
  // Fourth line: the opening fence, `title:`, `related:`.
  assert.match(findings[0].detail, /destination/);
  assert.match(findings[0].detail, /line 4/);
  assert.match(
    findings[0].detail,
    /a-really-long-slug-that-wraps-across-lines\.md/,
  );
});

test("split-links: folded label is a finding", async () => {
  const root = writeVault({
    "wiki/concepts/foo.md": page(
      "Foo",
      'related:\n  - "[RBWM Council Political\n    Composition](../concepts/rbwm.md)"\n',
    ),
  });
  const findings = await splitLinks(root);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].pageRef, "wiki/concepts/foo.md");
  assert.match(findings[0].detail, /label/);
  assert.match(findings[0].detail, /RBWM Council Political Composition/);
});

test("split-links: a fold between label and destination is a finding", async () => {
  // The break falls at the label/destination boundary, resolved with nothing.
  const root = writeVault({
    "wiki/concepts/foo.md": page(
      "Foo",
      'related:\n  - "[A missing both]\\\n    (../concepts/a-missing-both.md)"\n',
    ),
  });
  const findings = await splitLinks(root);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].pageRef, "wiki/concepts/foo.md");
  assert.match(findings[0].detail, /boundary/);
  // The fold begins on the file's fourth line: the fence, `title:`, `related:`.
  assert.match(findings[0].detail, /line 4/);
});

test("split-links: a boundary fold does not mask a fold in the destination", async () => {
  // One link carrying both folds — the shape a missing link match hid entirely.
  const root = writeVault({
    "wiki/concepts/foo.md": page(
      "Foo",
      'related:\n  - "[A missing both]\\\n    (../sources/a-really-long-slug-that-wraps-across-l\\\n    ines.md)"\n',
    ),
  });
  const findings = await splitLinks(root);
  assert.equal(findings.length, 2);
  assert.ok(findings.some((f) => /boundary/.test(f.detail)));
  assert.ok(findings.some((f) => /destination/.test(f.detail)));
});

test("split-links: a well-formed link on one line is not a finding", async () => {
  const root = writeVault({
    "wiki/concepts/foo.md": page(
      "Foo",
      'raw_source: "[notes.md](../../raw/notes.md)"\nrelated:\n  - "[Bar](../entities/bar.md)"\n',
      "Body links: [Bar](../entities/bar.md) and [x](x.md#ttl).\n",
    ),
  });
  assert.deepEqual(await splitLinks(root), []);
});

test("split-links: a fold inside a block scalar is not a finding", async () => {
  // A `\` at the end of a literal block scalar is content, not a fold
  // (wikipage.ts's `ESCAPED_LINE_BREAK_RE`), and raw text cannot tell the two
  // apart — reporting or joining it would corrupt the literal.
  const root = writeVault({
    "wiki/concepts/foo.md": page(
      "Foo",
      "related: |\n" +
        '  - "[Some long title](../sources/a-really-long-slug-that-wraps-across-l\\\n' +
        '    ines.md)"\n' +
        '  - "[A folded label\n' +
        '    continued](../concepts/other.md)"\n',
    ),
  });
  assert.deepEqual(await splitLinks(root), []);
});

test("split-links: a fold inside a single-quoted scalar is not a finding", async () => {
  // A single-quoted scalar folds a break to a space but keeps `\` literal, so
  // only double-quoted scalars are in scope.
  const root = writeVault({
    "wiki/concepts/foo.md": page(
      "Foo",
      "related:\n  - '[Some long title](../sources/a-really-long-slug\\\n    -that-wraps.md)'\n",
    ),
  });
  assert.deepEqual(await splitLinks(root), []);
});

test("split-links: body destination split across a line break is a finding", async () => {
  // Not a link under CommonMark, so `iterLinks` never sees it and `vault move`
  // would leave it dangling.
  const root = writeVault({
    "wiki/concepts/foo.md": page(
      "Foo",
      "",
      "See [composition](../concepts/rbwm-council-political-\ncomposition.md) for details.\n",
    ),
  });
  const findings = await splitLinks(root);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].pageRef, "wiki/concepts/foo.md");
  assert.match(findings[0].detail, /body/);
  // The fourth line: the opening fence, `title:`, the closing fence.
  assert.match(findings[0].detail, /line 4/);
});

test("split-links: a break after a destination is legal markdown, not a finding", async () => {
  // `[T](path.md` / `"title")` is a legal link; joining on sight would silently
  // repoint it.
  const root = writeVault({
    "wiki/concepts/foo.md": page(
      "Foo",
      "",
      '[Bar](../entities/bar.md\n"the title") and [Baz](../entities/baz.md\n)\n',
    ),
  });
  assert.deepEqual(await splitLinks(root), []);
});

test("split-links: a split inside a fenced code block is not a finding", async () => {
  // `iterLinks` skips code blocks; a split there is not a link either.
  const root = writeVault({
    "wiki/concepts/foo.md": page(
      "Foo",
      "",
      "```\n[a](../concepts/rbwm-council-political-\ncomposition.md)\n```\n",
    ),
  });
  assert.deepEqual(await splitLinks(root), []);
});

// ---------------------------------------------------------------------------
// duplicateFrontmatter
// ---------------------------------------------------------------------------

const fmBlock = (extra = ""): string =>
  `---\ntitle: Foo\nsummary: s\n${extra}---\n`;

test("duplicate-frontmatter: a second block after the first is a finding", async () => {
  const root = writeVault({
    "wiki/concepts/foo.md": fmBlock() + fmBlock() + "Body text.\n",
  });
  const findings = await duplicateFrontmatter(root);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].pageRef, "wiki/concepts/foo.md");
  assert.match(findings[0].detail, /2 frontmatter blocks/);
  assert.match(findings[0].detail, /parser reads only the first/);
});

test("duplicate-frontmatter: a stale subset block reports as fixable", async () => {
  const root = writeVault({
    "wiki/concepts/foo.md":
      fmBlock('related:\n  - "[Bar](../entities/bar.md)"\n') +
      fmBlock() +
      "Body text.\n",
  });
  const findings = await duplicateFrontmatter(root);
  assert.equal(findings.length, 1);
  assert.match(findings[0].detail, /fix collapses/);
});

test("duplicate-frontmatter: divergent blocks report as a hand merge", async () => {
  const root = writeVault({
    "wiki/concepts/foo.md":
      "---\ntitle: Foo\nsummary: s\n---\n" +
      "---\ntitle: Bar\nsummary: t\n---\n" +
      "Body text.\n",
  });
  const findings = await duplicateFrontmatter(root);
  assert.equal(findings.length, 1);
  assert.match(findings[0].detail, /merge by hand/);
});

test("duplicate-frontmatter: three blocks are one finding", async () => {
  const root = writeVault({
    "wiki/concepts/foo.md": fmBlock() + fmBlock() + fmBlock() + "Body text.\n",
  });
  const findings = await duplicateFrontmatter(root);
  assert.equal(findings.length, 1);
  assert.match(findings[0].detail, /3 frontmatter blocks/);
});

test("duplicate-frontmatter: one block is clean", async () => {
  const root = writeVault({
    "wiki/concepts/foo.md": fmBlock() + "Body text.\n",
  });
  assert.deepEqual(await duplicateFrontmatter(root), []);
});

test("duplicate-frontmatter: a thematic break in the body is not a second block", async () => {
  const root = writeVault({
    "wiki/concepts/foo.md": fmBlock() + "\n# Heading\n\n---\n\nmore\n",
  });
  assert.deepEqual(await duplicateFrontmatter(root), []);
});

test("duplicate-frontmatter: an unclosed fence is not a second block", async () => {
  const root = writeVault({
    "wiki/concepts/foo.md": fmBlock() + "---\nprose, with no closing fence\n",
  });
  assert.deepEqual(await duplicateFrontmatter(root), []);
});

test("duplicate-frontmatter: a blank line between blocks is still a finding", async () => {
  const root = writeVault({
    "wiki/concepts/foo.md": fmBlock() + "\n" + fmBlock() + "Body text.\n",
  });
  const findings = await duplicateFrontmatter(root);
  assert.equal(findings.length, 1);
  assert.match(findings[0].detail, /2 frontmatter blocks/);
  assert.match(findings[0].detail, /fix collapses/);
});

test("duplicate-frontmatter: a body opening with a blank line and a break is not a block", async () => {
  const root = writeVault({
    "wiki/concepts/foo.md": fmBlock() + "\n---\nprose, not YAML\n",
  });
  assert.deepEqual(await duplicateFrontmatter(root), []);
});

test("duplicate-frontmatter: an empty second block is a finding", async () => {
  const root = writeVault({
    "wiki/concepts/foo.md": fmBlock() + "---\n---\nBody text.\n",
  });
  const findings = await duplicateFrontmatter(root);
  assert.equal(findings.length, 1);
  assert.match(findings[0].detail, /fix collapses/);
});

test("duplicate-frontmatter: an unreadable second block asks for a hand merge", async () => {
  const root = writeVault({
    "wiki/concepts/foo.md": fmBlock() + "---\n- a\n- b\n---\nBody text.\n",
  });
  const findings = await duplicateFrontmatter(root);
  assert.equal(findings.length, 1);
  assert.match(findings[0].detail, /not a readable mapping/);
});

test("duplicate-frontmatter: a comment-only block is not auto-fixed", async () => {
  // `# Section` is a YAML comment but markdown prose, so the fix must not
  // delete the body region it fences.
  const src = fmBlock() + "---\n# Section\n---\nBody text.\n";
  const root = writeVault({ "wiki/concepts/foo.md": src });
  const findings = await duplicateFrontmatter(root);
  assert.equal(findings.length, 1);
  assert.match(findings[0].detail, /not a readable mapping/);
  assert.deepEqual(await fixDuplicateFrontmatter(root), []);
  assert.equal(
    fs.readFileSync(path.join(root, "wiki/concepts/foo.md"), "utf8"),
    src,
  );
});

test("duplicate-frontmatter: a page without frontmatter is clean", async () => {
  const root = writeVault({
    "wiki/concepts/foo.md": "# Heading\n\nBody text.\n",
  });
  assert.deepEqual(await duplicateFrontmatter(root), []);
});

// ---------------------------------------------------------------------------
// CHECKS registry
// ---------------------------------------------------------------------------

test("CHECKS registry contains all twelve check names", () => {
  const expected = [
    "kind-folder-conformance",
    "ingestion-source-integrity",
    "frontmatter-link-format",
    "tags-shape",
    "stale-synthesis",
    "missing-volatility-source-date",
    "unresolved-supersession",
    "contradiction-callouts",
    "orphans",
    "split-links",
    "duplicate-frontmatter",
    "concept-fragmentation",
  ];
  for (const name of expected) {
    assert.ok(name in CHECKS, `CHECKS missing: ${name}`);
    assert.equal(typeof CHECKS[name], "function");
  }
  assert.equal(Object.keys(CHECKS).length, expected.length);
});

// ---------------------------------------------------------------------------
// Fix — fixFrontmatterLinkFormat
// ---------------------------------------------------------------------------

test("fix frontmatter-link-format: quotes unquoted YAML list link", async () => {
  const root = writeVault({
    "wiki/concepts/foo.md":
      "---\ntitle: Foo\nrelated:\n  - [Bar](../entities/bar.md)\n---\nBody.\n",
  });
  const changed = await fixFrontmatterLinkFormat(root);
  assert.deepEqual(changed, ["wiki/concepts/foo.md"]);
  const text = fs.readFileSync(path.join(root, "wiki/concepts/foo.md"), "utf8");
  assert.match(text, /- "\[Bar\]/);
  const findings = await frontmatterLinkFormat(root);
  assert.deepEqual(findings, []);
});

test("fix frontmatter-link-format: leaves an anchor-carrying destination byte-identical", async () => {
  // `#ttl` is a heading fragment; encoding it as `%23ttl` turns a working link
  // into a dangling filename.
  const root = writeVault({
    "wiki/concepts/foo.md": page(
      "Foo",
      'related:\n  - "[Cache TTL](../concepts/caching.md#ttl)"\n',
    ),
    "wiki/concepts/caching.md": page("Caching"),
  });
  const file = path.join(root, "wiki/concepts/foo.md");
  const before = fs.readFileSync(file, "utf8");
  const changed = await fixFrontmatterLinkFormat(root);
  assert.deepEqual(changed, []);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("fix frontmatter-link-format: leaves a %23 filename destination alone", async () => {
  const root = writeVault({
    "wiki/concepts/foo.md": page(
      "Foo",
      'related:\n  - "[Bar](../entities/bar%23baz.md)"\n',
    ),
  });
  const file = path.join(root, "wiki/concepts/foo.md");
  const before = fs.readFileSync(file, "utf8");
  const changed = await fixFrontmatterLinkFormat(root);
  assert.deepEqual(changed, []);
  assert.equal(fs.readFileSync(file, "utf8"), before);
});

test("fix frontmatter-link-format: fixes an unencoded path and keeps the anchor", async () => {
  const src =
    "---\n" +
    "title: Foo\n" +
    'summary: "A summary: with a colon, a comma and (parens)"\n' +
    "tags: [alpha, beta]\n" +
    "source_date: 2026-01-02\n" +
    "volatility: stable\n" +
    "related:\n" +
    '  - "[Bar](../entities/my(page).md#ttl)"\n' +
    "---\nBody.\n";
  const root = writeVault({ "wiki/concepts/foo.md": src });
  const changed = await fixFrontmatterLinkFormat(root);
  assert.deepEqual(changed, ["wiki/concepts/foo.md"]);
  const text = fs.readFileSync(path.join(root, "wiki/concepts/foo.md"), "utf8");

  // The anchor survives as an anchor, never as a filename character.
  assert.doesNotMatch(text, /%23ttl/);
  // Byte-level: one destination re-encoded, every other byte untouched
  // (ADR-0012's relaxed round-trip).
  assert.equal(
    text,
    src.replace(
      "../entities/my(page).md#ttl",
      "../entities/my%28page%29.md#ttl",
    ),
  );
  assert.deepEqual(await frontmatterLinkFormat(root), []);
});

test("fix frontmatter-link-format: repairs a folded destination whole", async () => {
  // The splice must consume the backslash continuation, or a stray `\` breaks
  // the YAML.
  const root = writeVault({
    "wiki/concepts/foo.md": page(
      "Foo",
      'related:\n  - "[Bar](../entities/bar(draft)\\\n    .md#ttl)"\n',
    ),
  });
  const changed = await fixFrontmatterLinkFormat(root);
  assert.deepEqual(changed, ["wiki/concepts/foo.md"]);
  const text = fs.readFileSync(path.join(root, "wiki/concepts/foo.md"), "utf8");
  assert.match(text, /- "\[Bar\]\(\.\.\/entities\/bar%28draft%29\.md#ttl\)"/);
  assert.doesNotMatch(text, /%23ttl/);
  // The anchor is a fragment, not part of the target: read the edge back through
  // the YAML parser, not the raw-text link scan.
  const findings = await frontmatterLinkFormat(root);
  assert.deepEqual(findings, []);
  assert.deepEqual(newPageRecord("wiki/concepts/foo.md", text).edges, [
    { key: "related", targets: ["wiki/entities/bar(draft).md"] },
  ]);
});

test("fix frontmatter-link-format: clean file is not modified", async () => {
  const root = writeVault({
    "wiki/concepts/foo.md": page(
      "Foo",
      'related:\n  - "[Bar](../entities/bar.md)"\n',
    ),
  });
  const changed = await fixFrontmatterLinkFormat(root);
  assert.deepEqual(changed, []);
});

// ---------------------------------------------------------------------------
// Fix — fixIngestionSourceIntegrity
// ---------------------------------------------------------------------------

test("fix ingestion-source-integrity: moves raw/ body link to raw_source frontmatter", async () => {
  const root = writeVault({
    "wiki/sources/doc.md":
      "---\ntitle: Doc\n---\nSome body text.\n[doc.md](../../raw/doc.md)\nMore text.\n",
  });
  const changed = await fixIngestionSourceIntegrity(root);
  assert.deepEqual(changed, ["wiki/sources/doc.md"]);
  const text = fs.readFileSync(path.join(root, "wiki/sources/doc.md"), "utf8");
  assert.match(text, /raw_source: "\[doc\.md\]\(\.\.\/\.\.\/raw\/doc\.md\)"/);
  assert.doesNotMatch(
    text.split("---\n").slice(2).join("---\n"),
    /raw\/doc\.md/,
  );
  const findings = await ingestionSourceIntegrity(root);
  assert.deepEqual(findings, []);
});

test("fix ingestion-source-integrity: skips if raw_source already present", async () => {
  const root = writeVault({
    "wiki/sources/doc.md": page(
      "Doc",
      'raw_source: "[doc.md](../../raw/doc.md)"\n',
    ),
  });
  const changed = await fixIngestionSourceIntegrity(root);
  assert.deepEqual(changed, []);
});

test("fix ingestion-source-integrity: skips if multiple raw/ links (ambiguous)", async () => {
  const root = writeVault({
    "wiki/sources/doc.md":
      "---\ntitle: Doc\n---\n[a.md](../../raw/a.md)\n[b.md](../../raw/b.md)\n",
  });
  const changed = await fixIngestionSourceIntegrity(root);
  assert.deepEqual(changed, []);
});

// ---------------------------------------------------------------------------
// Fix — fixMissingCrossReferences
// ---------------------------------------------------------------------------

test("fix missing-cross-references: inserts link for unambiguous exact title mention", async () => {
  const root = writeVault({
    "wiki/concepts/alpha.md": page("Alpha", "", "Some text about Beta here.\n"),
    "wiki/concepts/beta.md": page("Beta"),
  });
  const changed = await fixMissingCrossReferences(root);
  assert.deepEqual(changed, ["wiki/concepts/alpha.md"]);
  const text = fs.readFileSync(
    path.join(root, "wiki/concepts/alpha.md"),
    "utf8",
  );
  assert.match(text, /\[Beta\]\(beta\.md\)/);
});

test("fix missing-cross-references: skips title already linked", async () => {
  const root = writeVault({
    "wiki/concepts/alpha.md": page(
      "Alpha",
      "",
      "Some [Beta](../concepts/beta.md) text.\n",
    ),
    "wiki/concepts/beta.md": page("Beta"),
  });
  const changed = await fixMissingCrossReferences(root);
  assert.deepEqual(changed, []);
});

test("fix missing-cross-references: skips ambiguous titles (multiple pages same title)", async () => {
  const root = writeVault({
    "wiki/concepts/alpha.md": page("Alpha", "", "Gamma appears here.\n"),
    "wiki/concepts/gamma1.md": page("Gamma"),
    "wiki/entities/gamma2.md": page("Gamma"),
  });
  const changed = await fixMissingCrossReferences(root);
  assert.deepEqual(changed, []);
});

// ---------------------------------------------------------------------------
// Fix — fixSplitLinks
// ---------------------------------------------------------------------------

test("fix split-links: joins a folded destination with nothing", async () => {
  const src = page(
    "Foo",
    'related:\n  - "[Some long title](../sources/a-really-long-slug-that-wraps-across-l\\\n    ines.md)"\n',
  );
  const root = writeVault({ "wiki/concepts/foo.md": src });
  const changed = await fixSplitLinks(root);
  assert.deepEqual(changed, ["wiki/concepts/foo.md"]);
  const text = fs.readFileSync(path.join(root, "wiki/concepts/foo.md"), "utf8");

  // The backslash and the continuation's indentation are not content, so the
  // join inserts nothing.
  assert.equal(
    text,
    src.replace(
      "../sources/a-really-long-slug-that-wraps-across-l\\\n    ines.md",
      "../sources/a-really-long-slug-that-wraps-across-lines.md",
    ),
  );
  assert.deepEqual(await splitLinks(root), []);
});

test("fix split-links: joins a folded label with a single space", async () => {
  const src = page(
    "Foo",
    'related:\n  - "[RBWM Council Political\n    Composition](../concepts/rbwm.md)"\n',
  );
  const root = writeVault({ "wiki/concepts/foo.md": src });
  const changed = await fixSplitLinks(root);
  assert.deepEqual(changed, ["wiki/concepts/foo.md"]);
  const text = fs.readFileSync(path.join(root, "wiki/concepts/foo.md"), "utf8");

  // YAML folds a break inside a quoted scalar to a space, so the join inserts
  // exactly one.
  assert.equal(
    text,
    src.replace(
      "RBWM Council Political\n    Composition",
      "RBWM Council Political Composition",
    ),
  );
  assert.deepEqual(await splitLinks(root), []);
});

test("fix split-links: joins a boundary fold with nothing", async () => {
  // The escaped break at the boundary drops the backslash and the indent, so
  // the join inserts nothing and `]\⏎  (` becomes `](`.
  const src = page(
    "Foo",
    'related:\n  - "[A missing both]\\\n    (../concepts/a-missing-both.md)"\n',
  );
  const root = writeVault({ "wiki/concepts/foo.md": src });
  const changed = await fixSplitLinks(root);
  assert.deepEqual(changed, ["wiki/concepts/foo.md"]);
  const text = fs.readFileSync(path.join(root, "wiki/concepts/foo.md"), "utf8");
  assert.equal(text, src.replace("]\\\n    (", "]("));
  assert.deepEqual(await splitLinks(root), []);

  // The edge reads back unchanged through the YAML parser.
  assert.deepEqual(newPageRecord("wiki/concepts/foo.md", text).edges, [
    {
      key: "related",
      targets: ["wiki/concepts/a-missing-both.md"],
    },
  ]);
});

test("fix split-links: joins a boundary fold and a destination fold together", async () => {
  // One link split across three lines — both a boundary fold and a destination
  // fold, which the fixer left untouched while reporting the vault clean.
  const src = page(
    "Foo",
    'raw_source: "[2026-09-14-2127-bce-2023-review-volume-two-south-east-windsor.md]\\\n  (../../raw/sources/2026-09-14-2127-bce-2023-review-volume-two-south-east-wind\\\n  sor.md)"\n',
  );
  const root = writeVault({ "wiki/sources/foo.md": src });
  const changed = await fixSplitLinks(root);
  assert.deepEqual(changed, ["wiki/sources/foo.md"]);
  const text = fs.readFileSync(path.join(root, "wiki/sources/foo.md"), "utf8");
  assert.equal(
    text,
    src.replace(
      "]\\\n  (../../raw/sources/2026-09-14-2127-bce-2023-review-volume-two-south-east-wind\\\n  sor.md)",
      "](../../raw/sources/2026-09-14-2127-bce-2023-review-volume-two-south-east-windsor.md)",
    ),
  );
  assert.deepEqual(await splitLinks(root), []);
  assert.deepEqual(newPageRecord("wiki/sources/foo.md", text).edges, [
    {
      key: "raw_source",
      targets: [
        "raw/sources/2026-09-14-2127-bce-2023-review-volume-two-south-east-windsor.md",
      ],
    },
  ]);
});

test("fix split-links: both folds on one link, every other byte untouched", async () => {
  // ADR-0012: only the spliced regions may differ, so nothing here
  // re-serialises the block — key order, quote styles and spacing survive.
  const src =
    "---\n" +
    "title: Foo\n" +
    'summary: "A summary: with a colon, a comma and (parens)"\n' +
    "tags: [alpha, beta]\n" +
    "source_date: 2026-01-02\n" +
    "volatility: stable\n" +
    "related:\n" +
    '  - "[A rather long label\n    continued](../entities/a-rather-long-tar\\\n    get-page-title.md)"\n' +
    "---\nBody.\n";
  const root = writeVault({ "wiki/concepts/foo.md": src });

  const changed = await fixSplitLinks(root);
  assert.deepEqual(changed, ["wiki/concepts/foo.md"]);
  const text = fs.readFileSync(path.join(root, "wiki/concepts/foo.md"), "utf8");
  assert.equal(
    text,
    "---\n" +
      "title: Foo\n" +
      'summary: "A summary: with a colon, a comma and (parens)"\n' +
      "tags: [alpha, beta]\n" +
      "source_date: 2026-01-02\n" +
      "volatility: stable\n" +
      "related:\n" +
      '  - "[A rather long label continued](../entities/a-rather-long-target-page-title.md)"\n' +
      "---\nBody.\n",
  );

  // The edge reads back through the YAML parser unchanged: the join is
  // semantics-preserving, not merely tidy.
  assert.deepEqual(newPageRecord("wiki/concepts/foo.md", text).edges, [
    {
      key: "related",
      targets: ["wiki/entities/a-rather-long-target-page-title.md"],
    },
  ]);
  assert.deepEqual(await splitLinks(root), []);
});

test("fix split-links: never touches a body split", async () => {
  // A body split is report-only: a fixer joining on sight can silently repoint
  // a path, so the file must stay byte-identical.
  const src = page(
    "Foo",
    "",
    "See [composition](../concepts/rbwm-council-political-\ncomposition.md) for details.\n",
  );
  const root = writeVault({ "wiki/concepts/foo.md": src });
  const changed = await fixSplitLinks(root);
  assert.deepEqual(changed, []);
  assert.equal(
    fs.readFileSync(path.join(root, "wiki/concepts/foo.md"), "utf8"),
    src,
  );
});

test("fix split-links: leaves a block scalar alone", async () => {
  const src = page(
    "Foo",
    "related: |\n" +
      '  - "[Some long title](../sources/a-really-long-slug-that-wraps-across-l\\\n' +
      '    ines.md)"\n',
  );
  const root = writeVault({ "wiki/concepts/foo.md": src });
  const changed = await fixSplitLinks(root);
  assert.deepEqual(changed, []);
  assert.equal(
    fs.readFileSync(path.join(root, "wiki/concepts/foo.md"), "utf8"),
    src,
  );
});

test("fix split-links: clean page is not modified", async () => {
  const root = writeVault({
    "wiki/concepts/foo.md": page(
      "Foo",
      'related:\n  - "[Bar](../entities/bar.md)"\n',
    ),
  });
  assert.deepEqual(await fixSplitLinks(root), []);
});

// ---------------------------------------------------------------------------
// fix duplicateFrontmatter
// ---------------------------------------------------------------------------

test("fix duplicate-frontmatter: drops a stale block that repeats the first's keys", async () => {
  const repaired = fmBlock('related:\n  - "[Bar](../entities/bar.md)"\n');
  const root = writeVault({
    "wiki/concepts/foo.md": repaired + fmBlock() + "Body text.\n",
  });
  assert.deepEqual(await fixDuplicateFrontmatter(root), [
    "wiki/concepts/foo.md",
  ]);
  assert.equal(
    fs.readFileSync(path.join(root, "wiki/concepts/foo.md"), "utf8"),
    repaired + "Body text.\n",
  );
  assert.deepEqual(await duplicateFrontmatter(root), []);
});

test("fix duplicate-frontmatter: promotes a later block that holds the first's keys", async () => {
  const repaired = fmBlock('related:\n  - "[Bar](../entities/bar.md)"\n');
  const root = writeVault({
    "wiki/concepts/foo.md": fmBlock() + repaired + "Body text.\n",
  });
  assert.deepEqual(await fixDuplicateFrontmatter(root), [
    "wiki/concepts/foo.md",
  ]);
  assert.equal(
    fs.readFileSync(path.join(root, "wiki/concepts/foo.md"), "utf8"),
    repaired + "Body text.\n",
  );
});

test("fix duplicate-frontmatter: identical blocks collapse to the first", async () => {
  const root = writeVault({
    "wiki/concepts/foo.md": fmBlock() + fmBlock() + "Body text.\n",
  });
  assert.deepEqual(await fixDuplicateFrontmatter(root), [
    "wiki/concepts/foo.md",
  ]);
  assert.equal(
    fs.readFileSync(path.join(root, "wiki/concepts/foo.md"), "utf8"),
    fmBlock() + "Body text.\n",
  );
});

test("fix duplicate-frontmatter: divergent blocks are left alone", async () => {
  const src =
    "---\ntitle: Foo\nsummary: s\n---\n" +
    "---\ntitle: Bar\nsummary: t\n---\n" +
    "Body text.\n";
  const root = writeVault({ "wiki/concepts/foo.md": src });
  assert.deepEqual(await fixDuplicateFrontmatter(root), []);
  assert.equal(
    fs.readFileSync(path.join(root, "wiki/concepts/foo.md"), "utf8"),
    src,
  );
});

test("fix duplicate-frontmatter: an unparseable second block is left alone", async () => {
  const src = fmBlock() + "---\ntitle: [unclosed\n---\nBody text.\n";
  const root = writeVault({ "wiki/concepts/foo.md": src });
  assert.deepEqual(await fixDuplicateFrontmatter(root), []);
  assert.equal(
    fs.readFileSync(path.join(root, "wiki/concepts/foo.md"), "utf8"),
    src,
  );
});

test("fix duplicate-frontmatter: drops an empty second block", async () => {
  const root = writeVault({
    "wiki/concepts/foo.md": fmBlock() + "---\n---\nBody text.\n",
  });
  assert.deepEqual(await fixDuplicateFrontmatter(root), [
    "wiki/concepts/foo.md",
  ]);
  assert.equal(
    fs.readFileSync(path.join(root, "wiki/concepts/foo.md"), "utf8"),
    fmBlock() + "Body text.\n",
  );
});

test("fix duplicate-frontmatter: collapses blocks separated by a blank line", async () => {
  const root = writeVault({
    "wiki/concepts/foo.md": fmBlock() + "\n" + fmBlock() + "Body text.\n",
  });
  assert.deepEqual(await fixDuplicateFrontmatter(root), [
    "wiki/concepts/foo.md",
  ]);
  assert.equal(
    fs.readFileSync(path.join(root, "wiki/concepts/foo.md"), "utf8"),
    fmBlock() + "Body text.\n",
  );
});

test("fix duplicate-frontmatter: clean page is not modified", async () => {
  const src = fmBlock() + "Body text.\n";
  const root = writeVault({ "wiki/concepts/foo.md": src });
  assert.deepEqual(await fixDuplicateFrontmatter(root), []);
  assert.equal(
    fs.readFileSync(path.join(root, "wiki/concepts/foo.md"), "utf8"),
    src,
  );
});

// ---------------------------------------------------------------------------
// FIXES registry
// ---------------------------------------------------------------------------

test("FIXES registry contains all five fix names", () => {
  const expected = [
    "frontmatter-link-format",
    "ingestion-source-integrity",
    "missing-cross-references",
    "split-links",
    "duplicate-frontmatter",
  ];
  for (const name of expected) {
    assert.ok(name in FIXES, `FIXES missing: ${name}`);
    assert.equal(typeof FIXES[name], "function");
  }
  assert.equal(Object.keys(FIXES).length, expected.length);
});

// ---------------------------------------------------------------------------
// conceptFragmentation
// ---------------------------------------------------------------------------

/** Minimal page with tags, for the fragmentation fixtures. */
function taggedPage(
  title: string,
  tags: string[],
  body = "Body text.\n",
): string {
  const lines = tags.map((t) => `  - ${t}`).join("\n");
  return `---\ntitle: ${title}\ntags:\n${lines}\n---\n${body}`;
}

/** [writeVault] plus a git commit, so the index has a HEAD to read (ADR-0015)
 * and every page a committed byte size. */
async function writeCommittedVault(
  pages: Record<string, string>,
): Promise<string> {
  const root = writeVault(pages);
  await gitCommit(root, 1700000000);
  return root;
}

/** The fragmentation fixture: one concept pair above the default bar, a
 * custom-kind pair that opts in only when its KIND.md says so, one
 * shared-tag-only concept pair between the bar and 0.3 so the cutoff has
 * something to move, and near-identical pages of the out-of-scope kinds. */
const FRAGMENTATION_FIXTURE: Record<string, string> = {
  "wiki/concepts/cache-eviction.md": taggedPage(
    "Cache eviction",
    ["caching", "performance"],
    "See [cache invalidation](cache-invalidation.md).\n",
  ),
  "wiki/concepts/cache-invalidation.md": taggedPage("Cache invalidation", [
    "caching",
    "performance",
  ]),
  "wiki/tools/redis.md": taggedPage("Redis cache", ["caching", "datastore"]),
  "wiki/tools/memcached.md": taggedPage("Memcached cache", [
    "caching",
    "datastore",
  ]),
  "wiki/concepts/throughput.md": taggedPage("Throughput", ["resilience"]),
  "wiki/concepts/latency.md": taggedPage("Latency", ["resilience"]),
  "wiki/entities/cache.md": taggedPage("Cache eviction", [
    "caching",
    "performance",
  ]),
  "wiki/sources/cache.md": taggedPage("Cache invalidation", [
    "caching",
    "performance",
  ]),
  "wiki/synthesis/cache.md": taggedPage("Cache strategy", [
    "caching",
    "performance",
  ]),
};

type Findings = Awaited<ReturnType<typeof conceptFragmentation>>;

/** The cluster a finding belongs to, found by one of its member refs. */
function clusterWith(findings: Findings, ref: string) {
  const finding = findings.find((f) =>
    f.cluster?.members.some((m) => m.pageRef === ref),
  );
  assert.ok(finding, `no cluster contains ${ref}`);
  return finding.cluster;
}

function memberRefs(findings: Findings): string[] {
  return findings.flatMap(
    (f) => f.cluster?.members.map((m) => m.pageRef) ?? [],
  );
}

test("concept-fragmentation: clusters closely-related concept pages at the default bar", async () => {
  const root = await writeCommittedVault(FRAGMENTATION_FIXTURE);
  const findings = await conceptFragmentation(root);

  // One proposal per cluster, anchored on the suggested survivor. The
  // custom-kind pair is out of scope until its kind opts in.
  assert.deepEqual(
    findings.map((f) => f.pageRef),
    ["wiki/concepts/cache-invalidation.md"],
  );
  assert.deepEqual(
    clusterWith(findings, "wiki/concepts/cache-eviction.md")!.members.map(
      (m) => m.pageRef,
    ),
    ["wiki/concepts/cache-eviction.md", "wiki/concepts/cache-invalidation.md"],
  );
});

test("concept-fragmentation: a finding carries member sizes, inbound counts, basis and a survivor", async () => {
  const root = await writeCommittedVault(FRAGMENTATION_FIXTURE);
  const cluster = clusterWith(
    await conceptFragmentation(root),
    "wiki/concepts/cache-eviction.md",
  )!;
  const members = new Map(cluster.members.map((m) => [m.pageRef, m]));

  assert.equal(
    members.get("wiki/concepts/cache-eviction.md")!.bytes,
    Buffer.byteLength(
      FRAGMENTATION_FIXTURE["wiki/concepts/cache-eviction.md"],
      "utf8",
    ),
  );
  assert.equal(members.get("wiki/concepts/cache-eviction.md")!.inbound, 0);
  assert.equal(members.get("wiki/concepts/cache-invalidation.md")!.inbound, 1);
  // Most inbound links wins, so the survivor is the linked-to page, not the
  // larger one.
  assert.equal(
    cluster.suggestedSurvivor,
    "wiki/concepts/cache-invalidation.md",
  );
  assert.deepEqual(cluster.basis, {
    tags: ["caching", "performance"],
    titleTokens: ["cache"],
  });
  // Combined Jaccard: 2 shared tags + 1 shared title word over 2 + 3 union.
  assert.ok(Math.abs(cluster.similarity - 0.6) < 1e-9);
});

test("concept-fragmentation: a custom kind is out of scope until its KIND.md opts in", async () => {
  const root = await writeCommittedVault(FRAGMENTATION_FIXTURE);
  assert.ok(
    !memberRefs(await conceptFragmentation(root)).includes(
      "wiki/tools/redis.md",
    ),
  );

  // The declaration is vault configuration read from the working tree, so an
  // uncommitted KIND.md is enough (ADR-0027).
  fs.writeFileSync(
    path.join(root, "wiki", "tools", "KIND.md"),
    "---\nkind: tool\nsummary: A tool.\nconsolidatable: true\n---\n",
  );
  const cluster = clusterWith(
    await conceptFragmentation(root),
    "wiki/tools/redis.md",
  )!;
  assert.deepEqual(
    cluster.members.map((m) => m.pageRef),
    ["wiki/tools/memcached.md", "wiki/tools/redis.md"],
  );
});

test("concept-fragmentation: entity and source pages are never members", async () => {
  const root = await writeCommittedVault(FRAGMENTATION_FIXTURE);
  // At 0.3 every in-scope near-duplicate is clustered, so a floor kind leaking
  // in would show up here.
  const findings = await conceptFragmentation(root, { minSimilarity: 0.3 });
  for (const ref of memberRefs(findings)) {
    assert.ok(
      !/^wiki\/(entities|sources)\//.test(ref),
      `${ref} is out of scope`,
    );
  }
  assert.ok(!memberRefs(findings).some((r) => r.startsWith("wiki/synthesis/")));
  assert.ok(memberRefs(findings).includes("wiki/concepts/cache-eviction.md"));
});

test("concept-fragmentation: a cluster never mixes kinds", async () => {
  const root = await writeCommittedVault({
    "wiki/concepts/cache-eviction.md": taggedPage("Cache eviction", [
      "caching",
    ]),
    "wiki/synthesis/cache-strategy.md": taggedPage("Cache eviction", [
      "caching",
    ]),
    "wiki/synthesis/cache-plan.md": taggedPage("Cache eviction", ["caching"]),
  });
  // Synthesis opts in with the flag alone — no `kind:` needed.
  fs.writeFileSync(
    path.join(root, "wiki", "synthesis", "KIND.md"),
    "---\nconsolidatable: true\n---\n",
  );

  const findings = await conceptFragmentation(root);
  assert.deepEqual(
    findings.map((f) => f.pageRef),
    ["wiki/synthesis/cache-plan.md"],
  );
  assert.deepEqual(
    clusterWith(findings, "wiki/synthesis/cache-strategy.md")!.members.map(
      (m) => m.pageRef,
    ),
    ["wiki/synthesis/cache-plan.md", "wiki/synthesis/cache-strategy.md"],
  );
  // Every page here scores 1.0 pairwise, so without kind-homogeneity the
  // concept would have joined the synthesis cluster.
  assert.ok(!memberRefs(findings).includes("wiki/concepts/cache-eviction.md"));
});

test("concept-fragmentation: concept cannot be declared out", async () => {
  const root = await writeCommittedVault(FRAGMENTATION_FIXTURE);
  fs.writeFileSync(
    path.join(root, "wiki", "concepts", "KIND.md"),
    "---\nconsolidatable: false\n---\n",
  );
  assert.ok(
    memberRefs(await conceptFragmentation(root)).includes(
      "wiki/concepts/cache-eviction.md",
    ),
  );
});

test("concept-fragmentation: --min-similarity moves the Consolidation/link boundary", async () => {
  const root = await writeCommittedVault(FRAGMENTATION_FIXTURE);

  const byDefault = memberRefs(await conceptFragmentation(root));
  assert.deepEqual(
    memberRefs(
      await conceptFragmentation(root, {
        minSimilarity: DefaultMinSimilarity,
      }),
    ),
    byDefault,
  );
  // One shared tag and no shared title word is 1/3 — a link, not a
  // Consolidation, at the default bar.
  assert.ok(!byDefault.includes("wiki/concepts/throughput.md"));
  assert.ok(!byDefault.includes("wiki/concepts/latency.md"));

  const relaxed = memberRefs(
    await conceptFragmentation(root, { minSimilarity: 0.3 }),
  );
  assert.ok(relaxed.includes("wiki/concepts/throughput.md"));
  assert.ok(relaxed.includes("wiki/concepts/latency.md"));
});

test("concept-fragmentation: detection is a view of HEAD — an uncommitted draft is invisible", async () => {
  const root = await writeCommittedVault(FRAGMENTATION_FIXTURE);
  fs.writeFileSync(
    path.join(root, "wiki/concepts/cache-eviction-draft.md"),
    taggedPage("Cache eviction", ["caching", "performance"]),
  );
  const refs = memberRefs(await conceptFragmentation(root));
  assert.ok(!refs.includes("wiki/concepts/cache-eviction-draft.md"));
  assert.ok(refs.includes("wiki/concepts/cache-eviction.md"));
});

test("concept-fragmentation: a vault with no clusters is silent", async () => {
  const root = await writeCommittedVault({
    "wiki/concepts/alpha.md": taggedPage("Alpha", ["one"]),
    "wiki/concepts/beta.md": taggedPage("Beta", ["two"]),
  });
  assert.deepEqual(await conceptFragmentation(root), []);
});

test("titleTokens: lowercases, drops stopwords and one-character words", () => {
  assert.deepEqual([...titleTokens("A/B Testing of the Caching")].sort(), [
    "caching",
    "testing",
  ]);
});
