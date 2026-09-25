/**
 * The output contract's own tests: one per dialect, plus the exit convention.
 * They pin the spelling every command inherits.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { emitDocument, emitRows, fail, failureMessage } from "./output.js";

/** Capture what `console.log` would have written to stdout. */
function captureLog(fn: () => void): string {
  let out = "";
  const original = console.log;
  console.log = (...args: unknown[]) => {
    out += args.join(" ") + "\n";
  };
  try {
    fn();
  } finally {
    console.log = original;
  }
  return out;
}

/** The lines a payload occupies on stdout — what a consumer splits on. */
function lines(text: string): string[] {
  return text.split("\n").slice(0, -1);
}

// ---------------------------------------------------------------------------
// Rows: JSON Lines
// ---------------------------------------------------------------------------

test("emitRows: one compact JSON object per line, in order", () => {
  const out = captureLog(() =>
    emitRows([
      { page_ref: "wiki/a.md", score: 1 },
      { page_ref: "wiki/b.md", score: 2 },
    ]),
  );
  assert.deepEqual(lines(out), [
    '{"page_ref":"wiki/a.md","score":1}',
    '{"page_ref":"wiki/b.md","score":2}',
  ]);
  // Key order is the caller's — emitRows only stringifies.
  assert.equal(
    out,
    '{"page_ref":"wiki/a.md","score":1}\n{"page_ref":"wiki/b.md","score":2}\n',
  );
});

test("emitRows: nothing to report is silence, not an empty array", () => {
  assert.equal(
    captureLog(() => emitRows([])),
    "",
  );
});

test("emitRows: every line parses on its own", () => {
  const out = captureLog(() => emitRows([{ a: [1, 2] }, { a: { b: "c" } }]));
  const parsed = lines(out).map((l) => JSON.parse(l));
  assert.deepEqual(parsed, [{ a: [1, 2] }, { a: { b: "c" } }]);
});

test("emitRows: a row carrying text that needs escaping stays on one line", () => {
  const out = captureLog(() => emitRows([{ detail: 'a "quoted"\nthing' }]));
  assert.equal(lines(out).length, 1);
  assert.equal(JSON.parse(lines(out)[0]).detail, 'a "quoted"\nthing');
});

// ---------------------------------------------------------------------------
// One document
// ---------------------------------------------------------------------------

test("emitDocument: one compact line, never indented", () => {
  const out = captureLog(() =>
    emitDocument({ page_ref: "wiki/a.md", body: "x" }),
  );
  assert.equal(out, '{"page_ref":"wiki/a.md","body":"x"}\n');
});

test("emitDocument: the value may itself be an array — the dialect is how many documents", () => {
  const out = captureLog(() =>
    emitDocument([
      { kind: "concept", folder: "concepts" },
      { kind: "entity", folder: "entities" },
    ]),
  );
  assert.equal(
    out,
    '[{"kind":"concept","folder":"concepts"},{"kind":"entity","folder":"entities"}]\n',
  );
});

test("emitDocument: nested structures stay on the one line", () => {
  const out = captureLog(() =>
    emitDocument({
      frontmatter: { tags: ["db", "sql"] },
      body: "\nbody text\n",
    }),
  );
  assert.equal(
    out,
    '{"frontmatter":{"tags":["db","sql"]},"body":"\\nbody text\\n"}\n',
  );
});

test("the two dialects disagree about document count, which is the whole point", () => {
  const rows = captureLog(() => emitRows([{ a: 1 }, { a: 2 }]));
  const doc = captureLog(() => emitDocument([{ a: 1 }, { a: 2 }]));
  assert.equal(lines(rows).length, 2);
  assert.equal(lines(doc).length, 1);
});

// ---------------------------------------------------------------------------
// The exit convention
// ---------------------------------------------------------------------------

test("fail: throws the message, so the run cannot continue past it", () => {
  assert.throws(() => fail('enchiridion check: unknown check "nope"'), {
    name: "Error",
    message: 'enchiridion check: unknown check "nope"',
  });
});

test("failureMessage: the message, newline-terminated exactly once", () => {
  assert.equal(failureMessage(new Error("boom")), "boom\n");
  assert.equal(failureMessage(new Error("boom\n")), "boom\n");
});

test("failureMessage: a non-Error throw renders as its string, not as [object Object]", () => {
  assert.equal(failureMessage("plain"), "plain\n");
});
