/** Tests for the semantic fingerprint a Consolidation exclusion caches. */

import { test } from "node:test";
import assert from "node:assert/strict";
import { fingerprintInput, semanticFingerprint } from "./fingerprint.js";
import { newPageRecord } from "./pagerecord.js";

function page(text: string): string {
  return text;
}

const BASE = page(
  "---\n" +
    "title: Authentication\n" +
    "summary: Establishing who a caller is.\n" +
    "tags:\n" +
    "  - security\n" +
    "source_date: 2026-01-01\n" +
    "volatility: stable\n" +
    "related:\n" +
    '  - "[Authorization](authorization.md)"\n' +
    '  - "[Sessions](sessions.md)"\n' +
    "---\n" +
    "Authentication establishes identity.\n",
);

function fingerprintOf(text: string): string {
  const record = newPageRecord("wiki/concepts/authentication.md", text);
  return semanticFingerprint(record, text.slice(text.indexOf("\n---", 3) + 4));
}

test("a fingerprint is a sha256 digest and is deterministic", () => {
  const first = fingerprintOf(BASE);
  assert.match(first, /^sha256:[0-9a-f]{64}$/);
  assert.equal(first, fingerprintOf(BASE));
});

test("tags, source_date and volatility are outside the fingerprint", () => {
  const changed = BASE.replace("  - security\n", "  - security\n  - identity\n")
    .replace("source_date: 2026-01-01", "source_date: 2030-12-31")
    .replace("volatility: stable", "volatility: evolving");
  assert.notEqual(changed, BASE);
  assert.equal(fingerprintOf(changed), fingerprintOf(BASE));
});

test("field order and YAML formatting are outside the fingerprint", () => {
  const reordered = page(
    "---\n" +
      "volatility: stable\n" +
      "related: ['[Sessions](sessions.md)', '[Authorization](authorization.md)']\n" +
      "summary: 'Establishing who a caller is.'\n" +
      "title: Authentication\n" +
      "source_date: 2026-01-01\n" +
      "tags: [security]\n" +
      "---\n" +
      "Authentication establishes identity.\n",
  );
  assert.notEqual(reordered, BASE);
  assert.equal(fingerprintOf(reordered), fingerprintOf(BASE));
});

test("line endings are normalised, so a CRLF checkout keeps the fingerprint", () => {
  const crlf = BASE.replace(/\n/g, "\r\n");
  const record = newPageRecord("wiki/concepts/authentication.md", crlf);
  const body = crlf.slice(crlf.indexOf("\r\n---", 3) + 6);
  assert.equal(semanticFingerprint(record, body), fingerprintOf(BASE));
});

test("an unrelated frontmatter key is outside the fingerprint", () => {
  const extra = BASE.replace(
    "volatility: stable",
    "volatility: stable\nowner: team-x",
  );
  assert.equal(fingerprintOf(extra), fingerprintOf(BASE));
});

test("title, summary, body and edge targets each change the fingerprint", () => {
  const base = fingerprintOf(BASE);
  assert.notEqual(
    fingerprintOf(BASE.replace("title: Authentication", "title: Auth")),
    base,
  );
  assert.notEqual(
    fingerprintOf(
      BASE.replace("Establishing who a caller is.", "Who you are."),
    ),
    base,
  );
  assert.notEqual(
    fingerprintOf(
      BASE.replace(
        "Authentication establishes identity.",
        "Authentication establishes who a caller is.",
      ),
    ),
    base,
  );
  assert.notEqual(
    fingerprintOf(
      BASE.replace("[Sessions](sessions.md)", "[Tokens](tokens.md)"),
    ),
    base,
  );
});

test("fingerprintInput sorts keys and targets so list order cannot matter", () => {
  const record = newPageRecord(
    "wiki/concepts/a.md",
    '---\ntitle: A\nrelated:\n  - "[B](b.md)"\ncontradicts:\n  - "[C](c.md)"\n---\nbody\n',
  );
  const other = newPageRecord(
    "wiki/concepts/a.md",
    '---\ntitle: A\ncontradicts:\n  - "[C](c.md)"\nrelated:\n  - "[B](b.md)"\n---\nbody\n',
  );
  assert.equal(
    fingerprintInput(record, "body\n"),
    fingerprintInput(other, "body\n"),
  );
});
