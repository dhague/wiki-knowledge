import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { loadRecords, type PageRecord } from "./pagerecord.js";
import { buildExportMeta } from "./exportmeta.js";
import { renderPages, renderAggregate, renderAll } from "./exportrender.js";

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
refines:
  - "[Beta Concept](beta-concept.md)"
---

# Alpha Concept

See also [Beta Concept](beta-concept.md) and [Alpha Entity](../entities/alpha-entity.md).

## Section Two

Content here.
`;

const conceptB = `---
title: Beta Concept
summary: The second concept.
tags:
  - beta
  - shared
kind: concept
supersedes:
  - "[Alpha Concept](alpha-concept.md)"
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
Also an [external link](https://example.com).
And a bare anchor [section link](#section-two).
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

const rawDoc = `---
title: Raw Document
---

Raw content.
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

function collectPages(
  pages: Map<string, { record?: PageRecord; text: string }>,
  opts = {},
) {
  const meta = buildExportMeta(pages, opts);
  const result = new Map<string, string>();
  for (const { path, content } of renderPages(pages, meta, opts)) {
    result.set(path, content);
  }
  return result;
}

// ---------------------------------------------------------------------------
// 1. Generator yields one entry per exported page
// ---------------------------------------------------------------------------

test("renderPages: yields one entry per exported wiki page", () => {
  const rendered = collectPages(wikiPages);
  assert.equal(rendered.size, 4);
  assert.ok(rendered.has("wiki/concepts/alpha-concept.html"));
  assert.ok(rendered.has("wiki/concepts/beta-concept.html"));
  assert.ok(rendered.has("wiki/entities/alpha-entity.html"));
  assert.ok(rendered.has("wiki/sources/source-one.html"));
});

test("renderPages: raw pages excluded by default", () => {
  const pages = makePages([
    ["wiki/concepts/alpha-concept.md", conceptA],
    ["raw/raw-doc.md", rawDoc],
  ]);
  const rendered = collectPages(pages);
  for (const path of rendered.keys()) {
    assert.ok(!path.startsWith("raw/"), `raw/ path ${path} should be excluded`);
  }
});

test("renderPages: raw pages included with includeRaw:true", () => {
  const pages = makePages([
    ["wiki/concepts/alpha-concept.md", conceptA],
    ["raw/raw-doc.md", rawDoc],
  ]);
  const rendered = collectPages(pages, { includeRaw: true });
  assert.ok(rendered.has("wiki/concepts/alpha-concept.html"));
  assert.ok(rendered.has("raw/raw-doc.html"));
});

// ---------------------------------------------------------------------------
// 2. Body markdown rendered to HTML with heading anchor IDs
// ---------------------------------------------------------------------------

test("renderPages: body markdown rendered to HTML", () => {
  const rendered = collectPages(wikiPages);
  const html = rendered.get("wiki/concepts/alpha-concept.html")!;
  assert.ok(html.includes("<h1"), "h1 heading should be present");
  assert.ok(html.includes("<p>"), "paragraphs should be present");
});

test("renderPages: headings have slugified id attributes", () => {
  const rendered = collectPages(wikiPages);
  const html = rendered.get("wiki/concepts/alpha-concept.html")!;
  assert.ok(
    html.includes('id="alpha-concept"'),
    'h1 "Alpha Concept" should have id="alpha-concept"',
  );
  assert.ok(
    html.includes('id="section-two"'),
    'h2 "Section Two" should have id="section-two"',
  );
});

test("renderPages: html: false — raw HTML in source is escaped", () => {
  const pages = makePages([
    [
      "wiki/concepts/test.md",
      `---
title: Test
kind: concept
---

<script>alert(1)</script>
`,
    ],
  ]);
  const rendered = collectPages(pages);
  const html = rendered.get("wiki/concepts/test.html")!;
  assert.ok(!html.includes("<script>"), "raw HTML should be escaped");
  assert.ok(html.includes("&lt;script&gt;"), "raw HTML should be HTML-escaped");
});

// ---------------------------------------------------------------------------
// 3. Frontmatter table
// ---------------------------------------------------------------------------

test("renderPages: frontmatter table contains all literal keys", () => {
  const rendered = collectPages(wikiPages);
  const html = rendered.get("wiki/concepts/alpha-concept.html")!;
  // alpha-concept has title, summary, tags, kind (literal), refines
  assert.ok(html.includes("<td>title</td>"), "title key should be in table");
  assert.ok(
    html.includes("<td>summary</td>"),
    "summary key should be in table",
  );
  assert.ok(html.includes("<td>tags</td>"), "tags key should be in table");
  assert.ok(
    html.includes("<td>refines</td>"),
    "refines key should be in table",
  );
});

test("renderPages: frontmatter table has divider row before derived fields", () => {
  const rendered = collectPages(wikiPages);
  const html = rendered.get("wiki/concepts/alpha-concept.html")!;
  // Divider row and derived kind/superseded_by rows come after literal keys
  assert.ok(
    html.includes('class="fm-divider"') || html.includes("fm-divider"),
    "divider row should be present",
  );
});

test("renderPages: frontmatter table shows derived kind row", () => {
  const rendered = collectPages(wikiPages);
  const html = rendered.get("wiki/concepts/alpha-concept.html")!;
  assert.ok(
    html.includes("<td>kind</td>") && html.includes("<td>concept</td>"),
    "derived kind row should show 'concept'",
  );
});

test("renderPages: frontmatter table shows derived superseded_by row", () => {
  // beta-concept supersedes alpha-concept, so alpha-concept has superseded_by=[beta-concept]
  const rendered = collectPages(wikiPages);
  const html = rendered.get("wiki/concepts/alpha-concept.html")!;
  assert.ok(
    html.includes("<td>superseded_by</td>"),
    "superseded_by row should be present for alpha-concept",
  );
  // beta-concept should be linked
  assert.ok(
    html.includes("beta-concept.html"),
    "superseded_by should link to beta-concept",
  );
});

test("renderPages: tags in frontmatter become tag-page links", () => {
  const rendered = collectPages(wikiPages);
  const html = rendered.get("wiki/concepts/alpha-concept.html")!;
  // alpha-concept has tags: [alpha, shared]
  // From wiki/concepts/, tags are at ../../tags/
  assert.ok(
    html.includes("../../tags/alpha.html"),
    "tag 'alpha' should link to ../../tags/alpha.html",
  );
  assert.ok(
    html.includes("../../tags/shared.html"),
    "tag 'shared' should link to ../../tags/shared.html",
  );
});

test("renderPages: markdown-link frontmatter values become HTML links", () => {
  const rendered = collectPages(wikiPages);
  const html = rendered.get("wiki/concepts/alpha-concept.html")!;
  // alpha-concept has refines: ["[Beta Concept](beta-concept.md)"]
  // beta-concept is in exported set → should be a real href
  assert.ok(
    html.includes("beta-concept.html") && html.includes("Beta Concept"),
    "refines link should be rendered as an HTML link to beta-concept.html",
  );
});

// ---------------------------------------------------------------------------
// 4. .md → .html link rewriting; anchors preserved
// ---------------------------------------------------------------------------

test("renderPages: .md links in body rewritten to .html", () => {
  const rendered = collectPages(wikiPages);
  const html = rendered.get("wiki/concepts/alpha-concept.html")!;
  // alpha-concept body links to beta-concept.md and alpha-entity.md
  // beta-concept is in the same dir: "beta-concept.html"
  assert.ok(
    html.includes('href="beta-concept.html"') ||
      html.includes("href='beta-concept.html'"),
    "link to beta-concept.md should be rewritten to .html",
  );
  // alpha-entity is in ../entities/: "../entities/alpha-entity.html"
  assert.ok(
    html.includes('href="../entities/alpha-entity.html"') ||
      html.includes("href='../entities/alpha-entity.html'"),
    "link to alpha-entity.md should be rewritten to ../entities/alpha-entity.html",
  );
});

test("renderPages: anchor fragments preserved in rewritten links", () => {
  const pages = makePages([
    [
      "wiki/concepts/alpha-concept.md",
      `---
title: Alpha Concept
kind: concept
---

See [Beta Section](beta-concept.md#some-section).
`,
    ],
    [
      "wiki/concepts/beta-concept.md",
      `---
title: Beta Concept
kind: concept
---

Content.
`,
    ],
  ]);
  const rendered = collectPages(pages);
  const html = rendered.get("wiki/concepts/alpha-concept.html")!;
  assert.ok(
    html.includes("beta-concept.html#some-section"),
    "anchor should be preserved: beta-concept.html#some-section",
  );
});

test("renderPages: .md links in frontmatter rewritten to .html", () => {
  const rendered = collectPages(wikiPages);
  // alpha-concept has refines: ["[Beta Concept](beta-concept.md)"]
  const html = rendered.get("wiki/concepts/alpha-concept.html")!;
  assert.ok(
    html.includes("beta-concept.html"),
    "frontmatter link should be rewritten from .md to .html",
  );
  assert.ok(
    !html.includes('"beta-concept.md"') &&
      !html.includes("href='beta-concept.md'"),
    "frontmatter should not contain .md href after rewriting",
  );
});

// ---------------------------------------------------------------------------
// 5. Non-exported target renders as plain text
// ---------------------------------------------------------------------------

test("renderPages: link to non-exported target renders as plain text in body", () => {
  const pages = makePages([
    [
      "wiki/concepts/orphan.md",
      `---
title: Orphan
kind: concept
---

See [raw doc](../../raw/raw-doc.md).
`,
    ],
    ["raw/raw-doc.md", rawDoc],
  ]);
  // raw excluded by default
  const rendered = collectPages(pages, { includeRaw: false });
  const html = rendered.get("wiki/concepts/orphan.html")!;
  // Should contain "raw doc" as plain text, not as <a href=...>
  assert.ok(html.includes("raw doc"), "link label should appear as plain text");
  assert.ok(
    !html.includes("raw-doc.html"),
    "non-exported target should not appear as href",
  );
  assert.ok(
    !html.includes('href="') || !html.includes("raw-doc"),
    "should not have href pointing to raw-doc",
  );
});

test("renderPages: link to non-exported target renders as plain text in frontmatter", () => {
  const pages = makePages([
    [
      "wiki/concepts/alpha-concept.md",
      `---
title: Alpha Concept
kind: concept
refines:
  - "[Missing Page](missing-page.md)"
---

Body text.
`,
    ],
  ]);
  const rendered = collectPages(pages);
  const html = rendered.get("wiki/concepts/alpha-concept.html")!;
  // Missing Page is not in exported set → plain text, no href
  assert.ok(html.includes("Missing Page"), "label should appear as plain text");
  assert.ok(
    !html.includes("missing-page.html"),
    "non-exported target should not be href",
  );
});

// ---------------------------------------------------------------------------
// 6. Home · Tags nav header on every page
// ---------------------------------------------------------------------------

test("renderPages: every page has a nav header with Home link", () => {
  const rendered = collectPages(wikiPages);
  for (const [path, html] of rendered) {
    assert.ok(
      html.includes("index.html"),
      `page ${path} should have a Home link`,
    );
  }
});

test("renderPages: every page has a nav header with Tags link", () => {
  const rendered = collectPages(wikiPages);
  for (const [path, html] of rendered) {
    assert.ok(
      html.includes("tags/index.html"),
      `page ${path} should have a Tags link`,
    );
  }
});

test("renderPages: nav header links are relative to page location", () => {
  const rendered = collectPages(wikiPages);
  // wiki/concepts/alpha-concept.html is 2 levels deep: ../../index.html
  const html = rendered.get("wiki/concepts/alpha-concept.html")!;
  assert.ok(
    html.includes("../../index.html"),
    "Home link should be ../../index.html from wiki/concepts/",
  );
  assert.ok(
    html.includes("../../tags/index.html"),
    "Tags link should be ../../tags/index.html from wiki/concepts/",
  );
});

// ---------------------------------------------------------------------------
// Extra: absolute URLs left alone
// ---------------------------------------------------------------------------

test("renderPages: absolute URLs in body are not rewritten", () => {
  const rendered = collectPages(wikiPages);
  const html = rendered.get("wiki/entities/alpha-entity.html")!;
  // alpha-entity has [external link](https://example.com)
  assert.ok(
    html.includes("https://example.com"),
    "absolute URL should be preserved",
  );
});

// ---------------------------------------------------------------------------
// Extra: bare anchor links left alone
// ---------------------------------------------------------------------------

test("renderPages: bare anchor links in body are preserved", () => {
  const rendered = collectPages(wikiPages);
  const html = rendered.get("wiki/entities/alpha-entity.html")!;
  // alpha-entity has [section link](#section-two)
  assert.ok(
    html.includes('href="#section-two"') ||
      html.includes("href='#section-two'"),
    "bare anchor link should be preserved",
  );
});

// ---------------------------------------------------------------------------
// Extra: empty vault
// ---------------------------------------------------------------------------

test("renderPages: empty pages yields nothing", () => {
  const rendered = collectPages(new Map());
  assert.equal(rendered.size, 0);
});

// ---------------------------------------------------------------------------
// renderAggregate: tag pages, tag index, kind indexes, front page
// ---------------------------------------------------------------------------

function collectAll(
  pages: Map<string, { record?: PageRecord; text: string }>,
  opts = {},
  kindBlurbs: Map<string, string> = new Map(),
) {
  const meta = buildExportMeta(pages, opts);
  const result = new Map<string, string>();
  for (const { path, content } of renderAll(pages, meta, opts, kindBlurbs)) {
    result.set(path, content);
  }
  return result;
}

test("renderAggregate: emits tag pages for each tag", () => {
  const meta = buildExportMeta(wikiPages);
  const result = new Map<string, string>();
  for (const { path, content } of renderAggregate(wikiPages, meta)) {
    result.set(path, content);
  }
  // wikiPages has tags: alpha, shared, beta, concepts-only, entity-tag
  assert.ok(result.has("tags/alpha.html"), "tag page for 'alpha' missing");
  assert.ok(result.has("tags/shared.html"), "tag page for 'shared' missing");
  const alphaPage = result.get("tags/alpha.html")!;
  assert.ok(alphaPage.includes("Tag: alpha"), "tag page title missing");
  assert.ok(
    alphaPage.includes("Alpha Concept"),
    "alpha page should list Alpha Concept",
  );
});

test("renderAggregate: emits tag index", () => {
  const meta = buildExportMeta(wikiPages);
  const result = new Map<string, string>();
  for (const { path, content } of renderAggregate(wikiPages, meta)) {
    result.set(path, content);
  }
  assert.ok(result.has("tags/index.html"), "tag index missing");
  const tagIndex = result.get("tags/index.html")!;
  assert.ok(tagIndex.includes("Tags"), "tag index title missing");
  assert.ok(tagIndex.includes("alpha"), "tag index should list alpha tag");
});

test("renderAggregate: emits per-kind index pages", () => {
  const meta = buildExportMeta(wikiPages);
  const result = new Map<string, string>();
  for (const { path, content } of renderAggregate(wikiPages, meta)) {
    result.set(path, content);
  }
  assert.ok(result.has("wiki/concepts/index.html"), "concepts index missing");
  assert.ok(result.has("wiki/entities/index.html"), "entities index missing");
  assert.ok(result.has("wiki/sources/index.html"), "sources index missing");

  const conceptsIndex = result.get("wiki/concepts/index.html")!;
  assert.ok(
    conceptsIndex.includes("Concept pages"),
    "concepts index heading missing",
  );
  assert.ok(
    conceptsIndex.includes("Alpha Concept"),
    "concepts index should list Alpha Concept",
  );
});

test("renderAggregate: emits front page", () => {
  const meta = buildExportMeta(wikiPages);
  const result = new Map<string, string>();
  for (const { path, content } of renderAggregate(wikiPages, meta)) {
    result.set(path, content);
  }
  assert.ok(result.has("index.html"), "front page missing");
  const frontPage = result.get("index.html")!;
  assert.ok(frontPage.includes("Wiki"), "front page title missing");
  assert.ok(
    frontPage.includes("4 pages"),
    "front page should show total page count",
  );
  assert.ok(
    frontPage.includes("Get started"),
    "front page get-started missing",
  );
});

test("renderAggregate: front page shows kind blurb when provided", () => {
  const meta = buildExportMeta(wikiPages);
  const kindBlurbs = new Map([["concept", "Core building blocks"]]);
  const result = new Map<string, string>();
  for (const { path, content } of renderAggregate(
    wikiPages,
    meta,
    {},
    kindBlurbs,
  )) {
    result.set(path, content);
  }
  const frontPage = result.get("index.html")!;
  assert.ok(
    frontPage.includes("Core building blocks"),
    "front page should include kind blurb",
  );
});

test("renderAggregate: tag slugs are collision-safe", () => {
  // Two tags that produce the same slug: "foo bar" and "Foo Bar" → "foo-bar"
  const collidingPages = makePages([
    [
      "wiki/concepts/page-a.md",
      `---
title: Page A
summary: A
tags:
  - foo bar
  - Foo Bar
kind: concept
---
Body.
`,
    ],
  ]);
  const meta = buildExportMeta(collidingPages);
  const result = new Map<string, string>();
  for (const { path } of renderAggregate(collidingPages, meta)) {
    result.set(path, "");
  }
  // Both tags should have distinct paths
  const tagPaths = [...result.keys()].filter(
    (p) => p.startsWith("tags/") && p !== "tags/index.html",
  );
  assert.equal(tagPaths.length, 2, `expected 2 tag paths, got: ${tagPaths}`);
  assert.equal(new Set(tagPaths).size, 2, "tag paths should be distinct");
});

test("renderAggregate: nav header present on every aggregate page", () => {
  const meta = buildExportMeta(wikiPages);
  const result = new Map<string, string>();
  for (const { path, content } of renderAggregate(wikiPages, meta)) {
    result.set(path, content);
  }
  for (const [pagePath, content] of result) {
    assert.ok(content.includes("<nav>"), `nav bar missing on ${pagePath}`);
    assert.ok(content.includes("Home"), `Home link missing on ${pagePath}`);
    assert.ok(content.includes("Tags"), `Tags link missing on ${pagePath}`);
  }
});

test("renderAll: property — every intra-site link resolves to an emitted path", () => {
  const allRendered = collectAll(wikiPages);
  const emittedPaths = new Set(allRendered.keys());

  const failures: string[] = [];
  for (const [srcPath, content] of allRendered) {
    // Extract all href="..." values from the HTML
    const hrefRe = /href="([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = hrefRe.exec(content)) !== null) {
      const href = m[1];
      // Skip absolute URLs and anchor-only links
      if (href.startsWith("http") || href.startsWith("#") || href === "")
        continue;
      // Strip anchor fragment
      const [hrefPath] = href.split("#");
      if (!hrefPath || !hrefPath.endsWith(".html")) continue;
      // Resolve relative to the source file's directory using posix path ops
      const srcDir = srcPath.includes("/")
        ? srcPath.slice(0, srcPath.lastIndexOf("/"))
        : "";
      const joined = srcDir ? `${srcDir}/${hrefPath}` : hrefPath;
      const normalized = path.posix.normalize(joined);
      if (!emittedPaths.has(normalized)) {
        failures.push(
          `${srcPath}: broken link ${href} → resolved ${normalized}`,
        );
      }
    }
  }
  assert.deepEqual(
    failures,
    [],
    `broken intra-site links:\n${failures.join("\n")}`,
  );
});
