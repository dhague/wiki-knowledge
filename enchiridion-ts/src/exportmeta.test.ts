import { test } from "node:test";
import assert from "node:assert/strict";
import { loadRecords, type PageRecord } from "./pagerecord.js";
import { buildExportMeta } from "./exportmeta.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const conceptA = `---
title: Alpha Concept
summary: The first concept.
tags:
  - alpha
  - shared
kind: concept
---

See also [Beta Concept](beta-concept.md) and [Alpha Entity](../entities/alpha-entity.md).
`;

const conceptB = `---
title: Beta Concept
summary: The second concept.
tags:
  - beta
  - shared
kind: concept
---

See [Alpha Concept](alpha-concept.md).
`;

const entityA = `---
title: Alpha Entity
summary: An entity page.
tags:
  - alpha
kind: entity
---

Links to [Alpha Concept](../concepts/alpha-concept.md).
`;

const sourceA = `---
title: Source One
summary: A source page.
tags:
  - source-tag
kind: source
---

No links to wiki pages.
`;

const rawDoc = `---
title: Raw Document
---

See [Alpha Concept](../wiki/concepts/alpha-concept.md).
`;

function makePages(
  entries: Array<[string, string]>,
): Map<string, { record?: PageRecord; text: string }> {
  // Split into wiki/ (need full PageRecord) and raw/ (text only).
  const wikiEntries = entries.filter(([ref]) => ref.startsWith("wiki/"));
  const rawEntries = entries.filter(([ref]) => !ref.startsWith("wiki/"));

  const textMap: Record<string, string> = {};
  for (const [ref, text] of wikiEntries) textMap[ref] = text;
  const records = loadRecords(textMap);

  const result = new Map<string, { record?: PageRecord; text: string }>();
  for (const [ref, text] of wikiEntries) {
    result.set(ref, { record: records[ref]!, text });
  }
  for (const [ref, text] of rawEntries) {
    result.set(ref, { text });
  }
  return result;
}

const wikiPages = makePages([
  ["wiki/concepts/alpha-concept.md", conceptA],
  ["wiki/concepts/beta-concept.md", conceptB],
  ["wiki/entities/alpha-entity.md", entityA],
  ["wiki/sources/source-one.md", sourceA],
]);

// ---------------------------------------------------------------------------
// Tag grouping
// ---------------------------------------------------------------------------

test("buildExportMeta: tag map groups pages by tag", () => {
  const meta = buildExportMeta(wikiPages);
  const alphaPages = meta.tagMap.get("alpha");
  assert.ok(alphaPages, "tag 'alpha' should exist");
  assert.deepEqual(alphaPages.sort(), [
    "wiki/concepts/alpha-concept.md",
    "wiki/entities/alpha-entity.md",
  ]);

  const sharedPages = meta.tagMap.get("shared");
  assert.ok(sharedPages, "tag 'shared' should exist");
  assert.deepEqual(sharedPages.sort(), [
    "wiki/concepts/alpha-concept.md",
    "wiki/concepts/beta-concept.md",
  ]);
});

test("buildExportMeta: pages with no tags do not appear in tagMap", () => {
  // sourceA has tag 'source-tag'
  assert.ok(wikiPages.has("wiki/sources/source-one.md"));
  const meta = buildExportMeta(wikiPages);
  assert.ok(!meta.tagMap.has("nonexistent"));
});

// ---------------------------------------------------------------------------
// Per-kind partitioning
// ---------------------------------------------------------------------------

test("buildExportMeta: kindMap partitions by kind", () => {
  const meta = buildExportMeta(wikiPages);
  assert.deepEqual(meta.kindMap.get("concept"), [
    "wiki/concepts/alpha-concept.md",
    "wiki/concepts/beta-concept.md",
  ]);
  assert.deepEqual(meta.kindMap.get("entity"), [
    "wiki/entities/alpha-entity.md",
  ]);
  assert.deepEqual(meta.kindMap.get("source"), ["wiki/sources/source-one.md"]);
  assert.equal(meta.kindMap.has("synthesis"), false);
});

// ---------------------------------------------------------------------------
// Inbound-link counting
// ---------------------------------------------------------------------------

test("buildExportMeta: inbound-link counts reflect links from exported pages", () => {
  const meta = buildExportMeta(wikiPages);

  // alpha-concept is linked by: beta-concept (body) + alpha-entity (body)
  assert.equal(
    meta.inboundCounts.get("wiki/concepts/alpha-concept.md"),
    2,
    "alpha-concept should have 2 inbound links",
  );

  // beta-concept is linked by: alpha-concept (body)
  assert.equal(
    meta.inboundCounts.get("wiki/concepts/beta-concept.md"),
    1,
    "beta-concept should have 1 inbound link",
  );

  // alpha-entity is linked by: alpha-concept (body)
  assert.equal(
    meta.inboundCounts.get("wiki/entities/alpha-entity.md"),
    1,
    "alpha-entity should have 1 inbound link",
  );

  // source-one has no inbound links in these fixtures
  assert.equal(
    meta.inboundCounts.get("wiki/sources/source-one.md"),
    0,
    "source-one should have 0 inbound links",
  );
});

test("buildExportMeta: raw/ links to wiki/ not counted when raw excluded", () => {
  const pagesWithRaw = makePages([
    ["wiki/concepts/alpha-concept.md", conceptA],
    ["wiki/concepts/beta-concept.md", conceptB],
    ["wiki/entities/alpha-entity.md", entityA],
    ["wiki/sources/source-one.md", sourceA],
    ["raw/raw-doc.md", rawDoc],
  ]);

  // Without raw — raw link to alpha-concept not counted
  const metaNoRaw = buildExportMeta(pagesWithRaw, { includeRaw: false });
  assert.equal(
    metaNoRaw.inboundCounts.get("wiki/concepts/alpha-concept.md"),
    2,
    "raw not included: alpha-concept should still have 2 inbound links",
  );

  // With raw — raw link adds one more inbound to alpha-concept
  const metaWithRaw = buildExportMeta(pagesWithRaw, { includeRaw: true });
  assert.equal(
    metaWithRaw.inboundCounts.get("wiki/concepts/alpha-concept.md"),
    3,
    "raw included: alpha-concept should have 3 inbound links",
  );
});

test("buildExportMeta: raw/ pages not in tagMap or kindMap", () => {
  const pagesWithRaw = makePages([
    ["wiki/concepts/alpha-concept.md", conceptA],
    ["raw/raw-doc.md", rawDoc],
  ]);
  const meta = buildExportMeta(pagesWithRaw, { includeRaw: true });
  // raw/ pages have no kind, so kindMap should only contain wiki/ kinds
  assert.ok(
    !meta.kindMap.has("concept") ||
      !meta.kindMap.get("concept")!.some((r) => r.startsWith("raw/")),
  );
  // raw-doc has no tags key, so tagMap should not include raw refs
  for (const pages of meta.tagMap.values()) {
    for (const ref of pages) {
      assert.ok(
        !ref.startsWith("raw/"),
        `raw/ ref ${ref} should not appear in tagMap`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// The exported set — the one owner of "which refs are in the export"
// ---------------------------------------------------------------------------

test("buildExportMeta: exported set is wiki/ always, raw/ only under includeRaw", () => {
  const pagesWithRaw = makePages([
    ["wiki/concepts/alpha-concept.md", conceptA],
    ["raw/raw-doc.md", rawDoc],
  ]);

  const byDefault = buildExportMeta(pagesWithRaw);
  assert.deepEqual(
    [...byDefault.exported],
    ["wiki/concepts/alpha-concept.md"],
    "wiki/ is always exported; raw/ is not without includeRaw",
  );

  const noRaw = buildExportMeta(pagesWithRaw, { includeRaw: false });
  assert.deepEqual(
    [...noRaw.exported],
    [...byDefault.exported],
    "includeRaw:false is the default, spelled the same either way",
  );

  const withRaw = buildExportMeta(pagesWithRaw, { includeRaw: true });
  assert.deepEqual(
    [...withRaw.exported],
    ["wiki/concepts/alpha-concept.md", "raw/raw-doc.md"],
    "includeRaw adds the raw/ refs to the exported set",
  );
});

// ---------------------------------------------------------------------------
// Fallback get-started ranking
// ---------------------------------------------------------------------------

test("buildExportMeta: getStarted ranked by inbound count desc, title asc tie-break", () => {
  const meta = buildExportMeta(wikiPages);
  const refs = meta.getStarted.map((e) => e.pageRef);

  // alpha-concept (2 inbound) should come first
  assert.equal(refs[0], "wiki/concepts/alpha-concept.md");
  // beta-concept and alpha-entity both have 1 inbound — tie-break by title
  // "Alpha Entity" < "Beta Concept" alphabetically
  assert.equal(refs[1], "wiki/entities/alpha-entity.md");
  assert.equal(refs[2], "wiki/concepts/beta-concept.md");
  // source-one has 0 inbound — comes last
  assert.equal(refs[3], "wiki/sources/source-one.md");
});

test("buildExportMeta: getStarted capped at 12", () => {
  // Build 20 pages, each with no links
  const entries: Array<[string, string]> = [];
  for (let i = 0; i < 20; i++) {
    entries.push([
      `wiki/concepts/page-${String(i).padStart(2, "0")}.md`,
      `---\ntitle: Page ${String(i).padStart(2, "0")}\n---\n`,
    ]);
  }
  const manyPages = makePages(entries);
  const meta = buildExportMeta(manyPages);
  assert.equal(meta.getStarted.length, 12);
});

test("buildExportMeta: getStarted contains title and summary", () => {
  const meta = buildExportMeta(wikiPages);
  const alpha = meta.getStarted.find(
    (e) => e.pageRef === "wiki/concepts/alpha-concept.md",
  );
  assert.ok(alpha, "alpha-concept should appear in get-started");
  assert.equal(alpha.title, "Alpha Concept");
  assert.equal(alpha.summary, "The first concept.");
  assert.equal(alpha.kind, "concept");
  assert.deepEqual(alpha.tags, ["alpha", "shared"]);
});

test("buildExportMeta: getStarted excludes raw/ pages", () => {
  const pagesWithRaw = makePages([
    ["wiki/concepts/alpha-concept.md", conceptA],
    ["raw/raw-doc.md", rawDoc],
  ]);
  const meta = buildExportMeta(pagesWithRaw, { includeRaw: true });
  for (const entry of meta.getStarted) {
    assert.ok(
      !entry.pageRef.startsWith("raw/"),
      "getStarted should not include raw/ pages",
    );
  }
});

// ---------------------------------------------------------------------------
// Empty vault
// ---------------------------------------------------------------------------

test("buildExportMeta: empty pages produces empty maps and empty getStarted", () => {
  const meta = buildExportMeta(new Map());
  assert.equal(meta.tagMap.size, 0);
  assert.equal(meta.kindMap.size, 0);
  assert.equal(meta.inboundCounts.size, 0);
  assert.equal(meta.getStarted.length, 0);
});
