/**
 * bodycontent tests — the Consolidation losslessness boundary: which markdown
 * differences are presentation (normalised away) and which are content.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  bodyBlocks,
  firstUnmatchedBlock,
  type BodyBlock,
} from "./bodycontent.js";

/** Whether `want`'s canonical block sequence sits inside `have`'s, unbroken. */
function contains(want: string, have: string): boolean {
  return firstUnmatchedBlock(bodyBlocks(want), bodyBlocks(have)) === -1;
}

function unmatched(want: string, have: string): BodyBlock | null {
  const wantBlocks = bodyBlocks(want);
  const at = firstUnmatchedBlock(wantBlocks, bodyBlocks(have));
  return at === -1 ? null : wantBlocks[at];
}

// --- Normalised away: a difference here still passes ------------------------

test("normalises away line endings (CRLF and lone CR read as LF)", () => {
  assert.ok(contains("alpha\nbravo\n", "alpha\r\nbravo\r\n"), "LF vs CRLF");
  assert.ok(contains("alpha\rbravo\r", "alpha\nbravo\n"), "lone CR vs LF");
  assert.ok(
    contains("```js\nlet x = 1;\n```\n", "```js\r\nlet x = 1;\r\n```\r\n"),
    "line endings inside a fence",
  );
});

test("normalises away whitespace outside code", () => {
  assert.ok(
    contains("A hard-wrapped\nparagraph.\n", "A hard-wrapped paragraph.\n"),
    "hard wrap vs one line",
  );
  assert.ok(
    contains("  indented   text  \n", "indented text\n"),
    "indentation and interior/trailing spaces",
  );
  assert.ok(contains("A\n\n\n\nB\n", "A\n\nB\n"), "blank lines between blocks");
  assert.ok(contains("a  \nb\n", "a b\n"), "hard break vs plain line end");
});

test("normalises away heading spelling", () => {
  assert.ok(contains("## X\n", "### X\n"), "level 2 vs level 3");
  assert.ok(contains("## A\n\nx\n", "# A\n\nx\n"), "level 2 vs level 1");
  assert.ok(contains("X\n===\n", "# X\n"), "setext vs atx, level 1");
  assert.ok(contains("X\n---\n", "# X\n"), "setext h2 vs atx h1");
});

test("normalises away list and emphasis spelling", () => {
  assert.ok(contains("- x\n", "* x\n"), "bullet glyphs");
  assert.ok(contains("3. x\n4. y\n", "1. x\n2. y\n"), "ordered numbering");
  assert.ok(contains("*x*\n", "_x_\n"), "emphasis marker");
  assert.ok(contains("***\n", "---\n"), "thematic break spelling");
});

test("normalises away table padding and alignment", () => {
  assert.ok(
    contains("| a | b |\n|---|---|\n| 1 | 2 |\n", "|a|b|\n|:--|--:|\n|1|2|\n"),
    "padded vs unpadded, alignment row",
  );
});

// --- Significant: a difference here fails -----------------------------------

test("keeps every word, digit and punctuation mark significant", () => {
  assert.ok(!contains("the value is 5\n", "the value is 6\n"), "digit");
  assert.ok(!contains("no, X\n", "no X\n"), "punctuation");
  assert.ok(!contains("alpha bravo\n", "alpha charlie\n"), "word");
});

test("keeps block kind and order significant", () => {
  assert.ok(!contains("x\n", "> x\n"), "paragraph vs blockquote");
  assert.ok(!contains("x\n", "## x\n"), "paragraph vs heading");
  assert.ok(!contains("A\n\nB\n", "A\nB\n"), "two paragraphs vs one");
  assert.ok(!contains("A\n\nB\n", "B\n\nA\n"), "blocks out of order");
  assert.ok(!contains("x\n", "| x |\n|---|\n"), "paragraph vs table");
});

test("keeps list shape significant", () => {
  assert.ok(!contains("- x\n", "1. x\n"), "bullet vs ordered");
  assert.ok(
    !contains("- x\n- y\n", "- x\n  - y\n"),
    "a flat list vs a nested one",
  );
});

test("keeps inline emphasis and code significant", () => {
  assert.ok(!contains("**x**\n", "*x*\n"), "strong vs emphasis");
  assert.ok(!contains("`foo`\n", "foo\n"), "inline code vs prose");
  assert.ok(!contains("`foo`\n", "`bar`\n"), "inline code content");
});

test("keeps fenced code content and language significant", () => {
  assert.ok(
    !contains("```js\nlet x = 1;\n```\n", "```python\nlet x = 1;\n```\n"),
    "fence language",
  );
  assert.ok(
    !contains("```\nfoo\n```\n", "```\n  foo\n```\n"),
    "reindented fence content",
  );
});

test("keeps links, images and raw HTML significant", () => {
  assert.ok(!contains("[foo](dest.md)\n", "[bar](dest.md)\n"), "link label");
  assert.ok(
    !contains("![alt](img.png)\n", "[alt](img.png)\n"),
    "image vs link",
  );
  assert.ok(
    !contains("![alt](img.png)\n", "![other](img.png)\n"),
    "image alt text",
  );
  assert.ok(
    !contains("[x](https://a.example)\n", "[x](https://b.example)\n"),
    "external destination",
  );
  assert.ok(!contains("<div>a</div>\n", "<div>b</div>\n"), "raw HTML markup");
});

// --- Sequence semantics -----------------------------------------------------

test("a block sequence matches only as one unbroken run", () => {
  assert.ok(
    contains("A\n\nB\n", "Z\n\nA\n\nB\n\nY\n"),
    "contiguous sub-sequence",
  );
  assert.ok(!contains("A\n\nB\n", "A\n\nZ\n\nB\n"), "interrupted by another");
});

test("a block is not satisfied by a nested copy", () => {
  assert.ok(
    !contains("X\n", "> X\n"),
    "a paragraph inside a blockquote is a different block",
  );
});

test("the refusal names the first unmatched block", () => {
  const first = unmatched("A\n\nB\n", "B\n");
  assert.ok(first !== null);
  assert.equal(first.opening, "A");

  const second = unmatched("A\n\nchanged\n", "Z\n\nA\n\nchanged!\n");
  assert.ok(second !== null);
  assert.equal(second.opening, "changed");
});

test("an empty body absorbs nothing", () => {
  assert.ok(contains("", "anything\n"), "no blocks to find");
  assert.deepEqual(bodyBlocks("\n\n"), []);
});
