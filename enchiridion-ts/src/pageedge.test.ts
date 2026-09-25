/**
 * Unit tests for the edge-value rule: a value is either a whole markdown link
 * or a vault-relative page ref, which is composed here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { edgeLink, isEdgeKey, isListEdgeKey } from "./pageedge.js";

/** A lookup over a fixed ref→title map; only listed refs exist. */
function lookupOf(titles: Record<string, string>) {
  return (ref: string) => ({
    exists: ref in titles,
    title: titles[ref] ?? "",
  });
}

const vault = lookupOf({
  "wiki/concepts/foo.md": "Foo",
  "wiki/entities/bar.md": "Bar",
  "wiki/concepts/no-title.md": "",
  "raw/notes/x y.txt": "",
});

test("edgeLink: composes a vault-relative ref into a titled link", () => {
  assert.equal(
    edgeLink("related", "wiki/concepts/foo.md", "wiki/concepts", vault),
    "[Foo](foo.md)",
  );
});

test("edgeLink: relativises across kind-folders and percent-encodes", () => {
  assert.equal(
    edgeLink("refines", "wiki/entities/bar.md", "wiki/concepts", vault),
    "[Bar](../entities/bar.md)",
  );
  assert.equal(
    edgeLink("source", "raw/notes/x y.txt", "wiki/concepts", vault),
    "[x y.txt](../../raw/notes/x%20y.txt)",
  );
});

test("edgeLink: passes an already-composed link through byte-for-byte", () => {
  const link = "[Foo](../concepts/foo.md#ttl)";
  assert.equal(edgeLink("related", link, "wiki/entities", vault), link);
});

test("edgeLink: refuses a link embedded in prose", () => {
  const prose = "see [Foo](foo.md) here";
  assert.throws(
    () => edgeLink("related", prose, "wiki/concepts", vault),
    (err: Error) =>
      err.message.includes("related") && err.message.includes(prose),
  );
});

test("edgeLink: refuses an image, which is not an edge link", () => {
  assert.throws(() =>
    edgeLink("related", "![Foo](foo.md)", "wiki/concepts", vault),
  );
});

test("edgeLink: raw_source takes the filename as its label", () => {
  assert.equal(
    edgeLink("raw_source", "raw/notes/x y.txt", "wiki/sources", vault),
    "[x y.txt](../../raw/notes/x%20y.txt)",
  );
});

test("edgeLink: falls back to the basename when the target has no title", () => {
  assert.equal(
    edgeLink("related", "wiki/concepts/no-title.md", "wiki/concepts", vault),
    "[no-title.md](no-title.md)",
  );
});

test("edgeLink: refuses a value that is neither link nor resolvable ref", () => {
  for (const bad of [
    "not a ref",
    "https://example.com/x.md",
    "/etc/passwd",
    "../outside.md",
    "",
  ]) {
    assert.throws(
      () => edgeLink("related", bad, "wiki/concepts", vault),
      (err: Error) =>
        err.message.includes("related") && err.message.includes(bad),
      `expected ${JSON.stringify(bad)} to be refused, naming key and value`,
    );
  }
});

test("edgeLink: refuses a ref that does not resolve to a file", () => {
  assert.throws(
    () =>
      edgeLink("related", "wiki/concepts/missing.md", "wiki/concepts", vault),
    (err: Error) =>
      err.message.includes("related") &&
      err.message.includes("wiki/concepts/missing.md"),
  );
});

test("edge key predicates: raw_source is an edge key but not a list", () => {
  assert.equal(isEdgeKey("related"), true);
  assert.equal(isEdgeKey("raw_source"), true);
  assert.equal(isEdgeKey("tags"), false);
  assert.equal(isListEdgeKey("related"), true);
  assert.equal(isListEdgeKey("raw_source"), false);
  assert.equal(isListEdgeKey("tags"), false);
});
