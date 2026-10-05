/** Tests for the Consolidation-exclusion registry: parse/render, the two-tier
 * validation, suppression, and the mechanically repairable half. */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalExclusions,
  folderOf,
  memberSetKey,
  moveInRegistry,
  parseRegistry,
  refreshExclusions,
  registryRef,
  renderRegistry,
  resolveExclusion,
  suppressedBy,
  upsertExclusion,
} from "./consolidationexclusions.js";
import type { Exclusion } from "./consolidationexclusions.js";
import type { PageFact } from "./searchindex.js";

function member(pageRef: string, blobOid = "oid-1", fingerprint = "sha256:1") {
  return { pageRef, blobOid, fingerprint };
}

function fact(pageRef: string, over: Partial<PageFact> = {}): PageFact {
  return { pageRef, blobOid: "oid-1", fingerprint: "sha256:1", ...over };
}

function factsOf(...entries: PageFact[]): Map<string, PageFact> {
  return new Map(entries.map((f) => [f.pageRef, f]));
}

const A = "wiki/concepts/authentication.md";
const B = "wiki/concepts/authorization.md";
const C = "wiki/concepts/sessions.md";

// ---------------------------------------------------------------------------
// Parse and render
// ---------------------------------------------------------------------------

test("render → parse round-trips a record and its members", () => {
  const exclusions: Exclusion[] = [
    {
      members: [member(A, "a1", "sha256:aa"), member(B, "b1", "sha256:bb")],
      reason: "Distinct concepts: authentication establishes identity.",
    },
  ];
  const text = renderRegistry(exclusions);
  const parsed = parseRegistry(text);
  assert.equal(parsed.error, null);
  assert.deepEqual(parsed.exclusions, exclusions);
});

test("render emits the documented canonical shape", () => {
  const text = renderRegistry([
    {
      members: [member(A, "a1", "sha256:aa"), member(B, "b1", "sha256:bb")],
      reason: "why",
    },
  ]);
  assert.equal(
    text,
    "exclusions:\n" +
      "  - members:\n" +
      `      - page_ref: ${A}\n` +
      "        blob_oid: a1\n" +
      "        fingerprint: sha256:aa\n" +
      `      - page_ref: ${B}\n` +
      "        blob_oid: b1\n" +
      "        fingerprint: sha256:bb\n" +
      '    reason: "why"\n',
  );
});

test("an empty registry renders and parses as no records", () => {
  assert.equal(renderRegistry([]), "exclusions: []\n");
  assert.deepEqual(parseRegistry(renderRegistry([])), {
    exclusions: [],
    error: null,
  });
  assert.deepEqual(parseRegistry(""), { exclusions: [], error: null });
  assert.deepEqual(parseRegistry("# just a comment\n"), {
    exclusions: [],
    error: null,
  });
});

test("canonical order sorts members by ref and records by member set", () => {
  const canonical = canonicalExclusions([
    { members: [member(C), member(A)], reason: "second" },
    { members: [member(A), member(B)], reason: "first" },
  ]);
  assert.deepEqual(
    canonical.map((e) => e.members.map((m) => m.pageRef)),
    [
      [A, B],
      [A, C],
    ],
  );
});

test("a malformed registry yields no records and an error", () => {
  const cases: Array<[string, string]> = [
    ["not: [a, mapping", "not parseable as YAML"],
    ["- a\n- b\n", "not a mapping"],
    ["exclusions: nope\n", "`exclusions` is not a list"],
    ["exclusions:\n  - nope\n", "exclusions[0] is not a mapping"],
    ["exclusions:\n  - members: []\n    reason: x\n", "non-empty list"],
    [
      "exclusions:\n  - members:\n      - page_ref: a.md\n        blob_oid: o\n    reason: x\n",
      "fingerprint must be a non-empty string",
    ],
    [
      "exclusions:\n  - members:\n      - page_ref: a.md\n        blob_oid: o1\n        fingerprint: f1\n      - page_ref: a.md\n        blob_oid: o2\n        fingerprint: f2\n    reason: x\n",
      "appears twice",
    ],
  ];
  for (const [text, needle] of cases) {
    const parsed = parseRegistry(text);
    assert.deepEqual(parsed.exclusions, [], text);
    assert.ok(parsed.error?.includes(needle), `${text} → ${parsed.error}`);
  }
});

// ---------------------------------------------------------------------------
// Two-tier validation
// ---------------------------------------------------------------------------

test("a matching blob oid is the fast path — valid with no refresh", () => {
  const record: Exclusion = {
    members: [member(A, "a1", "sha256:aa")],
    reason: "r",
  };
  const resolved = resolveExclusion(
    record,
    factsOf(fact(A, { blobOid: "a1", fingerprint: "sha256:aa" })),
  );
  assert.equal(resolved.verdicts[0].valid, true);
  assert.equal(resolved.verdicts[0].needsOidRefresh, false);
  assert.deepEqual(resolved.validMembers, record.members);
});

test("a matching fingerprint is the fallback — valid and refreshing the oid", () => {
  const record: Exclusion = {
    members: [member(A, "stale", "sha256:aa")],
    reason: "r",
  };
  const resolved = resolveExclusion(
    record,
    factsOf(fact(A, { blobOid: "fresh", fingerprint: "sha256:aa" })),
  );
  assert.equal(resolved.verdicts[0].valid, true);
  assert.equal(resolved.verdicts[0].needsOidRefresh, true);
});

test("a semantically changed member drops out of the effective exclusion", () => {
  const record: Exclusion = {
    members: [member(A, "a1", "sha256:aa"), member(B, "b1", "sha256:bb")],
    reason: "r",
  };
  const resolved = resolveExclusion(
    record,
    factsOf(
      fact(A, { blobOid: "a1", fingerprint: "sha256:aa" }),
      fact(B, { blobOid: "b2", fingerprint: "sha256:differed" }),
    ),
  );
  assert.deepEqual(
    resolved.validMembers.map((m) => m.pageRef),
    [A],
  );
  assert.deepEqual(
    resolved.staleMembers.map((m) => m.pageRef),
    [B],
  );
  assert.deepEqual(resolved.missingMembers, []);
});

test("a member absent from HEAD is missing, not stale", () => {
  const record: Exclusion = { members: [member(A), member(B)], reason: "r" };
  const resolved = resolveExclusion(record, factsOf(fact(A)));
  assert.deepEqual(
    resolved.missingMembers.map((m) => m.pageRef),
    [B],
  );
  assert.deepEqual(resolved.staleMembers, []);
});

// ---------------------------------------------------------------------------
// Suppression
// ---------------------------------------------------------------------------

test("suppression needs an exact effective-set match of at least two members", () => {
  const record: Exclusion = {
    members: [member(A, "a1", "sha256:aa"), member(B, "b1", "sha256:bb")],
    reason: "r",
  };
  const resolved = resolveExclusion(
    record,
    factsOf(
      fact(A, { blobOid: "a1", fingerprint: "sha256:aa" }),
      fact(B, { blobOid: "b1", fingerprint: "sha256:bb" }),
    ),
  );
  assert.ok(suppressedBy([A, B], [resolved]));
  assert.ok(suppressedBy([B, A], [resolved]), "member order is not identity");
  assert.equal(suppressedBy([A], [resolved]), null);
  assert.equal(
    suppressedBy([A, B, C], [resolved]),
    null,
    "a superset is assessed afresh",
  );
  assert.equal(
    suppressedBy([A, C], [resolved]),
    null,
    "a different subset is assessed afresh",
  );
});

test("a record left with one valid member suppresses nothing", () => {
  const record: Exclusion = {
    members: [member(A, "a1", "sha256:aa"), member(B)],
    reason: "r",
  };
  const resolved = resolveExclusion(
    record,
    factsOf(fact(A, { blobOid: "a1", fingerprint: "sha256:aa" })),
  );
  assert.equal(suppressedBy([A], [resolved]), null);
});

test("overlapping records stay independent and match on their own member set", () => {
  const ab: Exclusion = { members: [member(A), member(B)], reason: "ab" };
  const ac: Exclusion = { members: [member(A), member(C)], reason: "ac" };
  const facts = factsOf(fact(A), fact(B), fact(C));
  const resolved = [ab, ac].map((e) => resolveExclusion(e, facts));
  assert.equal(suppressedBy([A, B], resolved)?.exclusion.reason, "ab");
  assert.equal(suppressedBy([A, C], resolved)?.exclusion.reason, "ac");
});

// ---------------------------------------------------------------------------
// Mechanical repair
// ---------------------------------------------------------------------------

test("refresh rewrites a stale cached oid whose fingerprint still matches", () => {
  const record: Exclusion = {
    members: [member(A, "stale", "sha256:aa")],
    reason: "r",
  };
  const next = refreshExclusions(
    [record],
    factsOf(fact(A, { blobOid: "fresh", fingerprint: "sha256:aa" })),
  );
  assert.equal(next[0].members[0].blobOid, "fresh");
  assert.equal(next[0].members[0].fingerprint, "sha256:aa");
});

test("without --prune a stale member keeps its stale cache", () => {
  const record: Exclusion = {
    members: [member(A, "a1", "sha256:aa"), member(B, "b1", "old")],
    reason: "r",
  };
  const next = refreshExclusions(
    [record],
    factsOf(
      fact(A, { blobOid: "a1", fingerprint: "sha256:aa" }),
      fact(B, { blobOid: "b2", fingerprint: "new" }),
    ),
  );
  assert.deepEqual(
    next[0].members.map((m) => m.blobOid),
    ["a1", "b1"],
    "a stale member keeps its old blobs, so it stays invalid",
  );
});

test("--prune drops stale and missing members and deletes a record left with fewer than two", () => {
  const C = "wiki/concepts/sessions.md";
  const D = "wiki/concepts/tokens.md";
  const survives: Exclusion = {
    members: [
      member(A, "a1", "sha256:aa"),
      member(B, "b1", "sha256:bb"),
      member(C, "c1", "old"),
    ],
    reason: "survives",
  };
  const dies: Exclusion = {
    members: [member(A, "a1", "sha256:aa"), member(C, "c1", "old")],
    reason: "dies",
  };
  const gone: Exclusion = { members: [member(C), member(D)], reason: "gone" };
  const facts = factsOf(
    fact(A, { blobOid: "a1", fingerprint: "sha256:aa" }),
    fact(B, { blobOid: "b1", fingerprint: "sha256:bb" }),
    fact(C, { blobOid: "c2", fingerprint: "changed" }),
  );
  assert.deepEqual(
    refreshExclusions([survives, dies, gone], facts, { prune: true }),
    [
      {
        members: [
          { pageRef: A, blobOid: "a1", fingerprint: "sha256:aa" },
          { pageRef: B, blobOid: "b1", fingerprint: "sha256:bb" },
        ],
        reason: "survives",
      },
    ],
  );
});

test("--prune deletes a record when no member survives", () => {
  const record: Exclusion = {
    members: [member(A, "gone"), member(B, "gone")],
    reason: "r",
  };
  assert.deepEqual(refreshExclusions([record], new Map(), { prune: true }), []);
});

test("safe duplicates collapse and their differing-reason twin survives", () => {
  const first: Exclusion = { members: [member(A), member(B)], reason: "same" };
  const duplicate: Exclusion = {
    members: [member(B), member(A)],
    reason: "same",
  };
  const different: Exclusion = {
    members: [member(A), member(B)],
    reason: "other",
  };
  const facts = factsOf(fact(A), fact(B));
  const next = refreshExclusions([first, duplicate, different], facts);
  assert.deepEqual(
    next.map((e) => e.reason),
    ["other", "same"],
  );
});

test("upsert replaces an exact member-set match and keeps overlapping records", () => {
  const existing: Exclusion[] = [
    { members: [member(A), member(B)], reason: "old" },
    { members: [member(A), member(C)], reason: "keep" },
  ];
  const next = upsertExclusion(existing, {
    members: [member(B, "b9", "sha256:bb"), member(A, "a9", "sha256:aa")],
    reason: "new",
  });
  assert.equal(next.length, 2);
  const replaced = next.find(
    (e) => memberSetKey(e.members) === memberSetKey([member(A), member(B)]),
  );
  assert.equal(replaced?.reason, "new");
  assert.equal(replaced?.members[0].pageRef, A);
});

// ---------------------------------------------------------------------------
// Moves
// ---------------------------------------------------------------------------

test("a move within a kind follows the page's reference", () => {
  const text = renderRegistry([
    {
      members: [member(A, "a1", "sha256:aa"), member(B, "b1", "sha256:bb")],
      reason: "r",
    },
  ]);
  const moved = "wiki/concepts/authn.md";
  const next = moveInRegistry(text, A, moved, true);
  assert.ok(next);
  const parsed = parseRegistry(next);
  assert.deepEqual(
    parsed.exclusions[0].members.map((m) => m.pageRef),
    [moved, B],
  );
  assert.equal(
    parsed.exclusions[0].members[0].blobOid,
    "a1",
    "the cache is untouched",
  );
});

test("a move refreshes a member's fingerprint when the mover rewrote its links", () => {
  const text = renderRegistry([
    {
      members: [member(A, "a1", "sha256:before"), member(B, "b1", "sha256:bb")],
      reason: "r",
    },
  ]);
  const next = moveInRegistry(text, B, "wiki/concepts/b-new.md", true, (ref) =>
    ref === A ? "sha256:after" : null,
  );
  assert.ok(next);
  const moved = parseRegistry(next).exclusions[0];
  const a = moved.members.find((m) => m.pageRef === A)!;
  assert.equal(a.fingerprint, "sha256:after");
  assert.equal(a.blobOid, "a1", "the cached oid stays for the fix to refresh");
});

test("a move to another kind leaves the record, deleting it under the fewer-than-two rule", () => {
  const text = renderRegistry([
    {
      members: [member(A, "a1", "sha256:aa"), member(B, "b1", "sha256:bb")],
      reason: "r",
    },
    {
      members: [member(A, "a1", "sha256:aa"), member(B), member(C)],
      reason: "s",
    },
  ]);
  const next = moveInRegistry(text, A, "wiki/entities/auth.md", false);
  assert.ok(next);
  const parsed = parseRegistry(next);
  assert.deepEqual(
    parsed.exclusions.map((e) => e.members.map((m) => m.pageRef)),
    [[B, C]],
  );
});

test("a move that leaves the same reference, and one that touches no record, rewrite nothing", () => {
  const text = renderRegistry([
    { members: [member(A), member(B)], reason: "r" },
  ]);
  assert.equal(moveInRegistry(text, A, A, true), null);
});

test("a move that touches no record, or a malformed registry, changes nothing", () => {
  const text = renderRegistry([
    { members: [member(A), member(B)], reason: "r" },
  ]);
  assert.equal(moveInRegistry(text, C, "wiki/concepts/other.md", true), null);
  assert.equal(
    moveInRegistry("not: [a mapping", C, "wiki/concepts/other.md", true),
    null,
  );
});

test("registry refs and folders compose the documented paths", () => {
  assert.equal(
    registryRef("concepts"),
    "wiki/concepts/CONSOLIDATION_EXCLUSIONS.yaml",
  );
  assert.equal(folderOf(A), "concepts");
});
