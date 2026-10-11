/** chainofevidence tests — the page -> stub -> raw chain rule. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { Page } from "./wikipage.js";
import { check } from "./chainofevidence.js";

function page(frontmatter: string): Page {
  return new Page(`---\n${frontmatter}---\nbody\n`);
}

const rawRef = "raw/doc.md";

test("chain holds with a stub and a back edge", () => {
  const staged: Record<string, Page> = {
    "wiki/sources/doc.md": page('raw_source: "[doc.md](../../raw/doc.md)"\n'),
    "wiki/concepts/a.md": page('source:\n  - "[doc.md](../sources/doc.md)"\n'),
  };
  const errs = check(staged, rawRef);
  assert.deepEqual(errs, []);
});

test("missing stub is reported, with the whole contract", () => {
  const staged: Record<string, Page> = {
    "wiki/concepts/a.md": page("title: A\n"),
  };
  const errs = check(staged, rawRef);
  assert.equal(errs.length, 1);
  assert.equal(
    errs[0],
    'raw/doc.md needs a wiki/sources/ stub among this plan\'s own pages whose raw_source points at it (op:"create", kind:"source", even a thin one), and every other page in the plan — updates included — needs a source edge to that stub',
  );
});

test("the missing-stub message names an on-disk stand-in when the vault has one", () => {
  const staged: Record<string, Page> = {
    "wiki/concepts/a.md": page("title: A\n"),
  };
  const errs = check(staged, rawRef, () => "wiki/sources/on-disk.md");
  assert.equal(errs.length, 1);
  assert.match(
    errs[0],
    /wiki\/sources\/on-disk\.md on disk already stands in for it, but the stub must be one of this plan's pages/,
  );
});

test("the missing-stub message claims no stand-in when the vault has none", () => {
  const staged: Record<string, Page> = {
    "wiki/concepts/a.md": page("title: A\n"),
  };
  const errs = check(staged, rawRef, () => "");
  assert.equal(errs.length, 1);
  assert.ok(!errs[0].includes("on disk already stands in"), errs[0]);
});

test("the stand-in is not looked up when the plan carries its own stub", () => {
  const staged: Record<string, Page> = {
    "wiki/sources/doc.md": page('raw_source: "[doc.md](../../raw/doc.md)"\n'),
  };
  let asked = false;
  const errs = check(staged, rawRef, () => {
    asked = true;
    return "";
  });
  assert.deepEqual(errs, []);
  assert.equal(asked, false);
});

test("the stub's position in the plan changes nothing", () => {
  const stub = page('raw_source: "[doc.md](../../raw/doc.md)"\n');
  const first: Record<string, Page> = {
    "wiki/sources/doc.md": stub,
    "wiki/concepts/a.md": page('source:\n  - "[doc.md](../sources/doc.md)"\n'),
  };
  const last: Record<string, Page> = {
    "wiki/concepts/a.md": page('source:\n  - "[doc.md](../sources/doc.md)"\n'),
    "wiki/sources/doc.md": stub,
  };
  assert.deepEqual(check(first, rawRef), []);
  assert.deepEqual(check(last, rawRef), []);
  assert.equal(
    last["wiki/sources/doc.md"].text,
    first["wiki/sources/doc.md"].text,
  );
});

test("every page missing the source edge is reported in one pass", () => {
  const staged: Record<string, Page> = {
    "wiki/sources/doc.md": page('raw_source: "[doc.md](../../raw/doc.md)"\n'),
    "wiki/concepts/a.md": page('source:\n  - "[doc.md](../sources/doc.md)"\n'),
    "wiki/entities/b.md": page("title: B\n"),
    "wiki/entities/c.md": page("title: C\n"),
  };
  const errs = check(staged, rawRef);
  assert.deepEqual(errs, [
    "wiki/entities/b.md needs a source edge to the stub wiki/sources/doc.md",
    "wiki/entities/c.md needs a source edge to the stub wiki/sources/doc.md",
  ]);
});

test("a sources/ page pointing elsewhere does not count as the stub", () => {
  const staged: Record<string, Page> = {
    "wiki/sources/other.md": page(
      'raw_source: "[other.md](../../raw/other.md)"\n',
    ),
  };
  const errs = check(staged, rawRef);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /needs a wiki\/sources\/ stub/);
});

test("a page without a source edge is reported", () => {
  const staged: Record<string, Page> = {
    "wiki/sources/doc.md": page('raw_source: "[doc.md](../../raw/doc.md)"\n'),
    "wiki/concepts/a.md": page("title: A\n"),
    "wiki/concepts/b.md": page('source:\n  - "[doc.md](../sources/doc.md)"\n'),
  };
  const errs = check(staged, rawRef);
  assert.equal(errs.length, 1);
  assert.match(errs[0], /wiki\/concepts\/a\.md needs a source edge/);
});

test("raw ref is normalized and destination decoded", () => {
  const staged: Record<string, Page> = {
    "wiki/sources/doc.md": page(
      'raw_source: "[a doc.md](../../raw/notes/../a%20doc.md)"\n',
    ),
  };
  const errs = check(staged, "raw/./a doc.md");
  assert.deepEqual(errs, []);
});

test("errors are deterministically ordered", () => {
  const staged: Record<string, Page> = {
    "wiki/sources/doc.md": page('raw_source: "[doc.md](../../raw/doc.md)"\n'),
    "wiki/concepts/c.md": page("title: C\n"),
    "wiki/concepts/a.md": page("title: A\n"),
    "wiki/concepts/b.md": page("title: B\n"),
  };
  for (let i = 0; i < 5; i++) {
    const errs = check(staged, rawRef);
    const got = errs.join("|");
    assert.ok(got.startsWith("wiki/concepts/a.md"), got);
    assert.ok(got.includes("|wiki/concepts/b.md"), got);
    assert.ok(got.includes("|wiki/concepts/c.md"), got);
  }
});

test("invalid frontmatter is an error", () => {
  const staged: Record<string, Page> = {
    "wiki/sources/doc.md": new Page("---\nraw_source: [unclosed\n---\nbody\n"),
  };
  assert.throws(() => check(staged, rawRef));
});
