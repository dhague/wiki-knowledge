import { test } from "node:test";
import assert from "node:assert/strict";
import fc from "fast-check";
import { loadRecords, type PageRecord } from "./pagerecord.js";
import { buildExportMeta } from "./exportmeta.js";
import { renderPages } from "./exportrender.js";
import { renderAggregatePages } from "./exportaggregate.js";

// ---------------------------------------------------------------------------
// Fixtures (same as exportrender.test.ts)
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

No links.
`;

function makePages(
  entries: Array<[string, string]>,
): Map<string, { record?: PageRecord; text: string }> {
  const wikiEntries = entries.filter(([ref]) => ref.startsWith("wiki/"));
  const rawEntries = entries.filter(([ref]) => !ref.startsWith("wiki/"));
  const textMap: Record<string, string> = {};
  for (const [ref, text] of wikiEntries) textMap[ref] = text;
  const records = loadRecords(textMap);
  const result = new Map<string, { record?: PageRecord; text: string }>();
  for (const [ref, text] of wikiEntries)
    result.set(ref, { record: records[ref]!, text });
  for (const [ref, text] of rawEntries) result.set(ref, { text });
  return result;
}

const wikiPages = makePages([
  ["wiki/concepts/alpha-concept.md", conceptA],
  ["wiki/concepts/beta-concept.md", conceptB],
  ["wiki/entities/alpha-entity.md", entityA],
  ["wiki/sources/source-one.md", sourceA],
]);

function _collectAll(
  pages: Map<string, { record?: PageRecord; text: string }>,
  opts = {},
) {
  const meta = buildExportMeta(pages, opts);
  const result = new Map<string, string>();
  for (const { path, content } of renderPages(pages, meta, opts))
    result.set(path, content);
  for (const { path, content } of renderAggregatePages(pages, meta, opts))
    result.set(path, content);
  return result;
}

// ---------------------------------------------------------------------------
// Tag pages
// ---------------------------------------------------------------------------

test("renderAggregatePages: emits one HTML page per tag", () => {
  const meta = buildExportMeta(wikiPages);
  const out = new Map<string, string>();
  for (const { path, content } of renderAggregatePages(wikiPages, meta))
    out.set(path, content);
  // Tags: alpha, shared, beta, source-tag — each gets a page
  assert.ok(out.has("tags/alpha.html"));
  assert.ok(out.has("tags/shared.html"));
  assert.ok(out.has("tags/beta.html"));
  assert.ok(out.has("tags/source-tag.html"));
});

test("renderAggregatePages: tag page lists pages carrying that tag", () => {
  const meta = buildExportMeta(wikiPages);
  const out = new Map<string, string>();
  for (const { path, content } of renderAggregatePages(wikiPages, meta))
    out.set(path, content);
  const alphaPage = out.get("tags/alpha.html")!;
  assert.ok(alphaPage.includes("Alpha Concept"), "should list Alpha Concept");
  assert.ok(alphaPage.includes("Alpha Entity"), "should list Alpha Entity");
  assert.ok(
    !alphaPage.includes("Beta Concept"),
    "should not list Beta Concept",
  );
});

test("renderAggregatePages: tag page links back to wiki pages", () => {
  const meta = buildExportMeta(wikiPages);
  const out = new Map<string, string>();
  for (const { path, content } of renderAggregatePages(wikiPages, meta))
    out.set(path, content);
  const alphaPage = out.get("tags/alpha.html")!;
  // From tags/, wiki pages are at ../wiki/concepts/alpha-concept.html
  assert.ok(alphaPage.includes("../wiki/concepts/alpha-concept.html"));
});

test("renderAggregatePages: tag slug collision suffix-disambiguated", () => {
  // Two tags that produce the same slug
  const collidingPages = makePages([
    [
      "wiki/concepts/c1.md",
      `---\ntitle: C1\ntags:\n  - "foo bar"\n  - "foo-bar"\nkind: concept\n---\ntext\n`,
    ],
  ]);
  const meta = buildExportMeta(collidingPages);
  const out = new Map<string, string>();
  for (const { path, content } of renderAggregatePages(collidingPages, meta))
    out.set(path, content);
  // Both "foo bar" and "foo-bar" slugify to "foo-bar" — one should be "foo-bar-2"
  const paths = [...out.keys()].filter(
    (p) => p.startsWith("tags/") && p !== "tags/index.html",
  );
  assert.equal(paths.length, 2);
  assert.ok(paths.some((p) => p === "tags/foo-bar.html"));
  assert.ok(paths.some((p) => p === "tags/foo-bar-2.html"));
});

// ---------------------------------------------------------------------------
// Tag index
// ---------------------------------------------------------------------------

test("renderAggregatePages: emits tags/index.html", () => {
  const meta = buildExportMeta(wikiPages);
  const out = new Map<string, string>();
  for (const { path, content } of renderAggregatePages(wikiPages, meta))
    out.set(path, content);
  assert.ok(out.has("tags/index.html"));
});

test("renderAggregatePages: tag index lists all tags with counts", () => {
  const meta = buildExportMeta(wikiPages);
  const out = new Map<string, string>();
  for (const { path, content } of renderAggregatePages(wikiPages, meta))
    out.set(path, content);
  const idx = out.get("tags/index.html")!;
  assert.ok(idx.includes("alpha"), "should list tag 'alpha'");
  assert.ok(idx.includes("shared"), "should list tag 'shared'");
  assert.ok(idx.includes("beta"), "should list tag 'beta'");
  assert.ok(idx.includes("source-tag"), "should list tag 'source-tag'");
  // counts
  assert.ok(idx.includes("(2)"), "shared has 2 pages");
});

test("renderAggregatePages: always emits tags/index.html even for empty vault", () => {
  const meta = buildExportMeta(new Map());
  const out = new Map<string, string>();
  for (const { path, content } of renderAggregatePages(new Map(), meta))
    out.set(path, content);
  assert.ok(out.has("tags/index.html"), "tag index always present");
  // No individual tag pages when no tags exist
  const tagPages = [...out.keys()].filter(
    (p) => p.startsWith("tags/") && p !== "tags/index.html",
  );
  assert.equal(tagPages.length, 0, "no individual tag pages for tagless vault");
});

// ---------------------------------------------------------------------------
// Per-kind index pages
// ---------------------------------------------------------------------------

test("renderAggregatePages: emits per-kind index page for each present kind", () => {
  const meta = buildExportMeta(wikiPages);
  const out = new Map<string, string>();
  for (const { path, content } of renderAggregatePages(wikiPages, meta))
    out.set(path, content);
  assert.ok(out.has("wiki/concepts/index.html"));
  assert.ok(out.has("wiki/entities/index.html"));
  assert.ok(out.has("wiki/sources/index.html"));
  assert.ok(!out.has("wiki/synthesis/index.html"), "no synthesis kind present");
});

test("renderAggregatePages: kind index lists pages of that kind", () => {
  const meta = buildExportMeta(wikiPages);
  const out = new Map<string, string>();
  for (const { path, content } of renderAggregatePages(wikiPages, meta))
    out.set(path, content);
  const conceptIdx = out.get("wiki/concepts/index.html")!;
  assert.ok(conceptIdx.includes("Alpha Concept"));
  assert.ok(conceptIdx.includes("Beta Concept"));
  assert.ok(!conceptIdx.includes("Alpha Entity"));
});

// ---------------------------------------------------------------------------
// Front page
// ---------------------------------------------------------------------------

test("renderAggregatePages: emits index.html", () => {
  const meta = buildExportMeta(wikiPages);
  const out = new Map<string, string>();
  for (const { path, content } of renderAggregatePages(wikiPages, meta))
    out.set(path, content);
  assert.ok(out.has("index.html"));
});

test("renderAggregatePages: front page shows total page count", () => {
  const meta = buildExportMeta(wikiPages);
  const out = new Map<string, string>();
  for (const { path, content } of renderAggregatePages(wikiPages, meta))
    out.set(path, content);
  const idx = out.get("index.html")!;
  assert.ok(idx.includes("4 pages"), "should show '4 pages'");
});

test("renderAggregatePages: front page links to kind index pages", () => {
  const meta = buildExportMeta(wikiPages);
  const out = new Map<string, string>();
  for (const { path, content } of renderAggregatePages(wikiPages, meta))
    out.set(path, content);
  const idx = out.get("index.html")!;
  assert.ok(idx.includes("wiki/concepts/index.html"));
  assert.ok(idx.includes("wiki/entities/index.html"));
});

test("renderAggregatePages: front page get-started block uses fallback when no starters", () => {
  const meta = buildExportMeta(wikiPages);
  const out = new Map<string, string>();
  for (const { path, content } of renderAggregatePages(wikiPages, meta))
    out.set(path, content);
  const idx = out.get("index.html")!;
  // Fallback ranking: alpha-concept has most inbound links
  assert.ok(
    idx.includes("Alpha Concept"),
    "should include Alpha Concept in get-started",
  );
});

test("renderAggregatePages: front page get-started block uses supplied starters", () => {
  const meta = buildExportMeta(wikiPages);
  const out = new Map<string, string>();
  for (const { path, content } of renderAggregatePages(wikiPages, meta, {}, [
    { pageRef: "wiki/sources/source-one.md", annotation: "Start here" },
  ]))
    out.set(path, content);
  const idx = out.get("index.html")!;
  assert.ok(idx.includes("Source One"), "should show Source One from starters");
  assert.ok(idx.includes("Start here"), "should show annotation");
});

test("renderAggregatePages: front page shows KIND.md blurb when provided", () => {
  const meta = buildExportMeta(wikiPages);
  const kindBlurbs = new Map([["concept", "Core wiki concepts."]]);
  const out = new Map<string, string>();
  for (const { path, content } of renderAggregatePages(
    wikiPages,
    meta,
    {},
    [],
    kindBlurbs,
  ))
    out.set(path, content);
  const idx = out.get("index.html")!;
  assert.ok(idx.includes("Core wiki concepts."), "should show kind blurb");
});

test("renderAggregatePages: every page carries Home · Tags nav", () => {
  const meta = buildExportMeta(wikiPages);
  const out = new Map<string, string>();
  for (const { path, content } of renderAggregatePages(wikiPages, meta))
    out.set(path, content);
  for (const [p, html] of out) {
    assert.ok(html.includes("index.html"), `${p}: should have Home link`);
    assert.ok(html.includes("tags/index.html"), `${p}: should have Tags link`);
  }
});

// ---------------------------------------------------------------------------
// Property test: every intra-site link resolves to an emitted output path
// ---------------------------------------------------------------------------

test("property: every intra-site link resolves to an emitted path", () => {
  // Collect all emitted paths from both generators
  const meta = buildExportMeta(wikiPages);
  const allPaths = new Set<string>();
  for (const { path } of renderPages(wikiPages, meta)) allPaths.add(path);
  for (const { path } of renderAggregatePages(wikiPages, meta))
    allPaths.add(path);

  // Collect all href values from all emitted HTML
  const hrefRe = /href="([^"]+)"/g;
  const all = new Map<string, string>(allPaths.size > 0 ? [] : []);
  for (const { path, content } of renderPages(wikiPages, meta))
    all.set(path, content);
  for (const { path, content } of renderAggregatePages(wikiPages, meta))
    all.set(path, content);

  for (const [fromPath, html] of all) {
    const fromDir = fromPath.includes("/")
      ? fromPath.slice(0, fromPath.lastIndexOf("/"))
      : "";
    let m: RegExpExecArray | null;
    while ((m = hrefRe.exec(html)) !== null) {
      const href = m[1];
      if (
        !href ||
        href.startsWith("http") ||
        href.startsWith("#") ||
        href.startsWith("//")
      )
        continue;
      // Strip anchor
      const [dest] = href.split("#");
      if (!dest) continue;
      // Resolve relative href to vault-relative path
      const resolved = resolveRelative(fromDir, dest);
      assert.ok(
        allPaths.has(resolved),
        `${fromPath}: href "${href}" resolves to "${resolved}" but that path was not emitted`,
      );
    }
  }
});

/** Resolve a relative `href` from a `fromDir` (vault-relative directory string,
 * empty for root-level pages) to a vault-relative path. */
function resolveRelative(fromDir: string, href: string): string {
  if (!fromDir) return href.replace(/^\.\//, "");
  const parts = [...fromDir.split("/"), ...href.split("/")];
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "..") resolved.pop();
    else if (part !== ".") resolved.push(part);
  }
  return resolved.join("/");
}

// fast-check property: for any set of pages with arbitrary tags, every tag
// page emitted has a corresponding entry in the tag index.
test("property: every tag page is listed in the tag index", () => {
  fc.assert(
    fc.property(
      fc.array(
        fc.tuple(
          fc.stringMatching(/^[a-z][a-z0-9]{0,19}$/),
          fc.array(fc.stringMatching(/^[a-z][a-z0-9-]{0,19}$/), {
            minLength: 1,
            maxLength: 3,
          }),
        ),
        { minLength: 1, maxLength: 5 },
      ),
      (pageDefs) => {
        const pages = new Map<string, { record?: PageRecord; text: string }>();
        const textMap: Record<string, string> = {};
        for (const [slug, tags] of pageDefs) {
          const ref = `wiki/concepts/${slug}.md`;
          const text = `---\ntitle: ${slug}\ntags:\n${tags.map((t) => `  - ${t}`).join("\n")}\nkind: concept\n---\nbody\n`;
          textMap[ref] = text;
        }
        const records = loadRecords(textMap);
        for (const [ref, text] of Object.entries(textMap)) {
          pages.set(ref, { record: records[ref]!, text });
        }
        const meta = buildExportMeta(pages);
        const out = new Map<string, string>();
        for (const { path, content } of renderAggregatePages(pages, meta))
          out.set(path, content);
        if (meta.tagMap.size === 0) return;
        const idx = out.get("tags/index.html");
        assert.ok(
          idx !== undefined,
          "tag index should be emitted when tags exist",
        );
        for (const slug of out.keys()) {
          if (slug.startsWith("tags/") && slug !== "tags/index.html") {
            assert.ok(
              idx.includes(slug.slice("tags/".length)),
              `tag index should list ${slug}`,
            );
          }
        }
      },
    ),
    { numRuns: 50 },
  );
});
