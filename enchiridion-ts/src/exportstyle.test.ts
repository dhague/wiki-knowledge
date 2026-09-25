import { test } from "node:test";
import assert from "node:assert/strict";
import { EXPORT_STYLESHEET, SAKURA_CSS } from "./exportstyle.js";

// ---------------------------------------------------------------------------
// Vendored framework
// ---------------------------------------------------------------------------

test("SAKURA_CSS: the vendored framework keeps its licence header", () => {
  assert.ok(SAKURA_CSS.startsWith("/* Sakura.css v"), "header comes first");
  assert.ok(
    SAKURA_CSS.includes("https://github.com/oxalorg/sakura/"),
    "header names the upstream project (MIT)",
  );
});

test("SAKURA_CSS: is the vendor drop, untouched by our own rules", () => {
  // Spot-checks, then proof nothing enchiridion-owned leaked into the drop.
  assert.ok(SAKURA_CSS.includes("body {"));
  assert.ok(SAKURA_CSS.includes("table {"));
  for (const owned of ["wiki-nav", "frontmatter", "fm-divider"]) {
    assert.ok(!SAKURA_CSS.includes(owned), `Sakura knows nothing of ${owned}`);
  }
});

// ---------------------------------------------------------------------------
// Supplement
// ---------------------------------------------------------------------------

test("EXPORT_STYLESHEET: carries the framework ahead of the supplement", () => {
  const frameworkAt = EXPORT_STYLESHEET.indexOf("Sakura.css v");
  const supplementAt = EXPORT_STYLESHEET.indexOf(
    "enchiridion export supplement",
  );
  assert.ok(frameworkAt !== -1, "framework is present");
  assert.ok(supplementAt !== -1, "supplement is present");
  assert.ok(
    frameworkAt < supplementAt,
    "the supplement overrides the framework, so it comes after it",
  );
});

test("EXPORT_STYLESHEET: pins the nav bar to the top of the viewport", () => {
  const block = /nav\.wiki-nav\s*\{([^}]*)\}/.exec(EXPORT_STYLESHEET)?.[1];
  assert.ok(block, "the nav bar has a rule of its own");
  assert.match(block, /position:\s*sticky/);
  assert.match(block, /top:\s*0/);
  assert.match(block, /background-color:/, "opaque, or content shows through");
  assert.match(
    block,
    /display:\s*flex/,
    "the title and the links need a layout, not inline flow",
  );
  assert.match(
    block,
    /justify-content:\s*space-between/,
    "title left, links right — this is what puts them there",
  );
});

test("EXPORT_STYLESHEET: drops the bespoke dark-mode block", () => {
  assert.ok(
    !EXPORT_STYLESHEET.includes("prefers-color-scheme"),
    "the hand-rolled dark variant is gone; Sakura has no automatic dark mode",
  );
});

test("EXPORT_STYLESHEET: sets the page header's summary apart from body text", () => {
  // The summary must not read as the article's first paragraph.
  const heading = /\.page-header h1\s*\{([^}]*)\}/.exec(EXPORT_STYLESHEET)?.[1];
  assert.ok(heading, "the header's title has a rule of its own");
  assert.match(heading, /margin-bottom:/);

  const summary = /\.page-summary\s*\{([^}]*)\}/.exec(EXPORT_STYLESHEET)?.[1];
  assert.ok(summary, "the summary has a rule of its own");
  assert.match(summary, /font-size:/);
  assert.match(summary, /color:/, "it reads as a subtitle, not as prose");
});

test("EXPORT_STYLESHEET: keeps the frontmatter table legible", () => {
  const frontmatterRules = EXPORT_STYLESHEET.match(
    /table\.frontmatter[^{]*\{[^}]*\}/g,
  );
  assert.ok(
    frontmatterRules && frontmatterRules.length > 0,
    "the supplement styles the frontmatter table",
  );
  assert.ok(
    frontmatterRules.some((rule) => rule.includes("white-space: nowrap")),
    "the key column is a label column, not wrapping prose",
  );
  // The margin collapses with the preceding block's, so this only supplies
  // the gap when that block has none.
  assert.ok(
    frontmatterRules.some((rule) => /margin-top:\s*[\d.]+rem/.test(rule)),
    "the footer table keeps a gap above it",
  );

  // Borders collapse under Sakura's `td` rule, so the divider must out-weigh
  // it on width or it inherits the row rule and disappears.
  const divider = /tr\.fm-divider td\s*\{([^}]*)\}/.exec(
    EXPORT_STYLESHEET,
  )?.[1];
  assert.ok(divider, "the divider row has a rule of its own");
  const borderTop = /border-top:\s*(\d+)px/.exec(divider)?.[1];
  assert.ok(borderTop, "the divider draws a line");
  assert.ok(
    Number(borderTop) > 1,
    "the divider must be thicker than Sakura's 1px row rule to win the collapse",
  );
});
