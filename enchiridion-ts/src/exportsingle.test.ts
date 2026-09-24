/**
 * Tests for the single-file export: the whole site as one self-contained
 * document whose pages are sections.
 *
 * The claims here are about the document as a whole — the full set of
 * sections, every link in it, every resource it could fetch — so they are
 * asserted across the whole exported set rather than on a sample page.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { loadRecords, type PageRecord } from "./pagerecord.js";
import { buildExportMeta, type ExportOptions } from "./exportmeta.js";
import { renderPageParts, sectionIdFor } from "./exportrender.js";
import { renderAggregateParts } from "./exportaggregate.js";
import {
  SINGLE_FILE_WARN_BYTES,
  renderSingleFile,
  singleFileSizeWarning,
} from "./exportsingle.js";

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

Jump to [the second section](#section-two).
`;

const conceptB = `---
title: Beta Concept
summary: The second concept.
tags:
  - beta
  - shared
kind: concept
---

Back to [Alpha Concept, section two](alpha-concept.md#section-two).
`;

const entityA = `---
title: Alpha Entity
summary: An entity page.
tags:
  - alpha
kind: entity
---

An [external link](https://example.com) that is the author's, not ours.
`;

const rawDoc = `---
title: Raw Document
---

Raw content mentioning Alpha Concept.
`;

/** A source page whose raw artifact is not markdown — the shape the vault's
 *  own chain of evidence produces: raw filenames are kept verbatim, so the
 *  `raw_source` pointer names `.txt`, `.html` or whatever the file was. */
const sourceWithRaw = `---
title: Source With Raw
summary: A source page pointing at a text artifact.
tags:
  - source-tag
kind: source
raw_source: "[transcript.txt](../../raw/notes/transcript.txt)"
---

Read [the transcript](../../raw/notes/transcript.txt).
`;

const rawTranscript = `Transcript of a session, kept verbatim.
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
]);

function render(pages: typeof wikiPages, opts: ExportOptions = {}) {
  const meta = buildExportMeta(pages, opts);
  return renderSingleFile(pages, meta, opts);
}

// ---------------------------------------------------------------------------
// Document-wide readers
// ---------------------------------------------------------------------------

/** The ids of every section in the document, in document order. */
function sectionIds(html: string): string[] {
  return [...html.matchAll(/<section id="([^"]+)"/g)].map((m) => m[1]);
}

/** The ids of every element in the document that carries one. */
function elementIds(html: string): Set<string> {
  return new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
}

/** Every href in the document, in document order. */
function hrefs(html: string): string[] {
  return [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
}

// ---------------------------------------------------------------------------
// 1. One section per exported page and aggregate
// ---------------------------------------------------------------------------

test("renderSingleFile: every exported page and aggregate becomes a section", () => {
  const html = render(wikiPages, { title: "Test Vault" });

  // The whole set: whatever the parts generators yield is what must appear.
  const meta = buildExportMeta(wikiPages, { title: "Test Vault" });
  const opts = { title: "Test Vault" };
  const expectedParts = [
    ...renderPageParts(wikiPages, meta, opts),
    ...renderAggregateParts(wikiPages, meta, opts),
  ].map((p) => p.path);
  assert.ok(expectedParts.length > 0, "fixture should produce parts");

  const actual = sectionIds(html);
  assert.deepEqual(
    [...actual].sort(),
    expectedParts.map(sectionIdFor).sort(),
    "every part should be a section, and nothing else should be",
  );
  assert.equal(
    new Set(actual).size,
    actual.length,
    "no two sections may share an id — one of them would be unreachable",
  );
});

test("renderSingleFile: names the sections the links and the front page rely on", () => {
  const ids = sectionIds(render(wikiPages, { title: "Test Vault" }));
  for (const id of [
    "__front", // the front page
    "wiki-concepts-alpha-concept", // a page two directories deep
    "wiki-entities-alpha-entity", // a page of another kind
    "tags-alpha", // a tag page
    "tags-index", // the tag index
    "wiki-concepts-index", // a per-kind index page
  ]) {
    assert.ok(ids.includes(id), `section ${id} should be in the document`);
  }
});

test("renderSingleFile: each section holds its own nav, header and article", () => {
  const html = render(wikiPages, { title: "Test Vault" });
  const section =
    /<section id="wiki-concepts-alpha-concept"[^>]*>([\s\S]*?)<\/section>/.exec(
      html,
    )?.[1];
  assert.ok(section, "alpha-concept should have a section");
  assert.ok(
    section.includes('class="wiki-nav"'),
    "the section carries its own nav bar",
  );
  assert.ok(
    section.includes('<header class="page-header">') &&
      section.includes('<h1 id="alpha-concept">Alpha Concept</h1>') &&
      section.includes('<p class="page-summary">The first concept.</p>'),
    "the section carries the extracted title and summary",
  );
  assert.ok(
    section.indexOf('<header class="page-header">') <
      section.indexOf("<article>"),
    "the header comes before the article",
  );
  assert.ok(section.includes("<article>"), "the section carries its article");
  assert.ok(
    section.includes('id="section-two"'),
    "its own headings stay inside it",
  );
});

test("renderSingleFile: no section leads with a frontmatter table", () => {
  const pages = makePages([
    ["wiki/concepts/alpha-concept.md", conceptA],
    ["wiki/sources/source-with-raw.md", sourceWithRaw],
    ["raw/raw-doc.md", rawDoc],
    ["raw/notes/transcript.txt", rawTranscript],
  ]);
  const html = render(pages, { title: "Test Vault", includeRaw: true });

  const sections = [
    ...html.matchAll(/<section id="([^"]+)"[^>]*>([\s\S]*?)<\/section>/g),
  ];
  assert.ok(sections.length > 0, "fixture should produce sections");
  let sectionsWithTable = 0;
  for (const [, id, body] of sections) {
    // The nav is the section's first element; what follows it is the page's
    // own content, and the first of that must be the article, not metadata.
    assert.ok(body.includes("</nav>"), `section ${id} should carry its nav`);
    const afterNav = body
      .slice(body.indexOf("</nav>") + "</nav>".length)
      .trimStart();
    assert.ok(
      !afterNav.startsWith('<table class="frontmatter">'),
      `section ${id} must not open with a frontmatter table`,
    );
    // Where the section carries a table at all, it trails the article — the
    // wiki page's own builder and the raw page's inline one both.
    const table = body.indexOf('<table class="frontmatter">');
    const article = body.indexOf("<article>");
    if (table !== -1) {
      sectionsWithTable++;
      assert.ok(
        article !== -1 && article < table,
        `section ${id}: the article should precede its frontmatter table`,
      );
    }
  }
  assert.equal(
    sectionsWithTable,
    3,
    "the loop must actually meet the fixture's frontmatter tables",
  );
});

// ---------------------------------------------------------------------------
// 2. Single document shell: inlined CSS and script, no assets
// ---------------------------------------------------------------------------

test("renderSingleFile: inlines the framework CSS in a style block", () => {
  const html = render(wikiPages, { title: "Test Vault" });
  assert.ok(
    html.includes("<style>"),
    "the document should carry a style block",
  );
  assert.ok(html.includes("Sakura.css v"), "the framework should be inlined");
  assert.ok(
    html.includes("nav.wiki-nav"),
    "the export supplement should be inlined with it",
  );
  assert.ok(
    !html.includes('rel="stylesheet"'),
    "nothing should be linked as a stylesheet",
  );
  assert.ok(
    !html.includes("assets/"),
    "single-file output has no assets directory to point at",
  );
});

test("renderSingleFile: hides sections until the script shows one", () => {
  const html = render(wikiPages, { title: "Test Vault" });
  assert.match(
    html,
    /section\.wiki-page\s*\{\s*display:\s*none/,
    "sections should be hidden by the inlined CSS",
  );
  assert.match(
    html,
    /\.wiki-page\.active\s*\{\s*display:\s*block/,
    "the shown section should be the active one",
  );
});

test("renderSingleFile: carries a viewport meta tag and the wiki title", () => {
  const html = render(wikiPages, { title: "Test Vault" });
  assert.ok(
    html.includes(
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
    ),
    "the document should be mobile-readable",
  );
  assert.ok(html.includes("<title>Test Vault</title>"), "document title");
});

test("renderSingleFile: ships an inline script and nothing external", () => {
  const html = render(wikiPages, { title: "Test Vault" });
  const scripts = [...html.matchAll(/<script\b([^>]*)>/g)];
  assert.equal(scripts.length, 1, "exactly one script block");
  assert.ok(
    !scripts[0][1].includes("src"),
    "the script must be inline, not fetched",
  );
  assert.ok(html.includes("hashchange"), "the script reacts to hash changes");
  assert.ok(
    html.includes("location.hash"),
    "the script reads the hash on load",
  );
});

test("renderSingleFile: fetches nothing — no link, no import, no url()", () => {
  const html = render(wikiPages, { title: "Test Vault" });
  assert.ok(!html.includes("<link"), "no <link> element of any kind");
  assert.ok(!html.includes("@import"), "no CSS import");
  assert.ok(
    !/url\(\s*['"]?(?:https?:)?\/\//.test(html),
    "no CSS rule should fetch a remote resource",
  );
  assert.ok(
    !/<(?:img|iframe|video|audio|source|embed)\b[^>]*\ssrc=/i.test(html),
    "no embedded element should fetch a remote resource",
  );
});

// ---------------------------------------------------------------------------
// 3. Links: every internal link is a fragment that resolves
// ---------------------------------------------------------------------------

test("renderSingleFile: no internal link is a .html path any more", () => {
  const html = render(wikiPages, { title: "Test Vault" });
  const pageLinks = hrefs(html).filter(
    (h) => h.endsWith(".html") || h.includes(".html#"),
  );
  assert.deepEqual(pageLinks, [], "every .html href should be gone");
});

test("renderSingleFile: no href is a relative path at all", () => {
  // The stronger claim, and the one that keeps the file's promise: every href
  // is a fragment (it stays in the document) or an absolute URI (the author's
  // own, and never ours). A relative path would be a link out of the file.
  const pages = makePages([
    ["wiki/concepts/alpha-concept.md", conceptA],
    ["wiki/sources/source-with-raw.md", sourceWithRaw],
    ["raw/notes/transcript.txt", rawTranscript],
  ]);
  const html = render(pages, { title: "Test Vault", includeRaw: true });
  const relative = hrefs(html).filter(
    (h) => !h.startsWith("#") && !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(h),
  );
  assert.deepEqual(relative, [], "no href should point outside the document");
});

test("renderSingleFile: a raw_source pointer becomes a section fragment", () => {
  const pages = makePages([
    ["wiki/sources/source-with-raw.md", sourceWithRaw],
    ["raw/notes/transcript.txt", rawTranscript],
  ]);

  const withRaw = render(pages, { title: "Test Vault", includeRaw: true });
  assert.ok(
    withRaw.includes('href="#raw-notes-transcript-txt"'),
    "the raw artifact's link should point at its section",
  );
  assert.ok(
    sectionIds(withRaw).includes("raw-notes-transcript-txt"),
    "and that section should exist — the raw file keeps its own extension",
  );

  // Without --raw there is no such section, so the pointer is not a link.
  const withoutRaw = render(pages, { title: "Test Vault" });
  assert.ok(
    !withoutRaw.includes("raw/notes/transcript.txt"),
    "an unexported artifact leaves no destination behind",
  );
  assert.ok(
    withoutRaw.includes("transcript.txt"),
    "its label stays as plain text",
  );
});

test("renderSingleFile: every fragment href resolves to an element that exists", () => {
  const html = render(wikiPages, { title: "Test Vault" });
  const ids = elementIds(html);
  const fragments = hrefs(html).filter((h) => h.startsWith("#"));
  assert.ok(fragments.length > 0, "fixture should produce fragment links");
  for (const fragment of fragments) {
    assert.ok(
      ids.has(fragment.slice(1)),
      `href="${fragment}" resolves to nothing in the document`,
    );
  }
});

test("renderSingleFile: every page link is a section, not a heading", () => {
  const html = render(wikiPages, { title: "Test Vault" });
  const ids = new Set(sectionIds(html));
  // Cross-page links (including one carrying #section-two) are fragments too,
  // and every one of them has to name a section.
  for (const fragment of [
    "#wiki-concepts-alpha-concept",
    "#wiki-concepts-beta-concept",
    "#__front",
  ]) {
    assert.ok(
      hrefs(html).includes(fragment),
      `${fragment} should be linked from somewhere`,
    );
    assert.ok(ids.has(fragment.slice(1)), `${fragment} names a real section`);
  }
});

test("renderSingleFile: an in-page anchor still points at its heading", () => {
  const html = render(wikiPages, { title: "Test Vault" });
  assert.ok(
    hrefs(html).includes("#section-two"),
    "the bare anchor should survive as a heading anchor",
  );
});

test("renderSingleFile: the front page is the no-hash destination", () => {
  const html = render(wikiPages, { title: "Test Vault" });
  assert.ok(
    html.includes('id="__front"'),
    "the front page section carries the id the script falls back to",
  );
  assert.ok(
    /__front/.test(html.slice(html.indexOf("<script"))),
    "the script should name the front-page fallback",
  );
});

// ---------------------------------------------------------------------------
// 4. raw/ pages
// ---------------------------------------------------------------------------

test("renderSingleFile: raw pages are excluded by default", () => {
  const pages = makePages([
    ["wiki/concepts/alpha-concept.md", conceptA],
    ["raw/raw-doc.md", rawDoc],
  ]);
  const ids = sectionIds(render(pages, { title: "T" }));
  assert.ok(
    !ids.some((id) => id.startsWith("raw")),
    "raw sections should not be exported by default",
  );
});

test("renderSingleFile: --raw adds a section per raw page", () => {
  const pages = makePages([
    ["wiki/concepts/alpha-concept.md", conceptA],
    ["raw/raw-doc.md", rawDoc],
  ]);
  const ids = sectionIds(render(pages, { title: "T", includeRaw: true }));
  assert.ok(ids.includes("raw-raw-doc"), "the raw page should be a section");
});

// ---------------------------------------------------------------------------
// 5. The size warning
// ---------------------------------------------------------------------------

test("singleFileSizeWarning: silent at or below the threshold", () => {
  assert.equal(singleFileSizeWarning(0, "wiki.html"), null);
  assert.equal(
    singleFileSizeWarning(SINGLE_FILE_WARN_BYTES, "wiki.html"),
    null,
  );
  assert.equal(SINGLE_FILE_WARN_BYTES, 5 * 1024 * 1024, "5 MB");
});

test("singleFileSizeWarning: warns above it, and suggests multi-page", () => {
  const warning = singleFileSizeWarning(
    SINGLE_FILE_WARN_BYTES + 1,
    "wiki.html",
  );
  assert.ok(warning, "an oversized export should warn");
  assert.match(warning, /wiki\.html/, "the warning names the file");
  assert.match(warning, /multi-page/i, "the warning suggests the alternative");
});

// ---------------------------------------------------------------------------
// 6. The navigation script's state machine
// ---------------------------------------------------------------------------

/**
 * The document's own inline script, run against a stub DOM, walking `hashes`
 * one at a time (each a hashchange) and reporting which section ends up
 * shown. A section is shown by carrying the `active` class the stylesheet
 * gives a `display: block` to.
 *
 * Not a browser, but it is the whole of what the script touches — a list of
 * sections with ids, `location.hash`, and one event listener — and the
 * behaviours it decides are exactly the ones a string assertion cannot see:
 * which section a hash shows, which one an empty hash shows, and which one a
 * heading anchor leaves alone.
 */
function walkHasher(
  html: string,
  hashes: string[],
  initialHash = "",
): string[] {
  const script = /<script>([\s\S]*)<\/script>/.exec(html)?.[1];
  assert.ok(script, "the document should carry the inline script");

  const sections = sectionIds(html).map((id) => ({
    id,
    className: "wiki-page",
  }));
  const shown: string[] = [];
  const active = (): string =>
    sections.find((s) => s.className.includes("active"))?.id ?? "";

  const location = { hash: initialHash };
  const listeners: Array<() => void> = [];
  const window = {
    addEventListener: (event: string, fn: () => void) => {
      if (event === "hashchange") listeners.push(fn);
    },
    scrollTo: () => {},
  };
  const document = { querySelectorAll: () => sections };

  new Function("document", "location", "window", script)(
    document,
    location,
    window,
  );
  shown.push(active()); // the cold open, before any hash change

  for (const hash of hashes) {
    location.hash = hash;
    for (const fn of listeners) fn();
    shown.push(active());
  }
  return shown;
}

test("the script: a cold open with no hash shows the front page", () => {
  const html = render(wikiPages, { title: "Test Vault" });
  assert.deepEqual(walkHasher(html, []), ["__front"]);
});

test("the script: a cold open on a #slug deep link shows that section", () => {
  const html = render(wikiPages, { title: "Test Vault" });
  assert.deepEqual(walkHasher(html, [], "#wiki-concepts-beta-concept"), [
    "wiki-concepts-beta-concept",
  ]);
});

test("the script: a cold open on a hash that names no section shows the front page", () => {
  const html = render(wikiPages, { title: "Test Vault" });
  assert.deepEqual(walkHasher(html, [], "#not-a-section"), ["__front"]);
});

test("the script: a link swaps the section, and Back swaps it back", () => {
  const html = render(wikiPages, { title: "Test Vault" });
  // Cold open, tap through to a tag index, then Back — which returns the URL
  // to the document root, the same no-hash state a cold open starts in.
  assert.deepEqual(walkHasher(html, ["#tags-index", ""]), [
    "__front",
    "tags-index",
    "__front",
  ]);
});

test("the script: Back through two pages retraces them", () => {
  const html = render(wikiPages, { title: "Test Vault" });
  assert.deepEqual(
    walkHasher(html, [
      "#wiki-concepts-alpha-concept",
      "#wiki-concepts-beta-concept",
      "#wiki-concepts-alpha-concept",
    ]),
    [
      "__front",
      "wiki-concepts-alpha-concept",
      "wiki-concepts-beta-concept",
      "wiki-concepts-alpha-concept",
    ],
  );
});

test("the script: a heading anchor leaves the section on screen alone", () => {
  const html = render(wikiPages, { title: "Test Vault" });
  // #section-two is a heading inside alpha-concept: the browser scrolls to it
  // itself, and the script must not swap the page out from under it.
  assert.deepEqual(
    walkHasher(html, ["#wiki-concepts-alpha-concept", "#section-two"]),
    ["__front", "wiki-concepts-alpha-concept", "wiki-concepts-alpha-concept"],
  );
});

test("renderSingleFile: an empty vault still yields a front page", () => {
  const html = renderSingleFile(new Map(), buildExportMeta(new Map()), {});
  assert.ok(
    html.includes('id="__front"'),
    "the front page is always there to land on",
  );
  assert.ok(html.startsWith("<!DOCTYPE html>"));
});
