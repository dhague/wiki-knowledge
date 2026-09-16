import { test } from "node:test";
import assert from "node:assert/strict";
import { loadRecords, type PageRecord } from "./pagerecord.js";
import { buildExportMeta, type ExportOptions } from "./exportmeta.js";
import {
  assetsRootFor,
  buildHtmlShell,
  renderPageParts,
  renderPages,
} from "./exportrender.js";

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
  opts: ExportOptions = {},
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
// 7. Mobile-responsive shell — viewport meta, shared stylesheet, sticky nav
// ---------------------------------------------------------------------------

const VIEWPORT_META =
  '<meta name="viewport" content="width=device-width, initial-scale=1">';

test("assetsRootFor: resolves the shared assets directory at every depth", () => {
  assert.equal(assetsRootFor("index.html"), "./assets");
  assert.equal(assetsRootFor("tags/index.html"), "../assets");
  assert.equal(assetsRootFor("raw/doc.html"), "../assets");
  assert.equal(
    assetsRootFor("wiki/concepts/alpha-concept.html"),
    "../../assets",
  );
});

test("renderPages: every page carries the viewport meta tag", () => {
  const rendered = collectPages(wikiPages, { title: "Test Vault" });
  assert.ok(rendered.size > 0, "fixture should render pages");
  for (const [path, html] of rendered) {
    assert.ok(
      html.includes(VIEWPORT_META),
      `page ${path} should carry the viewport meta tag`,
    );
  }
});

test("renderPages: every page links the shared stylesheet at its own depth", () => {
  const rendered = collectPages(wikiPages, { title: "Test Vault" });
  for (const [path, html] of rendered) {
    const href = `${assetsRootFor(path)}/style.css`;
    assert.ok(
      html.includes(`<link rel="stylesheet" href="${href}">`),
      `page ${path} should link the stylesheet as ${href}`,
    );
  }
});

test("renderPages: no page inlines the stylesheet", () => {
  const rendered = collectPages(wikiPages, { title: "Test Vault" });
  for (const [path, html] of rendered) {
    assert.ok(
      !html.includes("<style"),
      `page ${path} must not carry an inline style block`,
    );
  }
});

test("renderPages: every page carries a sticky nav with the wiki title", () => {
  const rendered = collectPages(wikiPages, { title: "Test Vault" });
  for (const [path, html] of rendered) {
    assert.ok(
      html.includes('class="wiki-nav"'),
      `page ${path} should carry the sticky nav bar`,
    );
    assert.ok(
      html.includes('<span class="wiki-nav-title">Test Vault</span>'),
      `page ${path} nav should show the wiki title`,
    );
  }
});

test("renderPages: the nav puts the title before the links", () => {
  // "title left, Home right" is the bar's markup order; the layout that
  // realises it on screen is the shared stylesheet's, asserted separately.
  const rendered = collectPages(wikiPages, { title: "Test Vault" });
  for (const [path, html] of rendered) {
    const titleAt = html.indexOf('<span class="wiki-nav-title">');
    const linksAt = html.indexOf('<span class="wiki-nav-links">');
    assert.ok(titleAt !== -1 && linksAt !== -1, `${path} nav is well formed`);
    assert.ok(titleAt < linksAt, `${path} nav leads with the title`);
  }
});

test("renderPages: the nav title is HTML-escaped", () => {
  const rendered = collectPages(wikiPages, { title: 'A & B "quoted"' });
  const html = rendered.get("wiki/concepts/alpha-concept.html")!;
  assert.ok(
    html.includes("A &amp; B &quot;quoted&quot;"),
    "wiki title should be escaped in the nav",
  );
});

test("renderPageParts: a page's parts come back without the document shell", () => {
  const meta = buildExportMeta(wikiPages);
  const rendered = [
    ...renderPageParts(wikiPages, meta, { title: "Test Vault" }),
  ];
  assert.equal(rendered.length, 4);

  const alpha = rendered.find(
    (p) => p.path === "wiki/concepts/alpha-concept.html",
  )!;
  assert.equal(alpha.parts.title, "Alpha Concept");
  assert.ok(alpha.parts.nav.includes('class="wiki-nav"'));
  assert.ok(alpha.parts.main.includes("<article>"));

  for (const { path, parts } of rendered) {
    const fragment = parts.nav + parts.main;
    assert.ok(
      !fragment.includes("<!DOCTYPE") && !fragment.includes("<head>"),
      `parts for ${path} must not carry the document shell`,
    );
  }
});

test("buildHtmlShell: wraps parts around a shared-stylesheet link", () => {
  const html = buildHtmlShell(
    { title: "A Title", nav: "<nav>N</nav>", main: "<p>M</p>" },
    "../assets",
  );
  assert.ok(html.startsWith("<!DOCTYPE html>"));
  assert.ok(html.includes(VIEWPORT_META));
  assert.ok(html.includes("<title>A Title</title>"));
  assert.ok(
    html.includes('<link rel="stylesheet" href="../assets/style.css">'),
  );
  assert.ok(html.includes("<nav>N</nav>"));
  assert.ok(html.includes("<p>M</p>"));
  assert.ok(!html.includes("<style"), "shell must link, not inline");
});

test("buildHtmlShell: a null assetsRoot inlines (the single-file seam)", () => {
  const html = buildHtmlShell({ title: "T", nav: "", main: "" }, null);
  assert.ok(html.includes("<style>"), "null assetsRoot should inline CSS");
  assert.ok(html.includes("Sakura.css v"), "inlined CSS is the framework");
  assert.ok(
    !html.includes('rel="stylesheet"'),
    "nothing should be linked in single-file shape",
  );
});
