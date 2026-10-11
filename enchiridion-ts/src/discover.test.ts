/**
 * discover tests. Integration cases need a committed fixture vault because the
 * index is a view of committed history (ADR-0015); OR-vs-AND is asserted
 * against a fake [Searcher] instead.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  orQuery,
  classify,
  check,
  nominate,
  discover,
  tagsContaining,
  tagCounts,
  HintDuplicate,
  HintRefines,
  HintRelated,
  HintDistinct,
  UnboundedSearchLimit,
  DefaultLimit,
  DefaultMaxCandidates,
  RefScanDefault,
  type Searcher,
  type Candidate,
} from "./discover.js";
import { Index } from "./searchindex.js";
import type { Hit, Query } from "./searchindex.js";
import { OrderedMap, type PagePlan } from "./ingest.js";
import { VaultGit } from "./vaultgit.js";

// ---------------------------------------------------------------------------
// Fixture vault (committed — search is a view of committed history)
// ---------------------------------------------------------------------------

function writeFixturePage(root: string, rel: string, text: string): void {
  const abs = path.join(root, "wiki", rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}

async function newFixtureVault(): Promise<string> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enchiridion-disc-"));
  writeFixturePage(
    root,
    "concepts/connection-pooling.md",
    "---\ntitle: Connection Pooling in Postgres\n" +
      "summary: Reuse connections instead of opening a new one per request.\n" +
      "tags:\n  - database\nvolatility: stable\n---\n\n" +
      "Connection pooling reduces per-request handshake overhead by " +
      "reusing a fixed set of open connections across callers.\n",
  );
  writeFixturePage(
    root,
    "concepts/sourdough-starter.md",
    "---\ntitle: Feeding a Sourdough Starter\n" +
      "summary: Daily flour-and-water feeding keeps a starter active.\n" +
      "tags:\n  - baking\nvolatility: stable\n---\n\n" +
      "A sourdough starter needs equal parts flour and water once a day, " +
      "kept warm, to stay active enough to leaven bread.\n",
  );

  const repo = new VaultGit(root);
  await repo.init();
  await repo.add(["."]);
  await repo.commit("fixtures");
  return root;
}

/** Open the one index handle a test gets, mirroring the command's ownership
 * of it (ADR-0010). */
async function newFixtureSearcher(): Promise<Index> {
  const index = await Index.open(await newFixtureVault());
  return index;
}

function refOf(candidates: Candidate[], ref: string): Candidate | undefined {
  return candidates.find((c) => c.page_ref === ref);
}

/** `check`'s defaults: a zero threshold or cap takes its named default. */
const CheckOpts = {
  limit: 0,
  duplicateThreshold: 0,
  relatedThreshold: 0,
  maxCandidates: 0,
};

// ---------------------------------------------------------------------------
// classify: pure boundary logic
// ---------------------------------------------------------------------------

test("classify maps scores and title sharing to hints", () => {
  const cases: [string, number, boolean, string][] = [
    [
      "high score with shared title token is duplicate",
      20.0,
      true,
      HintDuplicate,
    ],
    [
      "high score without shared title token is refines",
      20.0,
      false,
      HintRefines,
    ],
    ["mid score is related regardless of title", 10.0, true, HintRelated],
    ["mid score related without title", 10.0, false, HintRelated],
    ["low score is distinct", 1.0, true, HintDistinct],
    ["duplicate threshold is inclusive", 15.0, true, HintDuplicate],
    ["related threshold is inclusive", 5.0, false, HintRelated],
  ];
  for (const [name, score, shares, want] of cases) {
    assert.equal(classify(score, shares, 15.0, 5.0), want, name);
  }
});

// ---------------------------------------------------------------------------
// orQuery construction
// ---------------------------------------------------------------------------

test("orQuery builds an OR expression of unique lowercased words", () => {
  const cases: [string[], string][] = [
    [["Connection Pooling"], `"connection" OR "pooling"`],
    [
      ["Connection Pooling", "Connection reuse"],
      `"connection" OR "pooling" OR "reuse"`,
    ],
    [["", ""], ""],
    [["  !!!  "], ""],
  ];
  for (const [texts, want] of cases) {
    assert.equal(orQuery(...texts), want);
  }
});

// ---------------------------------------------------------------------------
// Searcher fake
// ---------------------------------------------------------------------------

/** A fake Searcher that records the last query and returns scripted hits. */
class FakeSearcher implements Searcher {
  lastQuery: Query | null = null;
  hits: Hit[] = [];

  async search(q: Query): Promise<Hit[]> {
    this.lastQuery = q;
    return this.hits;
  }
}

function hit(
  pageRef: string,
  title: string,
  score: number,
  partial: Partial<Hit> = {},
): Hit {
  return {
    pageRef,
    score,
    title,
    summary: partial.summary ?? "",
    tags: partial.tags ?? [],
    kind: partial.kind ?? "concept",
    sourceDate: partial.sourceDate ?? "",
    gitDate: partial.gitDate ?? null,
    volatility: partial.volatility ?? "",
    supersededBy: partial.supersededBy ?? null,
    snippet: partial.snippet ?? null,
  };
}

// ---------------------------------------------------------------------------
// check: query construction, classification, empty-input guard
// ---------------------------------------------------------------------------

test("check sends an OR query with raw:true and a limit", async () => {
  const fake = new FakeSearcher();
  await check(fake, "Connection Pooling", "Reuse", "connections", CheckOpts);
  assert.ok(fake.lastQuery);
  assert.equal(fake.lastQuery!.raw, true);
  assert.equal(fake.lastQuery!.limit, UnboundedSearchLimit);
  assert.equal(
    fake.lastQuery!.text,
    `"connection" OR "pooling" OR "reuse" OR "connections"`,
  );
});

test("check returns no candidates for an empty query", async () => {
  const fake = new FakeSearcher();
  const candidates = await check(fake, "", "", "", CheckOpts);
  assert.deepEqual(candidates, []);
  assert.equal(fake.lastQuery, null);
});

test("check passes exclude through to the query, defaulting to none", async () => {
  const fake = new FakeSearcher();
  await check(fake, "Connection Pooling", "", "", CheckOpts);
  assert.equal(fake.lastQuery!.exclude, undefined);

  await check(fake, "Connection Pooling", "", "", {
    ...CheckOpts,
    exclude: ["wiki/concepts/connection-pooling.md"],
  });
  assert.deepEqual(fake.lastQuery!.exclude, [
    "wiki/concepts/connection-pooling.md",
  ]);
});

test("check classifies each hit and carries the full payload", async () => {
  const fake = new FakeSearcher();
  fake.hits = [
    hit(
      "wiki/concepts/connection-pooling.md",
      "Connection Pooling in Postgres",
      20,
      {
        summary: "Reuse connections.",
        tags: ["database"],
        volatility: "stable",
      },
    ),
  ];
  const candidates = await check(fake, "Connection Pooling", "", "", CheckOpts);
  assert.equal(candidates.length, 1);
  const c = candidates[0];
  assert.equal(c.page_ref, "wiki/concepts/connection-pooling.md");
  assert.equal(c.hint, HintDuplicate);
  assert.equal(c.summary, "Reuse connections.");
  assert.deepEqual(c.tags, ["database"]);
  assert.equal(c.volatility, "stable");
  assert.equal(c.superseded_by, null);
});

test("check honours custom thresholds", async () => {
  const fake = new FakeSearcher();
  fake.hits = [
    hit("a.md", "Connection Pooling", 10),
    hit("b.md", "Zebra Care", 3),
  ];
  const candidates = await check(fake, "Connection Pooling", "", "", CheckOpts);
  // score 10 → related (above default relatedThreshold 5.0); score 3 → distinct
  // (below 5.0) and therefore filtered out
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].hint, HintRelated);
});

test("check does not emit distinct candidates", async () => {
  const fake = new FakeSearcher();
  fake.hits = [
    hit("low.md", "Unrelated Topic", 1.0),
    hit("high.md", "Connection Pooling Patterns", 10.0),
  ];
  const candidates = await check(fake, "Connection Pooling", "", "", CheckOpts);
  assert.ok(
    candidates.every((c) => c.hint !== HintDistinct),
    "no distinct candidate emitted",
  );
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].page_ref, "high.md");
});

// ---------------------------------------------------------------------------
// Integration against a real committed vault
// ---------------------------------------------------------------------------

test("check finds its own title in a real vault", async () => {
  const idx = await newFixtureSearcher();
  try {
    const candidates = await check(
      idx,
      "Connection Pooling in Postgres",
      "",
      "",
      {
        limit: 0,
        duplicateThreshold: 1e-6,
        relatedThreshold: 1e-8,
        maxCandidates: 0,
      },
    );
    assert.ok(refOf(candidates, "wiki/concepts/connection-pooling.md"));
  } finally {
    idx.close();
  }
});

test("check survives noisy new text that an AND query would zero out", async () => {
  // The OR query keeps the real title match even though the summary shares
  // almost nothing — the case an AND-across-terms query would silently lose.
  const idx = await newFixtureSearcher();
  try {
    const candidates = await check(
      idx,
      "Connection Pooling in Postgres",
      "A totally unrelated sentence about zebras and volcanoes.",
      "",
      {
        limit: 0,
        duplicateThreshold: 1e-6,
        relatedThreshold: 1e-8,
        maxCandidates: 0,
      },
    );
    assert.ok(refOf(candidates, "wiki/concepts/connection-pooling.md"));
  } finally {
    idx.close();
  }
});

test("check with a verbatim body ranks that page highest", async () => {
  const idx = await newFixtureSearcher();
  try {
    const candidates = await check(
      idx,
      "",
      "",
      "Connection pooling reduces per-request handshake overhead by " +
        "reusing a fixed set of open connections across callers.",
      {
        limit: 0,
        duplicateThreshold: 1e-6,
        relatedThreshold: 1e-8,
        maxCandidates: 0,
      },
    );
    assert.ok(candidates.length > 0);
    assert.equal(candidates[0].page_ref, "wiki/concepts/connection-pooling.md");
  } finally {
    idx.close();
  }
});

test("check hints a real hit as duplicate with permissive thresholds", async () => {
  const idx = await newFixtureSearcher();
  try {
    const candidates = await check(
      idx,
      "Connection Pooling in Postgres",
      "Reuse connections instead of opening a new one per request.",
      "",
      {
        limit: 0,
        duplicateThreshold: 1e-6,
        relatedThreshold: 1e-8,
        maxCandidates: 0,
      },
    );
    const top = refOf(candidates, "wiki/concepts/connection-pooling.md");
    assert.ok(top);
    assert.equal(top.hint, HintDuplicate);
  } finally {
    idx.close();
  }
});

test("check respects the limit", async () => {
  const idx = await newFixtureSearcher();
  try {
    const candidates = await check(idx, "Connection Pooling", "", "", {
      limit: 1,
      duplicateThreshold: 0,
      relatedThreshold: 0,
      maxCandidates: 0,
    });
    assert.ok(candidates.length <= 1);
  } finally {
    idx.close();
  }
});

test("check returns the full payload from a real vault", async () => {
  const idx = await newFixtureSearcher();
  try {
    const candidates = await check(
      idx,
      "Connection Pooling in Postgres",
      "",
      "",
      {
        limit: 0,
        duplicateThreshold: 1e-6,
        relatedThreshold: 1e-8,
        maxCandidates: 0,
      },
    );
    const top = refOf(candidates, "wiki/concepts/connection-pooling.md");
    assert.ok(top);
    assert.equal(
      top.summary,
      "Reuse connections instead of opening a new one per request.",
    );
    assert.ok(Array.isArray(top.tags));
    assert.equal(top.superseded_by, null);
  } finally {
    idx.close();
  }
});

// ---------------------------------------------------------------------------
// withDefaults: bounded default limit, maxCandidates default
// ---------------------------------------------------------------------------

test("withDefaults: DefaultLimit (200) is passed through as bounded, not unbounded", async () => {
  const fake = new FakeSearcher();
  await check(fake, "Connection Pooling", "", "", {
    limit: DefaultLimit, // 200 — the CLI default
    duplicateThreshold: 0,
    relatedThreshold: 0,
    maxCandidates: 0,
  });
  assert.ok(fake.lastQuery);
  assert.equal(fake.lastQuery!.limit, DefaultLimit); // stays 200, not UnboundedSearchLimit
});

test("withDefaults: explicit limit 0 is the escape hatch to unbounded", async () => {
  const fake = new FakeSearcher();
  await check(fake, "Connection Pooling", "", "", {
    limit: 0, // explicit escape hatch via --limit 0
    duplicateThreshold: 0,
    relatedThreshold: 0,
    maxCandidates: 0,
  });
  assert.ok(fake.lastQuery);
  assert.equal(fake.lastQuery!.limit, UnboundedSearchLimit);
});

// ---------------------------------------------------------------------------
// check: maxCandidates cap
// ---------------------------------------------------------------------------

test("check caps results at maxCandidates, keeping highest-scoring hits", async () => {
  const fake = new FakeSearcher();
  // 20 hits all above relatedThreshold, score-descending (search order)
  fake.hits = Array.from({ length: 20 }, (_, i) => {
    const score = 20 - i; // 20, 19, 18, ... 1
    return hit(`page-${i}.md`, `Topic ${i}`, score);
  });
  const cap = 5;
  const candidates = await check(fake, "Topic 0", "", "", {
    limit: 0,
    duplicateThreshold: 0,
    relatedThreshold: 5.0,
    maxCandidates: cap,
  });
  // Only hits with score >= 5.0 pass the threshold: scores 20..5 → 16 hits
  // then sliced to cap
  assert.equal(candidates.length, cap);
  // Highest-scoring hit is first
  assert.ok(candidates[0].score >= candidates[candidates.length - 1].score);
});

test("check does not slice when fewer candidates than maxCandidates", async () => {
  const fake = new FakeSearcher();
  fake.hits = [
    hit("a.md", "Connection Pooling", 10),
    hit("b.md", "Reuse Patterns", 8),
  ];
  const candidates = await check(fake, "Connection Pooling", "", "", {
    limit: 0,
    duplicateThreshold: 0,
    relatedThreshold: 5.0,
    maxCandidates: 15,
  });
  assert.equal(candidates.length, 2);
});

test("withDefaults: maxCandidates 0 resolves to DefaultMaxCandidates", async () => {
  const fake = new FakeSearcher();
  // 20 hits all above relatedThreshold
  fake.hits = Array.from({ length: 20 }, (_, i) =>
    hit(`page-${i}.md`, `Topic ${i}`, 10 - i * 0.1),
  );
  const candidates = await check(fake, "Topic", "", "", {
    limit: 0,
    duplicateThreshold: 0,
    relatedThreshold: 5.0,
    maxCandidates: 0, // → DefaultMaxCandidates (15)
  });
  assert.equal(candidates.length, DefaultMaxCandidates);
});

// ---------------------------------------------------------------------------
// nominate: the --ref mode
// ---------------------------------------------------------------------------

function refsOf(nominees: Omit<Candidate, "hint">[]): string[] {
  return nominees.map((n) => n.page_ref);
}

test("nominate queries with the ref page's own text", async () => {
  const fake = new FakeSearcher();
  await nominate(
    fake,
    "wiki/concepts/self.md",
    "Connection Pooling",
    "Reuse connections",
    "pooling body",
    { limit: 0 },
  );
  assert.ok(fake.lastQuery);
  assert.equal(fake.lastQuery!.raw, true);
  assert.equal(
    fake.lastQuery!.text,
    `"connection" OR "pooling" OR "reuse" OR "connections" OR "body"`,
  );
});

test("nominate never returns the named page itself", async () => {
  const fake = new FakeSearcher();
  fake.hits = [
    hit("wiki/concepts/self.md", "Connection Pooling", 99),
    hit("wiki/concepts/other.md", "Pool Sizing", 2),
  ];
  const nominees = await nominate(fake, "wiki/concepts/self.md", "x", "", "", {
    limit: 0,
  });
  assert.deepEqual(refsOf(nominees), ["wiki/concepts/other.md"]);
});

test("nominate drops a superseded page", async () => {
  const fake = new FakeSearcher();
  fake.hits = [
    hit("wiki/concepts/old.md", "Connection Pooling", 9, {
      supersededBy: "wiki/concepts/new.md",
    }),
    hit("wiki/concepts/other.md", "Pool Sizing", 2),
  ];
  const nominees = await nominate(fake, "wiki/concepts/self.md", "x", "", "", {
    limit: 0,
  });
  assert.deepEqual(refsOf(nominees), ["wiki/concepts/other.md"]);
});

test("nominate applies no score gate: a below-related hit is still returned", async () => {
  const fake = new FakeSearcher();
  // 0.4 is far below the existing RelatedThreshold of 5.0.
  fake.hits = [hit("wiki/concepts/faint.md", "Barely Overlapping", 0.4)];
  const nominees = await nominate(fake, "wiki/concepts/self.md", "x", "", "", {
    limit: 0,
  });
  assert.deepEqual(refsOf(nominees), ["wiki/concepts/faint.md"]);
});

test("nominate omits hint and carries the candidate payload", async () => {
  const fake = new FakeSearcher();
  fake.hits = [
    hit("wiki/concepts/other.md", "Pool Sizing", 3, {
      summary: "Size the pool.",
      tags: ["database"],
      volatility: "stable",
    }),
  ];
  const nominees = await nominate(fake, "wiki/concepts/self.md", "x", "", "", {
    limit: 0,
  });
  assert.equal(nominees.length, 1);
  assert.equal("hint" in nominees[0], false);
  assert.equal(nominees[0].title, "Pool Sizing");
  assert.equal(nominees[0].score, 3);
  assert.equal(nominees[0].summary, "Size the pool.");
  assert.deepEqual(nominees[0].tags, ["database"]);
  assert.equal(nominees[0].volatility, "stable");
  assert.equal(nominees[0].superseded_by, null);
});

test("nominate caps the nomination at limit, highest-scoring first", async () => {
  const fake = new FakeSearcher();
  fake.hits = Array.from({ length: 10 }, (_, i) =>
    hit(`wiki/concepts/p${i}.md`, `Topic ${i}`, 10 - i),
  );
  const nominees = await nominate(fake, "wiki/concepts/self.md", "x", "", "", {
    limit: 3,
  });
  assert.deepEqual(refsOf(nominees), [
    "wiki/concepts/p0.md",
    "wiki/concepts/p1.md",
    "wiki/concepts/p2.md",
  ]);
});

test("nominate scans past the named page, so a small limit still nominates", async () => {
  const fake = new FakeSearcher();
  // The self hit ranks first: a window of exactly `limit` would return nothing.
  fake.hits = [
    hit("wiki/concepts/self.md", "Connection Pooling", 99),
    hit("wiki/concepts/other.md", "Pool Sizing", 5),
  ];
  const nominees = await nominate(fake, "wiki/concepts/self.md", "x", "", "", {
    limit: 1,
  });
  assert.deepEqual(refsOf(nominees), ["wiki/concepts/other.md"]);
});

test("nominate sends nothing for an empty query", async () => {
  const fake = new FakeSearcher();
  const nominees = await nominate(fake, "wiki/concepts/self.md", "", "", "", {
    limit: 0,
  });
  assert.deepEqual(nominees, []);
  assert.equal(fake.lastQuery, null);
});

test("nominate scans a fixed window, not the caller's --limit", async () => {
  const fake = new FakeSearcher();
  await nominate(fake, "wiki/concepts/self.md", "x", "", "", { limit: 7 });
  assert.ok(fake.lastQuery);
  // The window must exceed the row cap, since the self row comes out of it.
  assert.equal(fake.lastQuery!.limit, RefScanDefault);
});

test("nominate scans the same window for --limit 0", async () => {
  const fake = new FakeSearcher();
  await nominate(fake, "wiki/concepts/self.md", "x", "", "", { limit: 0 });
  assert.ok(fake.lastQuery);
  assert.equal(fake.lastQuery!.limit, RefScanDefault);
});

test("nominate on a real vault returns a non-self hit and never the named page", async () => {
  // A dedicated vault: the shared fixture has no page overlapping the named one,
  // so nominating from it could pass while returning nothing at all.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enchiridion-nom-"));
  writeFixturePage(
    root,
    "concepts/connection-pooling.md",
    "---\ntitle: Connection Pooling in Postgres\n" +
      "summary: Reuse connections instead of opening a new one per request.\n" +
      "tags:\n  - database\nvolatility: stable\n---\n\n" +
      "Connection pooling reduces per-request handshake overhead by " +
      "reusing a fixed set of open connections across callers.\n",
  );
  writeFixturePage(
    root,
    "concepts/connection-limits.md",
    "---\ntitle: Database Connection Limits\n" +
      "summary: Every connection costs memory on both ends.\n" +
      "tags:\n  - database\nvolatility: stable\n---\n\n" +
      "An idle database connection still holds a server backend, so a high " +
      "connection ceiling trades memory for concurrency.\n",
  );
  const repo = new VaultGit(root);
  await repo.init();
  await repo.add(["."]);
  await repo.commit("fixtures");
  const idx = await Index.open(root);
  try {
    const nominees = await nominate(
      idx,
      "wiki/concepts/connection-pooling.md",
      "Connection Pooling in Postgres",
      "Reuse connections instead of opening a new one per request.",
      "Connection pooling reduces per-request handshake overhead by " +
        "reusing a fixed set of open connections across callers.",
      { limit: 0 },
    );
    assert.ok(
      !refsOf(nominees).includes("wiki/concepts/connection-pooling.md"),
    );
    assert.ok(refsOf(nominees).includes("wiki/concepts/connection-limits.md"));
  } finally {
    idx.close();
  }
});

test("nominate --limit 0 is not truncated by the gated mode's candidate cap", async () => {
  // The regression the row cap caused: an orphan with more plausible linkers
  // than DefaultMaxCandidates silently loses the rest.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "enchiridion-cap-"));
  const overlaps = ["connection", "pooling", "handshake", "backend"];
  for (let i = 0; i < DefaultMaxCandidates + 5; i++) {
    const word = overlaps[i % overlaps.length];
    writeFixturePage(
      root,
      `concepts/topic-${i}.md`,
      `---\ntitle: Topic ${i}\nsummary: ${word} notes.\n` +
        `tags:\n  - database\nvolatility: stable\n---\n\n` +
        `A ${word} note about ${word} reuse and ${word} overhead.\n`,
    );
  }
  const repo = new VaultGit(root);
  await repo.init();
  await repo.add(["."]);
  await repo.commit("fixtures");
  const idx = await Index.openInMemory(repo);
  try {
    const nominees = await nominate(
      idx,
      "wiki/concepts/self.md",
      "Topic",
      "",
      "",
      {
        limit: 0,
      },
    );
    assert.ok(
      nominees.length > DefaultMaxCandidates,
      `expected more than ${DefaultMaxCandidates} nominations, got ${nominees.length}`,
    );
  } finally {
    idx.close();
  }
});

// ---------------------------------------------------------------------------
// discover: one call per draft plan page
// ---------------------------------------------------------------------------

test("discover runs check for every plan page", async () => {
  const idx = await newFixtureSearcher();
  try {
    const summary = "Daily flour-and-water feeding keeps a starter active.";
    const mk = (title: string, sum: string): PagePlan => ({
      op: "create",
      title,
      kind: "concept",
      page_ref: "",
      body: "",
      frontmatter: OrderedMap.decode({ summary: sum }),
      edges: OrderedMap.decode({}),
    });
    const pages = [
      mk("Connection Pooling in Postgres", ""),
      mk("Feeding a Sourdough Starter", summary),
    ];
    const results = await discover(idx, pages, {
      limit: 0,
      duplicateThreshold: 1e-6,
      relatedThreshold: 1e-8,
      maxCandidates: 0,
    });
    assert.deepEqual(
      results.map((r) => r.title),
      ["Connection Pooling in Postgres", "Feeding a Sourdough Starter"],
    );
    assert.ok(
      refOf(results[0].candidates, "wiki/concepts/connection-pooling.md"),
    );
  } finally {
    idx.close();
  }
});

test("discover survives an update page with no body", async () => {
  const idx = await newFixtureSearcher();
  try {
    const pages: PagePlan[] = [
      {
        op: "update",
        title: "Connection Pooling in Postgres",
        kind: "",
        page_ref: "wiki/concepts/connection-pooling.md",
        body: null,
        frontmatter: OrderedMap.decode({}),
        edges: OrderedMap.decode({}),
      },
    ];
    const results = await discover(idx, pages, {
      limit: 0,
      duplicateThreshold: 0,
      relatedThreshold: 0,
      maxCandidates: 0,
    });
    assert.equal(results.length, 1);
  } finally {
    idx.close();
  }
});

// ---------------------------------------------------------------------------
// tag helpers
// ---------------------------------------------------------------------------

test("tagsContaining matches case-insensitively, preserving vocabulary order", () => {
  const vocab = [
    { tag: "access-management", count: 7 },
    { tag: "node-access", count: 3 },
    { tag: "csm-ticket", count: 2 },
    { tag: "sourdough", count: 1 },
  ];
  const cases: [string[], string[]][] = [
    [["access"], ["access-management", "node-access"]],
    [["ACCESS"], ["access-management", "node-access"]],
    [
      ["access", "csm"],
      ["access-management", "node-access", "csm-ticket"],
    ],
    [["zzz"], []],
  ];
  for (const [substrings, want] of cases) {
    assert.deepEqual(tagsContaining(vocab, substrings), want);
  }
});

test("tagCounts counts per requested tag in request order, 0 when absent", () => {
  const vocab = [{ tag: "access-management", count: 7 }];
  assert.deepEqual(tagCounts(vocab, ["access-management"]), [
    { tag: "access-management", count: 7 },
  ]);
  assert.deepEqual(tagCounts(vocab, ["user-provisioning"]), [
    { tag: "user-provisioning", count: 0 },
  ]);
  const vocab2 = [
    { tag: "a", count: 1 },
    { tag: "b", count: 2 },
  ];
  assert.deepEqual(tagCounts(vocab2, ["b", "a"]), [
    { tag: "b", count: 2 },
    { tag: "a", count: 1 },
  ]);
});
