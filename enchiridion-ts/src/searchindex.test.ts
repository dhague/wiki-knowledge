/** Tests for the searchindex module: table-driven, in-memory DB, public API only. */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Index, tokenizeQuery, SCHEMA_VERSION } from "./searchindex.js";
import type { Git, Snapshot, PageChange } from "./searchindex.js";
import { VaultGit } from "./vaultgit.js";
import { enumeratePageRefs } from "./pagepredicate.js";

// ---------------------------------------------------------------------------
// Test infrastructure
// ---------------------------------------------------------------------------

/** Fake Git implementation — scripted snapshots keyed by `since`. */
class FakeGit implements Git {
  snapshots: Map<string, Snapshot> = new Map();

  async committedPages(since: string): Promise<Snapshot> {
    const snap = this.snapshots.get(since);
    if (!snap) return { head: since, fullRebuild: false, pages: [] };
    return snap;
  }
}

/** A Fake whose full-tree read (`since == ""`) yields exactly `pages` at `head`. */
function fakeAtHead(head: string, ...pages: PageChange[]): FakeGit {
  const fake = new FakeGit();
  fake.snapshots.set("", { head, fullRebuild: true, pages });
  return fake;
}

function page(
  title: string,
  summary: string,
  body: string,
  tags: string[],
  extra: string,
): string {
  let text = `---\ntitle: ${title}\nsummary: ${summary}\n`;
  if (tags.length > 0) {
    text += "tags:\n";
    for (const tag of tags) text += `  - ${tag}\n`;
  }
  if (extra) text += extra;
  text += `---\n\n${body}\n`;
  return text;
}

function pageChange(
  pageRef: string,
  title: string,
  summary: string,
  body: string,
  tags: string[],
  extra: string,
  date: string,
): PageChange {
  return {
    pageRef,
    content: page(title, summary, body, tags, extra),
    date,
    deleted: false,
  };
}

function refsOf(hits: Awaited<ReturnType<Index["search"]>>): string[] {
  return hits.map((h) => h.pageRef);
}

async function openIndex(fake: FakeGit): Promise<Index> {
  return Index.openInMemory(fake);
}

// ---------------------------------------------------------------------------
// tokenizeQuery
// ---------------------------------------------------------------------------

describe("tokenizeQuery", () => {
  const cases = [
    { in: "wiki-knowledge", want: '"wiki-knowledge"' },
    { in: "connection pooling", want: '"connection" "pooling"' },
    { in: "  spaced   out  ", want: '"spaced" "out"' },
    { in: "", want: "" },
    { in: 'say "hi"', want: '"say" "\\"hi\\""' },
  ];
  for (const tc of cases) {
    it(`tokenizeQuery(${JSON.stringify(tc.in)})`, () => {
      assert.equal(tokenizeQuery(tc.in), tc.want);
    });
  }
});

// ---------------------------------------------------------------------------
// Core search tests
// ---------------------------------------------------------------------------

describe("search", () => {
  it("finds a page by body text", async () => {
    const fake = fakeAtHead(
      "head1",
      pageChange(
        "wiki/concepts/pooling.md",
        "Connection pooling",
        "Reusing connections.",
        "Pooling keeps open database handles around.",
        ["database"],
        "",
        "",
      ),
    );
    const index = await openIndex(fake);
    try {
      const hits = await index.search({ text: "database handles" });
      assert.deepEqual(refsOf(hits), ["wiki/concepts/pooling.md"]);
      assert.equal(hits[0].kind, "concept");
      assert.deepEqual(hits[0].tags, ["database"]);
      assert.ok(hits[0].score > 0, "score must be positive (higher-is-better)");
      assert.ok(
        hits[0].snippet !== null && hits[0].snippet !== "",
        "expect snippet on text hit",
      );
    } finally {
      index.close();
    }
  });

  it("ranks title match above body-only mention", async () => {
    const fake = fakeAtHead(
      "head1",
      pageChange(
        "wiki/concepts/titled.md",
        "Pooling",
        "About it.",
        "Nothing else here.",
        [],
        "",
        "",
      ),
      pageChange(
        "wiki/concepts/bodied.md",
        "Something else",
        "Unrelated.",
        "A passing mention of pooling.",
        [],
        "",
        "",
      ),
    );
    const index = await openIndex(fake);
    try {
      const hits = await index.search({ text: "pooling" });
      assert.deepEqual(refsOf(hits), [
        "wiki/concepts/titled.md",
        "wiki/concepts/bodied.md",
      ]);
    } finally {
      index.close();
    }
  });

  it("filters on tags_all", async () => {
    const fake = fakeAtHead(
      "head1",
      pageChange(
        "wiki/concepts/a.md",
        "A",
        "First.",
        "shared word",
        ["alpha", "shared"],
        "source_date: 2026-07-01\nvolatility: stable\n",
        "",
      ),
      pageChange(
        "wiki/entities/b.md",
        "B",
        "Second.",
        "shared word",
        ["beta", "shared"],
        "source_date: 2026-08-01\nvolatility: volatile\n",
        "",
      ),
    );
    const index = await openIndex(fake);
    try {
      const hits = await index.search({ text: "shared", tagsAll: ["alpha"] });
      assert.deepEqual(refsOf(hits), ["wiki/concepts/a.md"]);
    } finally {
      index.close();
    }
  });

  it("tags_all conjunctive (both required)", async () => {
    const fake = fakeAtHead(
      "head1",
      pageChange(
        "wiki/concepts/a.md",
        "A",
        "First.",
        "shared word",
        ["alpha", "shared"],
        "",
        "",
      ),
      pageChange(
        "wiki/entities/b.md",
        "B",
        "Second.",
        "shared word",
        ["beta", "shared"],
        "",
        "",
      ),
    );
    const index = await openIndex(fake);
    try {
      const hits = await index.search({
        text: "shared",
        tagsAll: ["alpha", "beta"],
      });
      assert.equal(hits.length, 0);
    } finally {
      index.close();
    }
  });

  it("filters on tags_any", async () => {
    const fake = fakeAtHead(
      "head1",
      pageChange(
        "wiki/concepts/a.md",
        "A",
        "First.",
        "shared word",
        ["alpha", "shared"],
        "",
        "",
      ),
      pageChange(
        "wiki/entities/b.md",
        "B",
        "Second.",
        "shared word",
        ["beta", "shared"],
        "",
        "",
      ),
    );
    const index = await openIndex(fake);
    try {
      const hits = await index.search({
        text: "shared",
        tagsAny: ["alpha", "beta"],
      });
      assert.equal(hits.length, 2);
    } finally {
      index.close();
    }
  });

  it("filters on kind", async () => {
    const fake = fakeAtHead(
      "head1",
      pageChange(
        "wiki/concepts/a.md",
        "A",
        "First.",
        "shared word",
        [],
        "",
        "",
      ),
      pageChange(
        "wiki/entities/b.md",
        "B",
        "Second.",
        "shared word",
        [],
        "",
        "",
      ),
    );
    const index = await openIndex(fake);
    try {
      const hits = await index.search({ text: "shared", kinds: ["entity"] });
      assert.deepEqual(refsOf(hits), ["wiki/entities/b.md"]);
    } finally {
      index.close();
    }
  });

  it("filters on since", async () => {
    const fake = fakeAtHead(
      "head1",
      pageChange(
        "wiki/concepts/a.md",
        "A",
        "First.",
        "shared word",
        [],
        "source_date: 2026-07-01\n",
        "",
      ),
      pageChange(
        "wiki/entities/b.md",
        "B",
        "Second.",
        "shared word",
        [],
        "source_date: 2026-08-01\n",
        "",
      ),
    );
    const index = await openIndex(fake);
    try {
      const hits = await index.search({ text: "shared", since: "2026-07-15" });
      assert.deepEqual(refsOf(hits), ["wiki/entities/b.md"]);
    } finally {
      index.close();
    }
  });

  it("filters on until", async () => {
    const fake = fakeAtHead(
      "head1",
      pageChange(
        "wiki/concepts/a.md",
        "A",
        "First.",
        "shared word",
        [],
        "source_date: 2026-07-01\n",
        "",
      ),
      pageChange(
        "wiki/entities/b.md",
        "B",
        "Second.",
        "shared word",
        [],
        "source_date: 2026-08-01\n",
        "",
      ),
    );
    const index = await openIndex(fake);
    try {
      const hits = await index.search({ text: "shared", until: "2026-07-15" });
      assert.deepEqual(refsOf(hits), ["wiki/concepts/a.md"]);
    } finally {
      index.close();
    }
  });

  it("filters on volatility", async () => {
    const fake = fakeAtHead(
      "head1",
      pageChange(
        "wiki/concepts/a.md",
        "A",
        "First.",
        "shared word",
        [],
        "volatility: stable\n",
        "",
      ),
      pageChange(
        "wiki/entities/b.md",
        "B",
        "Second.",
        "shared word",
        [],
        "volatility: volatile\n",
        "",
      ),
    );
    const index = await openIndex(fake);
    try {
      const hits = await index.search({
        text: "shared",
        volatility: ["stable"],
      });
      assert.deepEqual(refsOf(hits), ["wiki/concepts/a.md"]);
    } finally {
      index.close();
    }
  });

  it("rejects an unknown dateField", async () => {
    const index = await openIndex(new FakeGit());
    try {
      await assert.rejects(
        () => index.search({ dateField: "mtime" }),
        /date_field must be/,
      );
    } finally {
      index.close();
    }
  });

  it("until includes a same-day timestamp (source_date normalised to YYYY-MM-DD)", async () => {
    const fake = fakeAtHead(
      "head1",
      pageChange(
        "wiki/concepts/dated.md",
        "Dated",
        "Bare date.",
        "shared word",
        [],
        "source_date: 2026-07-20\n",
        "",
      ),
      pageChange(
        "wiki/concepts/timed.md",
        "Timed",
        "A clock.",
        "shared word",
        [],
        "source_date: 2026-07-20T14:30:00Z\n",
        "",
      ),
    );
    const index = await openIndex(fake);
    try {
      const hits = await index.search({ text: "shared", until: "2026-07-20" });
      assert.equal(
        hits.length,
        2,
        "both pages should be within --until 2026-07-20",
      );
      for (const hit of hits) {
        assert.equal(hit.sourceDate, "2026-07-20");
      }
    } finally {
      index.close();
    }
  });

  it("excludes superseded pages by default", async () => {
    const fake = fakeAtHead(
      "head1",
      pageChange(
        "wiki/concepts/old.md",
        "Old",
        "The old take.",
        "shared word",
        [],
        "",
        "",
      ),
      pageChange(
        "wiki/concepts/new.md",
        "New",
        "The new take.",
        "shared word",
        [],
        'supersedes:\n  - "[Old](old.md)"\n',
        "",
      ),
    );
    const index = await openIndex(fake);
    try {
      const hits = await index.search({ text: "shared" });
      assert.deepEqual(refsOf(hits), ["wiki/concepts/new.md"]);

      const allHits = await index.search({
        text: "shared",
        includeSuperseded: true,
      });
      assert.equal(allHits.length, 2);
      const old = allHits.find((h) => h.pageRef === "wiki/concepts/old.md");
      assert.ok(old, "old page must be present with includeSuperseded");
      assert.equal(old.supersededBy, "wiki/concepts/new.md");
    } finally {
      index.close();
    }
  });

  it("pure-metadata query (no text)", async () => {
    const fake = fakeAtHead(
      "head1",
      pageChange("wiki/concepts/a.md", "A", "First.", "body", ["x"], "", ""),
      pageChange("wiki/entities/b.md", "B", "Second.", "body", ["x"], "", ""),
    );
    const index = await openIndex(fake);
    try {
      const hits = await index.search({ tagsAll: ["x"] });
      assert.deepEqual(refsOf(hits), [
        "wiki/concepts/a.md",
        "wiki/entities/b.md",
      ]);
    } finally {
      index.close();
    }
  });

  it("honours limit", async () => {
    const fake = fakeAtHead(
      "head1",
      pageChange("wiki/concepts/a.md", "a", "s", "shared word", [], "", ""),
      pageChange("wiki/concepts/b.md", "b", "s", "shared word", [], "", ""),
      pageChange("wiki/concepts/c.md", "c", "s", "shared word", [], "", ""),
    );
    const index = await openIndex(fake);
    try {
      const hits = await index.search({ text: "shared", limit: 2 });
      assert.equal(hits.length, 2);
    } finally {
      index.close();
    }
  });

  it("raw mode is the FTS5 escape hatch", async () => {
    const fake = fakeAtHead(
      "head1",
      pageChange("wiki/concepts/a.md", "A", "s", "alpha only", [], "", ""),
      pageChange("wiki/concepts/b.md", "B", "s", "beta only", [], "", ""),
    );
    const index = await openIndex(fake);
    try {
      const hits = await index.search({ text: "alpha OR beta", raw: true });
      assert.equal(hits.length, 2);
    } finally {
      index.close();
    }
  });

  it("syncs committed history on every search", async () => {
    const fake = fakeAtHead(
      "head1",
      pageChange(
        "wiki/concepts/a.md",
        "A",
        "s",
        "original wording",
        [],
        "",
        "",
      ),
    );
    const index = await openIndex(fake);
    try {
      let hits = await index.search({ text: "original" });
      assert.equal(hits.length, 1);

      // Simulate new commit landing (range walk from head1 → head2).
      fake.snapshots.set("head1", {
        head: "head2",
        fullRebuild: false,
        pages: [
          pageChange(
            "wiki/concepts/a.md",
            "A",
            "s",
            "replacement wording",
            [],
            "",
            "",
          ),
        ],
      });
      hits = await index.search({ text: "replacement" });
      assert.equal(hits.length, 1);

      // Further commit deletes it.
      fake.snapshots.set("head2", {
        head: "head3",
        fullRebuild: false,
        pages: [
          {
            pageRef: "wiki/concepts/a.md",
            content: "",
            date: "",
            deleted: true,
          },
        ],
      });
      hits = await index.search({ text: "replacement" });
      assert.equal(hits.length, 0);
    } finally {
      index.close();
    }
  });

  it("uncommitted page is not searchable (ADR-0015)", async () => {
    // Content comes from git blobs, so writing bytes to disk would not surface.
    const index = await openIndex(new FakeGit());
    try {
      const hits = await index.search({ text: "body" });
      assert.equal(hits.length, 0);
    } finally {
      index.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Supersedes percent-decoding
// ---------------------------------------------------------------------------

describe("supersedes percent-decoding", () => {
  it("resolves a supersedes target whose filename needs encoding", async () => {
    const targetRef = "wiki/concepts/old name (draft) #1.md";
    const fake = fakeAtHead(
      "head1",
      pageChange(
        "wiki/concepts/new.md",
        "New",
        "The new take.",
        "shared word",
        [],
        'supersedes:\n  - "[Old](old%20name%20%28draft%29%20%231.md)"\n',
        "",
      ),
      pageChange(targetRef, "Old", "The old take.", "shared word", [], "", ""),
    );
    const index = await openIndex(fake);
    try {
      const hits = await index.search({ text: "shared" });
      assert.deepEqual(refsOf(hits), ["wiki/concepts/new.md"]);

      const all = await index.search({
        text: "shared",
        includeSuperseded: true,
      });
      const old = all.find((h) => h.pageRef === targetRef);
      assert.ok(old, "superseded page present with includeSuperseded");
      assert.equal(old.supersededBy, "wiki/concepts/new.md");
    } finally {
      index.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Malformed pages
// ---------------------------------------------------------------------------

describe("malformed pages", () => {
  it("skips pages at the wrong folder depth rather than crashing a reindex", async () => {
    const fake = fakeAtHead(
      "head1",
      pageChange("wiki/concepts/a.md", "A", "s", "shared word", [], "", ""),
      pageChange("wiki/loose.md", "Loose", "s", "shared word", [], "", ""),
      pageChange(
        "wiki/concepts/nested/deep.md",
        "Deep",
        "s",
        "shared word",
        [],
        "",
        "",
      ),
    );
    const index = await openIndex(fake);
    try {
      const stats = await index.reindex(true);
      assert.equal(stats.pages, 1, "only the well-formed page is indexed");
      const hits = await index.search({ text: "shared" });
      assert.deepEqual(refsOf(hits), ["wiki/concepts/a.md"]);
    } finally {
      index.close();
    }
  });

  it("a wiki/_index.md page change is never indexed (#310)", async () => {
    // Defence in depth: the git walk already excludes it, so a real vault never
    // reaches this, but a hand-built snapshot must still not index it.
    const fake = fakeAtHead(
      "head1",
      pageChange("wiki/concepts/a.md", "A", "s", "shared word", [], "", ""),
      pageChange("wiki/_index.md", "Index", "s", "shared word", [], "", ""),
    );
    const index = await openIndex(fake);
    try {
      const stats = await index.reindex(true);
      assert.equal(stats.pages, 1, "only a.md is indexed");
      const hits = await index.search({ text: "shared" });
      assert.deepEqual(refsOf(hits), ["wiki/concepts/a.md"]);
    } finally {
      index.close();
    }
  });

  it("skips a page whose frontmatter edge is not a markdown link", async () => {
    const fake = fakeAtHead(
      "head1",
      pageChange("wiki/concepts/a.md", "A", "s", "shared word", [], "", ""),
      pageChange(
        "wiki/concepts/badedge.md",
        "Bad edge",
        "s",
        "shared word",
        [],
        "related:\n  - wiki/concepts/b.md\n",
        "",
      ),
    );
    const index = await openIndex(fake);
    try {
      const stats = await index.reindex(true);
      assert.equal(stats.pages, 1, "the bad-edge page is skipped");
      const hits = await index.search({ text: "shared" });
      assert.deepEqual(refsOf(hits), ["wiki/concepts/a.md"]);
    } finally {
      index.close();
    }
  });

  it("counts a page that becomes malformed as removed on a delta sync", async () => {
    const fake = fakeAtHead(
      "head1",
      pageChange("wiki/concepts/a.md", "A", "s", "shared word", [], "", ""),
    );
    const index = await openIndex(fake);
    try {
      await index.reindex(false);

      // Same ref and depth, so the skip is the malformed edge, not the depth.
      fake.snapshots.set("head1", {
        head: "head2",
        fullRebuild: false,
        pages: [
          pageChange(
            "wiki/concepts/a.md",
            "A",
            "s",
            "shared word",
            [],
            "related:\n  - wiki/concepts/b.md\n",
            "",
          ),
        ],
      });
      const stats = await index.reindex(false);
      assert.equal(stats.removed, 1, "skip drops the previously-indexed page");
      assert.equal(stats.pages, 0);

      const hits = await index.search({ text: "shared" });
      assert.equal(hits.length, 0, "malformed page is not searchable");
    } finally {
      index.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Page predicate agreement
// ---------------------------------------------------------------------------

describe("page predicate agreement", () => {
  it("disk, git, and status counts agree on an edge vault (#310)", async () => {
    // A generated index, a nested page and a wiki-root file all sit on disk and
    // are committed: all three views must treat them as non-pages.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "searchindex-test-"));
    try {
      const write = (rel: string, text: string) => {
        const p = path.join(root, ...rel.split("/"));
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, text);
      };
      write(
        "wiki/concepts/a.md",
        page("A", "s", "shared body", [], "source_date: 2026-01-01\n"),
      );
      write("wiki/_index.md", "generated table of contents\n");
      write("wiki/concepts/nested/deep.md", "nested\n");
      write("wiki/loose.md", "loose\n");

      const git = new VaultGit(root);
      await git.init();
      await git.add(["."]);
      await git.commit("seed edge vault");

      // The three views, computed independently on the same vault:
      const onDisk = enumeratePageRefs(root);
      const index = await Index.openWithGit(root, git);
      try {
        const stats = await index.reindex(true);
        const status = await index.status();
        assert.deepEqual(onDisk, ["wiki/concepts/a.md"], "disk view");
        assert.equal(stats.pages, 1, "git view — one page indexed");
        assert.equal(status.pages, 1, "index view");
        assert.equal(
          status.uncommittedPages,
          0,
          "uncommitted_pages consistent: everything on disk is a page and is indexed",
        );
        const hits = await index.search({ text: "shared" });
        assert.deepEqual(refsOf(hits), ["wiki/concepts/a.md"]);
      } finally {
        index.close();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Reindex
// ---------------------------------------------------------------------------

describe("reindex", () => {
  it("reports stats correctly", async () => {
    const fake = fakeAtHead(
      "head1",
      pageChange("wiki/concepts/a.md", "A", "s", "body", [], "", ""),
      pageChange("wiki/concepts/b.md", "B", "s", "body", [], "", ""),
    );
    const index = await openIndex(fake);
    try {
      let stats = await index.reindex(false);
      assert.equal(stats.inserted, 2);
      assert.equal(stats.pages, 2);

      // New commit: edit a.md, delete b.md.
      fake.snapshots.set("head1", {
        head: "head2",
        fullRebuild: false,
        pages: [
          pageChange("wiki/concepts/a.md", "A", "s", "edited body", [], "", ""),
          {
            pageRef: "wiki/concepts/b.md",
            content: "",
            date: "",
            deleted: true,
          },
        ],
      });
      fake.snapshots.set("", {
        head: "head2",
        fullRebuild: true,
        pages: [
          pageChange("wiki/concepts/a.md", "A", "s", "edited body", [], "", ""),
        ],
      });
      stats = await index.reindex(false);
      assert.equal(stats.inserted, 0, "no new pages");
      assert.equal(stats.updated, 1, "a.md updated");
      assert.equal(stats.removed, 1, "b.md removed");
      assert.equal(stats.pages, 1);

      stats = await index.reindex(true);
      assert.equal(stats.inserted, 1);
      assert.equal(stats.pages, 1);
    } finally {
      index.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Vault is a git repository
// ---------------------------------------------------------------------------

describe("Index.open on a candidate vault", () => {
  it("refuses when .wiki-knowledge exists as a file instead of a directory", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "searchindex-test-"));
    try {
      const fake = fakeAtHead("head1");
      // A file where the directory should be — the EEXIST with recursive:true case.
      fs.writeFileSync(path.join(root, ".wiki-knowledge"), "not a directory");

      await assert.rejects(
        () => Index.openWithGit(root, fake),
        /\.wiki-knowledge.*exists as a file.*delete it/,
        "should give actionable error, not raw EEXIST",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a root that carries a vault marker but is not a git work tree", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "searchindex-test-"));
    try {
      fs.mkdirSync(path.join(root, "wiki"), { recursive: true });

      await assert.rejects(
        () => Index.open(root),
        /not a git work tree.*enchiridion init/,
        "a marker without a repo is a candidate vault, not a vault",
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("a work tree with no commits opens and stays empty", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "searchindex-test-"));
    try {
      fs.mkdirSync(path.join(root, "wiki"), { recursive: true });
      const git = new VaultGit(root);
      await git.init();

      const index = await Index.open(root);
      try {
        const status = await index.status();
        assert.equal(status.pages, 0, "no commits means an empty index");
        const hits = await index.search({ text: "anything" });
        assert.equal(hits.length, 0);
      } finally {
        index.close();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Schema version / mismatch
// ---------------------------------------------------------------------------

describe("schema", () => {
  it("version mismatch triggers a full rebuild on reopen (on-disk DB)", async () => {
    // A real on-disk DB so we can close, reopen and verify the rebuild.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "searchindex-test-"));
    try {
      const fake = fakeAtHead(
        "head1",
        pageChange("wiki/concepts/a.md", "A", "s", "body", [], "", ""),
      );

      const idx1 = await Index.openWithGit(tmpDir, fake);
      await idx1.reindex(false);
      idx1.close();

      // Patch the schema version directly in the DB file.
      const { createRequire } = await import("node:module");
      const _req = createRequire(import.meta.url);
      const { Database } = _req("node-sqlite3-wasm") as {
        Database: new (p: string) => { exec(s: string): void; close(): void };
      };
      const patchDb = new Database(
        path.join(tmpDir, ".wiki-knowledge", "index.db"),
      );
      patchDb.exec(
        "UPDATE meta SET value = '999' WHERE key = 'schema_version'",
      );
      patchDb.close();

      // Reopen: the mismatch should trigger a rebuild from the full tree.
      const idx2 = await Index.openWithGit(tmpDir, fake);
      try {
        const status = await idx2.status();
        assert.equal(
          status.schemaVersion,
          SCHEMA_VERSION,
          "rebuild must reset schema version",
        );
        assert.equal(status.pages, 1, "rebuild must re-index pages from HEAD");
      } finally {
        idx2.close();
      }
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

describe("status", () => {
  it("reports pages, schema version, backend, gitHead", async () => {
    const fake = fakeAtHead(
      "head1",
      pageChange("wiki/concepts/a.md", "A", "s", "body", [], "", ""),
    );
    const index = await openIndex(fake);
    try {
      await index.reindex(false);
      const status = await index.status();
      assert.equal(status.pages, 1);
      assert.equal(status.schemaVersion, SCHEMA_VERSION);
      assert.equal(status.backend, "fts5");
      assert.equal(status.gitHead, "head1");
    } finally {
      index.close();
    }
  });

  // -- uncommittedPages (#496) ----------------------------------------------
  // Pages on disk the index does not hold — what search could return if they
  // were committed. Each case builds a real vault, since the git walk decides
  // what HEAD holds and no fake reproduces that.

  const writeFile = (root: string, ref: string, text: string): void => {
    const p = path.join(root, ...ref.split("/"));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, text);
  };

  /** A page body that `newPageRecord` accepts, so it indexes rather than skips. */
  const pageText = (title: string): string =>
    page(title, "s", `${title} body`, [], "source_date: 2026-01-01\n");

  /**
   * A fresh temp vault with `refs` committed at HEAD, plus the git seam so a
   * test can commit a further change. The caller removes `root`.
   */
  const committedVault = async (
    refs: string[],
  ): Promise<{ root: string; git: VaultGit }> => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "searchindex-test-"));
    for (const ref of refs) {
      writeFile(root, ref, pageText(path.basename(ref, ".md")));
    }
    const git = new VaultGit(root);
    await git.init();
    await git.add(["wiki"]);
    await git.commit("seed vault");
    return { root, git };
  };

  it("reports 0 uncommitted pages on a clean tree", async () => {
    const { root, git } = await committedVault([
      "wiki/concepts/a.md",
      "wiki/concepts/b.md",
    ]);
    try {
      const index = await Index.openWithGit(root, git);
      try {
        await index.reindex(true);
        const status = await index.status();
        assert.equal(status.pages, 2, "both committed pages indexed");
        assert.equal(
          status.uncommittedPages,
          0,
          "every page on disk is committed and indexed",
        );
      } finally {
        index.close();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("counts an uncommitted page as one search could return if committed", async () => {
    const { root, git } = await committedVault(["wiki/concepts/a.md"]);
    try {
      const index = await Index.openWithGit(root, git);
      try {
        await index.reindex(true);
        writeFile(root, "wiki/concepts/draft.md", pageText("draft"));
        const status = await index.status();
        assert.equal(
          status.uncommittedPages,
          1,
          "the draft is on disk and the index does not hold it",
        );
      } finally {
        index.close();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports 0 for an uncommitted deletion — no page search could newly return", async () => {
    const { root, git } = await committedVault([
      "wiki/concepts/a.md",
      "wiki/concepts/b.md",
    ]);
    try {
      const index = await Index.openWithGit(root, git);
      try {
        await index.reindex(true);
        // `a.md` is committed at HEAD and still indexed, but gone from disk.
        fs.rmSync(path.join(root, "wiki/concepts/a.md"));
        const status = await index.status();
        assert.equal(
          status.uncommittedPages,
          0,
          "a page missing from disk is not a page search could return",
        );
      } finally {
        index.close();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not let a committed deletion cancel an uncommitted addition (#496)", async () => {
    // The cancelling case: a committed deletion plus an uncommitted addition is
    // 2 on disk - 2 indexed = 0 by subtraction, but 1 by set difference. The
    // index stays at the HEAD it accounted for — `status` does not sync.
    const { root, git } = await committedVault([
      "wiki/concepts/a.md",
      "wiki/concepts/b.md",
    ]);
    try {
      const index = await Index.openWithGit(root, git);
      try {
        await index.reindex(true);
        assert.equal(
          (await index.status()).pages,
          2,
          "precondition: both seeded pages are indexed",
        );

        // Commit the deletion but leave the index at the HEAD it accounted for.
        fs.rmSync(path.join(root, "wiki/concepts/a.md"));
        await git.add(["wiki"]);
        await git.commit("delete a");
        const head = await git.committedPages("");
        assert.deepEqual(
          head.pages.map((p) => p.pageRef).sort(),
          ["wiki/concepts/b.md"],
          "precondition: the deletion is committed — HEAD no longer carries a.md",
        );
        assert.equal(
          (await index.status()).pages,
          2,
          "precondition: the index still holds the deleted page",
        );

        // An uncommitted addition on top.
        writeFile(root, "wiki/concepts/draft.md", pageText("draft"));

        const status = await index.status();
        assert.equal(
          status.uncommittedPages,
          1,
          "the draft survives a committed deletion that cancels it by count",
        );
      } finally {
        index.close();
      }
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// TagCounts
// ---------------------------------------------------------------------------

describe("tagCounts", () => {
  it("returns tags ordered by count desc, name asc", async () => {
    const fake = fakeAtHead(
      "head1",
      pageChange(
        "wiki/concepts/a.md",
        "A",
        "s",
        "body",
        ["shared", "alpha"],
        "",
        "",
      ),
      pageChange(
        "wiki/concepts/b.md",
        "B",
        "s",
        "body",
        ["shared", "beta"],
        "",
        "",
      ),
    );
    const index = await openIndex(fake);
    try {
      const counts = await index.tagCounts();
      assert.deepEqual(counts, [
        { tag: "shared", count: 2 },
        { tag: "alpha", count: 1 },
        { tag: "beta", count: 1 },
      ]);
    } finally {
      index.close();
    }
  });
});

// ---------------------------------------------------------------------------
// whole-vault read surface
// ---------------------------------------------------------------------------

describe("indexedPages", () => {
  it("folds tags in and drops the excluded kinds", async () => {
    const fake = fakeAtHead(
      "head1",
      pageChange(
        "wiki/concepts/a.md",
        "A",
        "s",
        "body",
        ["one", "two"],
        "",
        "",
      ),
      pageChange("wiki/entities/b.md", "B", "s", "body", ["one"], "", ""),
      pageChange("wiki/tools/c.md", "C", "s", "body", [], "", ""),
    );
    const index = await openIndex(fake);
    try {
      const pages = await index.indexedPages(["entity", "source", "synthesis"]);
      assert.deepEqual(pages, [
        {
          pageRef: "wiki/concepts/a.md",
          title: "A",
          kind: "concept",
          tags: ["one", "two"],
        },
        { pageRef: "wiki/tools/c.md", title: "C", kind: "tool", tags: [] },
      ]);
    } finally {
      index.close();
    }
  });
});

describe("sharedTagPairs", () => {
  it("ranks pairs by shared-tag count and honours the kind scope", async () => {
    const fake = fakeAtHead(
      "head1",
      pageChange("wiki/concepts/a.md", "A", "s", "body", ["x", "y"], "", ""),
      pageChange("wiki/concepts/b.md", "B", "s", "body", ["x", "y"], "", ""),
      pageChange("wiki/concepts/c.md", "C", "s", "body", ["z"], "", ""),
      pageChange("wiki/concepts/e.md", "E", "s", "body", ["z"], "", ""),
      pageChange("wiki/concepts/f.md", "F", "s", "body", ["z"], "", ""),
      // Overlaps every concept but is out of scope.
      pageChange(
        "wiki/entities/d.md",
        "D",
        "s",
        "body",
        ["x", "y", "z"],
        "",
        "",
      ),
    );
    const index = await openIndex(fake);
    try {
      const pairs = await index.sharedTagPairs([
        "entity",
        "source",
        "synthesis",
      ]);
      assert.deepEqual(pairs, [
        {
          a: "wiki/concepts/a.md",
          b: "wiki/concepts/b.md",
          sharedTags: ["x", "y"],
        },
        {
          a: "wiki/concepts/c.md",
          b: "wiki/concepts/e.md",
          sharedTags: ["z"],
        },
        {
          a: "wiki/concepts/c.md",
          b: "wiki/concepts/f.md",
          sharedTags: ["z"],
        },
        {
          a: "wiki/concepts/e.md",
          b: "wiki/concepts/f.md",
          sharedTags: ["z"],
        },
      ]);
    } finally {
      index.close();
    }
  });
});

// ---------------------------------------------------------------------------
// git_date filter
// ---------------------------------------------------------------------------

describe("git_date filter", () => {
  it("bounds on backdated commits", async () => {
    const fake = fakeAtHead(
      "head1",
      pageChange(
        "wiki/concepts/old.md",
        "old",
        "s",
        "shared body",
        [],
        "",
        "2020-01-01",
      ),
      pageChange(
        "wiki/concepts/new.md",
        "new",
        "s",
        "shared body",
        [],
        "",
        "2026-06-01",
      ),
      pageChange(
        "wiki/concepts/nodatemd.md",
        "nodate",
        "s",
        "shared body",
        [],
        "",
        "",
      ),
    );
    const index = await openIndex(fake);
    try {
      const hits = await index.search({
        text: "shared",
        dateField: "git_date",
        since: "2026-01-01",
      });
      assert.deepEqual(refsOf(hits), ["wiki/concepts/new.md"]);

      const allHits = await index.search({ text: "shared" });
      assert.equal(allHits.length, 3, "unbounded returns all three");

      const byRef = new Map(allHits.map((h) => [h.pageRef, h]));
      assert.equal(byRef.get("wiki/concepts/old.md")?.gitDate, "2020-01-01");
      assert.equal(byRef.get("wiki/concepts/nodatemd.md")?.gitDate, null);
    } finally {
      index.close();
    }
  });
});
