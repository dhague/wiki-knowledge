/**
 * Tests for exportaggregate.ts.
 *
 * Includes a property test: every intra-site link in the full generator output
 * (renderPages + renderAggregatePages) resolves to an emitted output path.
 * This is the export analogue of the "a move touches only link lines and all
 * links still resolve" invariant in wikipage.test.ts.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fc from "fast-check";
import { loadRecords, type PageRecord } from "./pagerecord.js";
import { buildExportMeta } from "./exportmeta.js";
import { renderPages } from "./exportrender.js";
import { buildTagSlugMap, renderAggregatePages } from "./exportaggregate.js";

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

See also [Beta Concept](beta-concept.md).
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

const kindConceptMd = `---
summary: Fundamental building blocks.
---
`;

function makePages(
  entries: Array<[string, string]>,
): Map<string, { record?: PageRecord; text: string }> {
  const wikiEntries = entries.filter(([ref]) => ref.startsWith("wiki/"));
  const otherEntries = entries.filter(([ref]) => !ref.startsWith("wiki/"));

  const textMap: Record<string, string> = {};
  for (const [ref, text] of wikiEntries) textMap[ref] = text;
  const records = loadRecords(textMap);

  const result = new Map<string, { record?: PageRecord; text: string }>();
  for (const [ref, text] of wikiEntries) {
    result.set(ref, { record: records[ref], text });
  }
  for (const [ref, text] of otherEntries) {
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
// buildTagSlugMap
// ---------------------------------------------------------------------------

test("buildTagSlugMap: unique tags get their plain slug", () => {
  const m = buildTagSlugMap(["alpha", "beta", "shared"]);
  assert.equal(m.get("alpha"), "alpha");
  assert.equal(m.get("beta"), "beta");
  assert.equal(m.get("shared"), "shared");
});

test("buildTagSlugMap: colliding tags get suffix-disambiguated slugs", () => {
  // "foo bar" and "foo-bar" both slugify to "foo-bar"
  const m = buildTagSlugMap(["foo bar", "foo-bar"]);
  const slugs = [...m.values()];
  // Both assigned, one plain and one suffixed
  assert.equal(new Set(slugs).size, 2, "slugs must be unique");
  const sorted = slugs.sort();
  assert.equal(sorted[0], "foo-bar");
  assert.equal(sorted[1], "foo-bar-2");
});

test("buildTagSlugMap: three collisions get sequential suffixes", () => {
  const m = buildTagSlugMap(["a b", "a-b", "a  b"]);
  const slugs = [...m.values()];
  assert.equal(new Set(slugs).size, 3, "three unique slugs");
});

// ---------------------------------------------------------------------------
// Tag pages
// ---------------------------------------------------------------------------

test("renderAggregatePages: yields one tag page per tag", () => {
  const meta = buildExportMeta(wikiPages);
  const pages = [...renderAggregatePages(wikiPages, meta)];
  const tagPages = pages.filter(
    (p) => p.path.startsWith("tags/") && p.path !== "tags/index.html",
  );
  // tags: alpha, beta, shared, source-tag => 4 tag pages
  assert.equal(tagPages.length, meta.tagMap.size);
});

test("renderAggregatePages: tag page paths are tags/<slug>.html", () => {
  const meta = buildExportMeta(wikiPages);
  const pages = [...renderAggregatePages(wikiPages, meta)];
  const tagPages = pages.filter(
    (p) => p.path.startsWith("tags/") && p.path !== "tags/index.html",
  );
  for (const p of tagPages) {
    assert.match(p.path, /^tags\/[a-z0-9-]+\.html$/);
  }
});

test("renderAggregatePages: tag page lists pages with that tag", () => {
  const meta = buildExportMeta(wikiPages);
  const pages = [...renderAggregatePages(wikiPages, meta)];
  const alphaPage = pages.find((p) => p.path === "tags/alpha.html");
  assert.ok(alphaPage, "tags/alpha.html should be emitted");
  assert.ok(
    alphaPage.content.includes("Alpha Concept"),
    "should list Alpha Concept",
  );
  assert.ok(
    alphaPage.content.includes("Alpha Entity"),
    "should list Alpha Entity",
  );
});

// ---------------------------------------------------------------------------
// Tag index
// ---------------------------------------------------------------------------

test("renderAggregatePages: yields tags/index.html when tags exist", () => {
  const meta = buildExportMeta(wikiPages);
  const pages = [...renderAggregatePages(wikiPages, meta)];
  const index = pages.find((p) => p.path === "tags/index.html");
  assert.ok(index, "tags/index.html must be emitted");
});

test("renderAggregatePages: tag index contains all tags with counts", () => {
  const meta = buildExportMeta(wikiPages);
  const pages = [...renderAggregatePages(wikiPages, meta)];
  const index = pages.find((p) => p.path === "tags/index.html")!;
  assert.ok(index.content.includes("alpha"), "index should mention 'alpha'");
  assert.ok(index.content.includes("shared"), "index should mention 'shared'");
  // alpha has 2 pages
  const alphaCount = (index.content.match(/>alpha<\/a> \(2\)/g) ?? []).length;
  assert.ok(alphaCount > 0, "alpha tag should show count 2");
});

test("renderAggregatePages: tags/index.html always emitted (nav invariant)", () => {
  const noTagPages = makePages([
    ["wiki/concepts/foo.md", "---\ntitle: Foo\nkind: concept\n---\nBody.\n"],
  ]);
  const meta = buildExportMeta(noTagPages);
  const pages = [...renderAggregatePages(noTagPages, meta)];
  const index = pages.find((p) => p.path === "tags/index.html");
  assert.ok(index, "tags/index.html must always be emitted so nav links work");
});

// ---------------------------------------------------------------------------
// Per-kind index pages
// ---------------------------------------------------------------------------

test("renderAggregatePages: yields a kind index page for each kind present", () => {
  const meta = buildExportMeta(wikiPages);
  const pages = [...renderAggregatePages(wikiPages, meta)];
  const kindIndexes = pages.filter(
    (p) => p.path.endsWith("/index.html") && p.path.startsWith("wiki/"),
  );
  assert.equal(kindIndexes.length, meta.kindMap.size);
});

test("renderAggregatePages: kind index pages have correct paths", () => {
  const meta = buildExportMeta(wikiPages);
  const pages = [...renderAggregatePages(wikiPages, meta)];
  const paths = new Set(pages.map((p) => p.path));
  assert.ok(paths.has("wiki/concepts/index.html"), "wiki/concepts/index.html");
  assert.ok(paths.has("wiki/entities/index.html"), "wiki/entities/index.html");
  assert.ok(paths.has("wiki/sources/index.html"), "wiki/sources/index.html");
});

test("renderAggregatePages: kind index lists pages of that kind", () => {
  const meta = buildExportMeta(wikiPages);
  const pages = [...renderAggregatePages(wikiPages, meta)];
  const conceptIndex = pages.find(
    (p) => p.path === "wiki/concepts/index.html",
  )!;
  assert.ok(
    conceptIndex.content.includes("Alpha Concept"),
    "concept index should list Alpha Concept",
  );
  assert.ok(
    conceptIndex.content.includes("Beta Concept"),
    "concept index should list Beta Concept",
  );
  assert.ok(
    !conceptIndex.content.includes("Alpha Entity"),
    "concept index should not list Alpha Entity",
  );
});

// ---------------------------------------------------------------------------
// Front page
// ---------------------------------------------------------------------------

test("renderAggregatePages: always yields index.html", () => {
  const meta = buildExportMeta(wikiPages);
  const pages = [...renderAggregatePages(wikiPages, meta)];
  const front = pages.find((p) => p.path === "index.html");
  assert.ok(front, "index.html must be emitted");
});

test("renderAggregatePages: front page shows total page count", () => {
  const meta = buildExportMeta(wikiPages);
  const pages = [...renderAggregatePages(wikiPages, meta)];
  const front = pages.find((p) => p.path === "index.html")!;
  assert.ok(
    front.content.includes("4 pages"),
    "front page should show '4 pages'",
  );
});

test("renderAggregatePages: front page shows per-kind counts linked to kind indexes", () => {
  const meta = buildExportMeta(wikiPages);
  const pages = [...renderAggregatePages(wikiPages, meta)];
  const front = pages.find((p) => p.path === "index.html")!;
  assert.ok(
    front.content.includes("wiki/concepts/index.html"),
    "front page should link to concepts index",
  );
  assert.ok(
    front.content.includes("(2)"),
    "front page should show concept count",
  );
});

test("renderAggregatePages: front page includes KIND.md blurb when present", () => {
  const pagesWithKind = makePages([
    ["wiki/concepts/alpha-concept.md", conceptA],
    ["wiki/concepts/KIND.md", kindConceptMd],
  ]);
  const meta = buildExportMeta(pagesWithKind);
  const pages = [...renderAggregatePages(pagesWithKind, meta)];
  const front = pages.find((p) => p.path === "index.html")!;
  assert.ok(
    front.content.includes("Fundamental building blocks"),
    "front page should show KIND.md summary blurb",
  );
});

test("renderAggregatePages: front page uses supplied starters when given", () => {
  const meta = buildExportMeta(wikiPages);
  const opts = {
    starters: [
      {
        pageRef: "wiki/sources/source-one.md",
        annotation: "Start here",
      },
    ],
  };
  const pages = [...renderAggregatePages(wikiPages, meta, opts)];
  const front = pages.find((p) => p.path === "index.html")!;
  assert.ok(front.content.includes("Source One"), "should show starter title");
  assert.ok(front.content.includes("Start here"), "should show annotation");
});

test("renderAggregatePages: front page uses fallback ranking when no starters supplied", () => {
  const meta = buildExportMeta(wikiPages);
  const pages = [...renderAggregatePages(wikiPages, meta)];
  const front = pages.find((p) => p.path === "index.html")!;
  // alpha-concept has highest inbound count — should appear in get-started
  assert.ok(
    front.content.includes("Alpha Concept"),
    "front page should include top get-started entry",
  );
});

test("renderAggregatePages: supplied starters with non-exported pageRef are silently skipped", () => {
  const meta = buildExportMeta(wikiPages);
  const opts = {
    starters: [
      { pageRef: "wiki/concepts/alpha-concept.md" },
      { pageRef: "wiki/nonexistent/page.md" }, // not in exported set
    ],
  };
  const pages = [...renderAggregatePages(wikiPages, meta, opts)];
  const front = pages.find((p) => p.path === "index.html")!;
  assert.ok(
    front.content.includes("Alpha Concept"),
    "valid starter should appear",
  );
  assert.ok(
    !front.content.includes("nonexistent"),
    "invalid starter should not appear",
  );
});

// ---------------------------------------------------------------------------
// Nav header on all pages
// ---------------------------------------------------------------------------

test("renderAggregatePages: every page carries Home · Tags nav header", () => {
  const meta = buildExportMeta(wikiPages);
  const pages = [...renderAggregatePages(wikiPages, meta)];
  for (const page of pages) {
    assert.ok(
      page.content.includes(">Home<") && page.content.includes(">Tags<"),
      `${page.path} should carry Home · Tags nav`,
    );
  }
});

// ---------------------------------------------------------------------------
// Property test: every intra-site link resolves to an emitted path
// ---------------------------------------------------------------------------

/**
 * Extract all href values from HTML content that look like intra-site links
 * (relative paths ending in .html, not starting with http(s):// or #).
 */
function extractIntraSiteHrefs(html: string): string[] {
  const hrefs: string[] = [];
  const re = /href="([^"#][^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const href = m[1];
    if (href.startsWith("http://") || href.startsWith("https://")) continue;
    if (!href.endsWith(".html")) continue;
    hrefs.push(href);
  }
  return hrefs;
}

/**
 * Resolve a relative href from a page's html path to a normalised output path.
 * e.g. from "tags/alpha.html", href "../wiki/concepts/foo.html"
 *   → "wiki/concepts/foo.html"
 */
function resolveHref(fromHtmlPath: string, href: string): string {
  const fromDir = path.posix.dirname(fromHtmlPath);
  // path.posix.resolve returns an absolute path; strip leading "/"
  return path.posix.resolve("/" + fromDir, href).replace(/^\//, "");
}

test("property: every intra-site link in full output resolves to an emitted path", () => {
  // Deterministic fixture: more than enough to exercise all link types
  const meta = buildExportMeta(wikiPages);

  const allPages = [
    ...renderPages(wikiPages, meta),
    ...renderAggregatePages(wikiPages, meta),
  ];

  const emittedPaths = new Set(allPages.map((p) => p.path));

  const broken: string[] = [];
  for (const page of allPages) {
    for (const href of extractIntraSiteHrefs(page.content)) {
      const resolved = resolveHref(page.path, href);
      if (!emittedPaths.has(resolved)) {
        broken.push(`${page.path}: href "${href}" → "${resolved}" not emitted`);
      }
    }
  }
  assert.deepEqual(
    broken,
    [],
    `Broken intra-site links:\n${broken.join("\n")}`,
  );
});

test("property (fast-check): intra-site links resolve for random page sets", () => {
  const kindPairs: Array<[string, string]> = [
    ["concept", "concepts"],
    ["entity", "entities"],
    ["source", "sources"],
    ["synthesis", "synthesis"],
  ];

  const tagPool = ["alpha", "beta", "gamma", "foo-bar", "shared"];
  const titlePool = [
    "Page One",
    "Page Two",
    "Page Three",
    "Page Four",
    "Page Five",
  ];

  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          kindIdx: fc.integer({ min: 0, max: 3 }),
          titleIdx: fc.integer({ min: 0, max: 4 }),
          tagIdxs: fc.uniqueArray(fc.integer({ min: 0, max: 4 }), {
            minLength: 0,
            maxLength: 3,
          }),
        }),
        { minLength: 1, maxLength: 10 },
      ),
      (specs) => {
        const entries: Array<[string, string]> = [];
        const seen = new Map<string, number>();

        for (const spec of specs) {
          const [kind, folder] = kindPairs[spec.kindIdx];
          const title = titlePool[spec.titleIdx];
          const slug = title.toLowerCase().replace(/\s+/g, "-");
          const key = `${folder}/${slug}`;
          const n = (seen.get(key) ?? 0) + 1;
          seen.set(key, n);
          const filename = n === 1 ? `${slug}.md` : `${slug}-${n}.md`;
          const ref = `wiki/${folder}/${filename}`;

          const tags = spec.tagIdxs.map((i) => tagPool[i]);
          const tagsYaml =
            tags.length > 0
              ? `tags:\n${tags.map((t) => `  - ${t}`).join("\n")}\n`
              : "";
          const text = `---\ntitle: ${title}\nsummary: Summary for ${title}.\n${tagsYaml}kind: ${kind}\n---\n\nBody text.\n`;
          entries.push([ref, text]);
        }

        const pages = makePages(entries);
        const meta = buildExportMeta(pages);

        const allOutput = [
          ...renderPages(pages, meta),
          ...renderAggregatePages(pages, meta),
        ];

        const emittedPaths = new Set(allOutput.map((p) => p.path));

        for (const page of allOutput) {
          for (const href of extractIntraSiteHrefs(page.content)) {
            const resolved = resolveHref(page.path, href);
            if (!emittedPaths.has(resolved)) {
              return false; // fast-check will report the failing input
            }
          }
        }
        return true;
      },
    ),
    { numRuns: 100 },
  );
});
