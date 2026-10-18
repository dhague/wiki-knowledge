/**
 * The link seam's code-fence line map. [codeLineRanges] returns indices relative
 * to the string it is handed: [iterLinks] hands it the whole document, while
 * `check split-links` hands it the body and rebases the line it reports.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { codeLineRanges } from "./wikipage.js";

/** A fence occupying lines 2–5 of the string. */
const fenced = "intro\n\n```\na\nb\n```\noutro\n";

function sorted(src: string): number[] {
  return [...codeLineRanges(src)].sort((a, b) => a - b);
}

test("codeLineRanges counts from the start of the string it is handed", () => {
  assert.deepEqual(sorted(fenced), [2, 3, 4, 5]);
});

test("codeLineRanges is input-relative: a prefix shifts every index", () => {
  // The contract the two call sites rebase against: the same fence hands back
  // the same indices plus the three lines the prefix occupies.
  assert.deepEqual(sorted("---\ntitle: T\n---\n" + fenced), [5, 6, 7, 8]);
});
