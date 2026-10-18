/**
 * The output contract's own tests: one per dialect, plus the exit convention.
 * They pin the spelling every command inherits.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BadInvocationError,
  emitDiagnostic,
  emitDocument,
  emitRaw,
  emitRows,
  emitSkippedPages,
  emitText,
  exitCodeFor,
  fail,
  failBadInvocation,
  failureMessage,
  setOutputSink,
} from "./output.js";

interface Captured {
  out: string;
  err: string;
}

/** Capture both streams through the sink the emitters write to. */
function capture(fn: () => void): Captured {
  const captured: Captured = { out: "", err: "" };
  setOutputSink({
    out: (chunk) => (captured.out += chunk),
    err: (chunk) => (captured.err += chunk),
  });
  try {
    fn();
  } finally {
    setOutputSink(null);
  }
  return captured;
}

/** Capture what the emitters would have written to stdout. */
function captureStdout(fn: () => void): string {
  return capture(fn).out;
}

/** The lines a payload occupies on stdout — what a consumer splits on. */
function lines(text: string): string[] {
  return text.split("\n").slice(0, -1);
}

// ---------------------------------------------------------------------------
// Rows: JSON Lines
// ---------------------------------------------------------------------------

test("emitRows: one compact JSON object per line, in order", () => {
  const out = captureStdout(() =>
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
    captureStdout(() => emitRows([])),
    "",
  );
});

test("emitRows: every line parses on its own", () => {
  const out = captureStdout(() => emitRows([{ a: [1, 2] }, { a: { b: "c" } }]));
  const parsed = lines(out).map((l) => JSON.parse(l));
  assert.deepEqual(parsed, [{ a: [1, 2] }, { a: { b: "c" } }]);
});

test("emitRows: a row carrying text that needs escaping stays on one line", () => {
  const out = captureStdout(() => emitRows([{ detail: 'a "quoted"\nthing' }]));
  assert.equal(lines(out).length, 1);
  assert.equal(JSON.parse(lines(out)[0]).detail, 'a "quoted"\nthing');
});

// ---------------------------------------------------------------------------
// One document
// ---------------------------------------------------------------------------

test("emitDocument: one compact line, never indented", () => {
  const out = captureStdout(() =>
    emitDocument({ page_ref: "wiki/a.md", body: "x" }),
  );
  assert.equal(out, '{"page_ref":"wiki/a.md","body":"x"}\n');
});

test("emitDocument: the value may itself be an array — the dialect is how many documents", () => {
  const out = captureStdout(() =>
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
  const out = captureStdout(() =>
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
  const rows = captureStdout(() => emitRows([{ a: 1 }, { a: 2 }]));
  const doc = captureStdout(() => emitDocument([{ a: 1 }, { a: 2 }]));
  assert.equal(lines(rows).length, 2);
  assert.equal(lines(doc).length, 1);
});

// ---------------------------------------------------------------------------
// The other transports
// ---------------------------------------------------------------------------

test("emitText: one human-readable line, newline-terminated exactly once", () => {
  assert.equal(
    captureStdout(() => emitText("wiki/concepts/a.md")),
    "wiki/concepts/a.md\n",
  );
});

test("emitRaw: the chunk byte-for-byte, adding no newline", () => {
  assert.equal(
    captureStdout(() => emitRaw("---\ntitle: A\n---\n\nbody\n")),
    "---\ntitle: A\n---\n\nbody\n",
  );
});

test("emitRaw: a chunk with no trailing newline stays unterminated", () => {
  assert.equal(
    captureStdout(() => emitRaw("no newline")),
    "no newline",
  );
});

test("emitDiagnostic: one newline-terminated line on stderr, never stdout", () => {
  const { out, err } = capture(() => emitDiagnostic("Warning: dropped"));
  assert.equal(out, "");
  assert.equal(err, "Warning: dropped\n");
});

test("emitSkippedPages: one `skipped <page_ref>: <reason>` line per page, on stderr", () => {
  const { out, err } = capture(() =>
    emitSkippedPages([
      { pageRef: "wiki/concepts/a.md", reason: "no frontmatter" },
      { pageRef: "wiki/concepts/b.md", reason: "unparsable YAML" },
    ]),
  );
  assert.equal(out, "");
  assert.equal(
    err,
    "skipped wiki/concepts/a.md: no frontmatter\n" +
      "skipped wiki/concepts/b.md: unparsable YAML\n",
  );
});

test("the default sink resolves each process stream per write, never at import", () => {
  // run() captures output by swapping the stream properties; a write function
  // captured at module load would keep going to the real stream.
  let out = "";
  let err = "";
  const realOut = process.stdout.write;
  const realErr = process.stderr.write;
  process.stdout.write = ((chunk: unknown) => {
    out += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown) => {
    err += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    emitText("live");
    emitDiagnostic("diagnosed");
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
  }
  assert.equal(out, "live\n");
  assert.equal(err, "diagnosed\n");
});

test("installing a sink leaves the process streams alone", () => {
  const realOut = process.stdout.write;
  const realErr = process.stderr.write;
  capture(() => {});
  assert.equal(process.stdout.write, realOut);
  assert.equal(process.stderr.write, realErr);
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

test("failBadInvocation: throws the class that exits 2, message unchanged", () => {
  assert.throws(() => failBadInvocation('unknown kind "nonsense"'), {
    name: "BadInvocationError",
    message: 'unknown kind "nonsense"',
  });
});

test("exitCodeFor: 2 for a bad invocation, 1 for every other throw", () => {
  assert.equal(exitCodeFor(new BadInvocationError("x")), 2);
  assert.equal(exitCodeFor(new Error("x")), 1);
  assert.equal(exitCodeFor("plain"), 1);
});

test("failureMessage: the message, newline-terminated exactly once", () => {
  assert.equal(failureMessage(new Error("boom")), "boom\n");
  assert.equal(failureMessage(new Error("boom\n")), "boom\n");
});

test("failureMessage: a non-Error throw renders as its string, not as [object Object]", () => {
  assert.equal(failureMessage("plain"), "plain\n");
});
