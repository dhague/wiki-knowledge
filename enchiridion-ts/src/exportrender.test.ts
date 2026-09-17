import { test } from "node:test";
import assert from "node:assert/strict";
import { loadRecords, type PageRecord } from "./pagerecord.js";
import { buildExportMeta, type ExportOptions } from "./exportmeta.js";
import {
  FRONT_SECTION_ID,
  assetsRootFor,
  buildDocument,
  buildHtmlShell,
  renderPageParts,
  renderPages,
  sectionIdFor,
  type LinkMode,
} from "./exportrender.js";
// The other module that has to read an author's destination — the one a page
// move rewrites links for.
import { planMove } from "./wikipage.js";

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

test("buildDocument: the skeleton both output shapes share", () => {
  // Nothing mode-specific lives here — no nav, no stylesheet decision, no
  // sections. Each shape supplies its own style element and body.
  const html = buildDocument("A Title", "<style>x</style>", "<p>Body</p>");
  assert.ok(html.startsWith("<!DOCTYPE html>"));
  assert.ok(html.includes(VIEWPORT_META), "the viewport meta every mode wants");
  assert.ok(html.includes("<title>A Title</title>"));
  assert.ok(html.includes("<style>x</style>"));
  assert.ok(html.includes("<body>\n<p>Body</p>\n</body>"));
});

// ---------------------------------------------------------------------------
// 8. Single-file link seam — section ids and #fragment hrefs
// ---------------------------------------------------------------------------

test("sectionIdFor: flattens a page's output path into a section id", () => {
  assert.equal(
    sectionIdFor("wiki/concepts/alpha-concept.html"),
    "wiki-concepts-alpha-concept",
  );
  assert.equal(sectionIdFor("tags/alpha.html"), "tags-alpha");
  assert.equal(sectionIdFor("tags/index.html"), "tags-index");
  assert.equal(sectionIdFor("wiki/concepts/index.html"), "wiki-concepts-index");
  assert.equal(sectionIdFor("raw/2026/notes.html"), "raw-2026-notes");
});

test("sectionIdFor: the front page takes the reserved id, which nothing else can", () => {
  assert.equal(FRONT_SECTION_ID, "__front");
  assert.equal(sectionIdFor("index.html"), FRONT_SECTION_ID);
  // Underscores never survive the derivation, so no page can claim the
  // reserved id by accident.
  for (const p of ["wiki/concepts/a_b.html", "raw/__front.html"]) {
    assert.ok(!sectionIdFor(p).includes("_"), `${p} must not derive an _`);
  }
});

test("sectionIdFor: a path with no extension still derives an id", () => {
  assert.equal(sectionIdFor("raw/notes"), "raw-notes");
});

test("renderPageParts: single-file mode rewrites body links to #section", () => {
  const meta = buildExportMeta(wikiPages);
  const rendered = [
    ...renderPageParts(wikiPages, meta, { title: "Test Vault" }, "single-file"),
  ];
  const alpha = rendered.find(
    (p) => p.path === "wiki/concepts/alpha-concept.html",
  )!;
  assert.ok(
    alpha.parts.main.includes('href="#wiki-concepts-beta-concept"'),
    "a body link should become the target's section fragment",
  );
  assert.ok(
    alpha.parts.main.includes('href="#wiki-entities-alpha-entity"'),
    "a link across folders should become a section fragment too",
  );
  assert.ok(
    !alpha.parts.main.includes('href="beta-concept.html"'),
    "no .html href should survive single-file rewriting",
  );
});

test("renderPageParts: single-file mode rewrites nav, tag and frontmatter links", () => {
  const meta = buildExportMeta(wikiPages);
  const rendered = [
    ...renderPageParts(wikiPages, meta, { title: "Test Vault" }, "single-file"),
  ];
  const alpha = rendered.find(
    (p) => p.path === "wiki/concepts/alpha-concept.html",
  )!;
  assert.ok(
    alpha.parts.nav.includes('href="#__front"') &&
      alpha.parts.nav.includes('href="#tags-index"'),
    "nav should point at the home and tag-index sections",
  );
  assert.ok(
    alpha.parts.main.includes('href="#tags-alpha"'),
    "a frontmatter tag should link to its tag section",
  );
  assert.ok(
    alpha.parts.main.includes('href="#wiki-concepts-beta-concept"'),
    "a frontmatter edge should link to its target's section",
  );
});

// A raw artifact keeps its own extension, so the links that name one — the
// body's, and the `raw_source` pointer in the frontmatter — are not `.md`
// links. In single-file mode they are the mode's business all the same: a
// relative destination there is a link out of the file.
const rawLinkingSource = `---
title: Source One
kind: source
raw_source: "[report.txt](../../raw/reports/report.txt)"
---

See [the report](../../raw/reports/report.txt).
Also ![a picture](../assets/diagram.png) and [mail](mailto:someone@example.com).
`;

function renderOne(
  pages: Map<string, { record?: PageRecord; text: string }>,
  opts: ExportOptions,
  mode: "multi-page" | "single-file",
): string {
  const meta = buildExportMeta(pages, opts);
  const found = [...renderPageParts(pages, meta, opts, mode)].find(
    (p) => p.path === "wiki/sources/source-one.html",
  );
  assert.ok(found, "fixture should render the source page");
  return found.parts.main;
}

test("renderPageParts: single-file rewrites a link to a non-.md exported page", () => {
  const pages = makePages([
    ["wiki/sources/source-one.md", rawLinkingSource],
    ["raw/reports/report.txt", "raw text"],
  ]);
  const main = renderOne(pages, { includeRaw: true }, "single-file");
  assert.ok(
    main.includes('href="#raw-reports-report-txt"'),
    "a raw artifact's link should become its section's fragment",
  );
  assert.ok(
    !main.includes("raw/reports/report.txt"),
    "no relative destination should survive in a one-file document",
  );
});

test("renderPageParts: single-file strips a link to a non-exported relative path", () => {
  const pages = makePages([
    ["wiki/sources/source-one.md", rawLinkingSource],
    ["raw/reports/report.txt", "raw text"],
  ]);
  // Without --raw the artifact is not in the export, so there is nothing to
  // link to — and a relative path would leave the file, so it goes.
  const main = renderOne(pages, {}, "single-file");
  assert.ok(
    main.includes("the report"),
    "the label should survive as plain text",
  );
  assert.ok(
    !main.includes("raw/reports/report.txt"),
    "the dangling destination should be gone, not left to be tapped",
  );
});

test("renderPageParts: multi-page leaves a non-.md relative link alone", () => {
  const pages = makePages([
    ["wiki/sources/source-one.md", rawLinkingSource],
    ["raw/reports/report.txt", "raw text"],
  ]);
  const main = renderOne(pages, { includeRaw: true }, "multi-page");
  assert.ok(
    main.includes('href="../../raw/reports/report.txt"'),
    "multi-page output writes the file the link names, so it keeps the link",
  );
});

test("renderPageParts: single-file leaves images and absolute URIs alone", () => {
  const pages = makePages([
    ["wiki/sources/source-one.md", rawLinkingSource],
    ["raw/reports/report.txt", "raw text"],
  ]);
  const main = renderOne(pages, { includeRaw: true }, "single-file");
  assert.ok(
    main.includes('src="../assets/diagram.png"'),
    "an image is not a link out of the file — it is left as the author wrote it",
  );
  assert.ok(
    main.includes('href="mailto:someone@example.com"'),
    "an absolute URI is not a relative destination",
  );
});

// ---------------------------------------------------------------------------
// One question, two modules: is this destination a vault-relative reference?
// ---------------------------------------------------------------------------

/** An author's destination, and what that question answers for it. The four
 * schemes are the rows #500 was about — a URI whose scheme carries no `//`,
 * which merely looks relative to a test that only knows `://`. The rest pin
 * the edges of the same rule: the vault's own extension, an external URL, an
 * absolute path, and a relative destination that is neither. */
const destCases: Array<[dest: string, vaultRelative: boolean]> = [
  ["beta-concept.md", true],
  ["C:notes.md", true],
  ["assets/diagram.png", true],
  ["mailto:x@y.z", false],
  ["mailto:x@y.z?subject=(hi)", false],
  ["tel:+441234567", false],
  ["data:text/plain,hi", false],
  ["urn:isbn:0451450523", false],
  ["https://example.com/b.md", false],
  ["/absolute/b.md", false],
];

/** Whether a mode claims dest — the export rewrites a claimed destination to
 * the output's own spelling of its target, or strips it to plain label text,
 * so a claimed one never survives as written; an unclaimed one is left exactly
 * as the author wrote it. (Markdown-it renders a `data:` URL as text of its
 * own accord, and an unclaimed destination is one the export did not touch —
 * which is the fact the assertion reads either way.) */
function exportClaims(dest: string, mode: LinkMode): boolean {
  const pages = makePages([
    [
      "wiki/concepts/alpha-concept.md",
      `---\ntitle: Alpha Concept\nkind: concept\n---\n\nSee [x](${dest}).\n`,
    ],
    ["wiki/concepts/beta-concept.md", conceptB],
  ]);
  const meta = buildExportMeta(pages, {});
  const found = [...renderPageParts(pages, meta, {}, mode)].find(
    (p) => p.path === "wiki/concepts/alpha-concept.html",
  );
  assert.ok(found, "fixture should render the linking page");
  return !found.parts.main.includes(dest);
}

/** Whether a page move re-spells dest: whether wikipage reads it as a
 * vault-relative reference. The page carrying it is moved across folders, so
 * every destination it does read that way is re-spelled against a different
 * directory and cannot come back byte-identical — while one it does not read
 * that way is untouched, whether or not a page exists at the path it names. */
function moveRespells(dest: string): boolean {
  const text = `# A\n\nSee [x](${dest}).\n`;
  const moved = planMove(
    { "wiki/concepts/a.md": text, "wiki/entities/b.md": "# B\n" },
    "wiki/concepts/a.md",
    "wiki/entities/a.md",
  );
  return moved["wiki/entities/a.md"] !== text;
}

test("export and wikipage agree on which destinations are vault-relative", () => {
  for (const [dest, vaultRelative] of destCases) {
    assert.equal(
      exportClaims(dest, "single-file"),
      vaultRelative,
      `${dest}: single-file export claims it?`,
    );
    assert.equal(
      moveRespells(dest),
      vaultRelative,
      `${dest}: move respells it?`,
    );
  }
});

test("multi-page output is the narrower test, and its half is deliberate", () => {
  // Multi-page output is a directory of files: it claims the export's own
  // `.md` destinations and leaves everything else where the author put it,
  // relative paths included. wikipage owns every vault-relative destination,
  // so this is the one column where the two are meant to differ — and the
  // schemes agree in it all the same.
  for (const [dest, vaultRelative] of destCases) {
    assert.equal(
      exportClaims(dest, "multi-page"),
      vaultRelative && dest.endsWith(".md"),
      `${dest}: multi-page export claims it?`,
    );
  }
});

test("renderPageParts: a bare in-page anchor is left alone in single-file mode", () => {
  const meta = buildExportMeta(wikiPages);
  const rendered = [
    ...renderPageParts(wikiPages, meta, { title: "Test Vault" }, "single-file"),
  ];
  const entity = rendered.find(
    (p) => p.path === "wiki/entities/alpha-entity.html",
  )!;
  // Same page, so the same section: the heading id is the right destination.
  assert.ok(
    entity.parts.main.includes('href="#section-two"'),
    "an in-page anchor should survive as a heading anchor",
  );
  assert.ok(
    entity.parts.main.includes("https://example.com"),
    "an external URL should be untouched",
  );
});

test("renderPageParts: the default is still multi-page relative links", () => {
  const meta = buildExportMeta(wikiPages);
  const rendered = [...renderPageParts(wikiPages, meta, { title: "T" })];
  const alpha = rendered.find(
    (p) => p.path === "wiki/concepts/alpha-concept.html",
  )!;
  assert.ok(
    alpha.parts.main.includes('href="beta-concept.html"'),
    "omitting the href strategy must leave multi-page output alone",
  );
});
