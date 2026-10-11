/**
 * SQLite FTS5 lexical index for a vault. A materialised view of HEAD's wiki/
 * tree (ADR-0015), with one working-tree input: a folder's `KIND.md`-declared
 * kind, which no snapshot carries (ADR-0027). No WAL (ADR-0006).
 */

import nodeSqlite3Wasm from "node-sqlite3-wasm";
import type { Database as DatabaseType } from "node-sqlite3-wasm";
// node-sqlite3-wasm is CJS. A static default import lets esbuild inline it into
// the bundle; a runtime createRequire would fail with no node_modules packaged.
const { Database } = nodeSqlite3Wasm as unknown as {
  Database: typeof import("node-sqlite3-wasm").Database;
};
import fs from "node:fs";
import path from "node:path";
import { mkdirSafe } from "./fsutil.js";
import type { Git, Snapshot, PageChange } from "./vaultgit.js";

// Page metadata comes from pagerecord, the one reader of the frontmatter schema.
import { newPageRecord, supersedes as supersedesOf } from "./pagerecord.js";
import type { PageRecord } from "./pagerecord.js";
import { semanticFingerprint } from "./fingerprint.js";
import { splitFrontmatter } from "./wikipage.js";
import { enumeratePageRefs } from "./pagepredicate.js";
import { kindByFolder } from "./kindmeta.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export const SCHEMA_VERSION = "6";

/** The `meta` key holding the working tree's folder → kind map, compared to
 * force a rebuild when a declaration changes. */
const KIND_DECLARATIONS_KEY = "kind_declarations";

/** One search result. Score is higher-is-better (bm25() negated). */
export interface Hit {
  pageRef: string;
  score: number;
  title: string;
  summary: string;
  tags: string[];
  kind: string;
  sourceDate: string;
  gitDate: string | null;
  volatility: string;
  supersededBy: string | null;
  snippet: string | null;
}

/** One page the index could not hold, with the parser's reason. */
export interface SkippedPage {
  pageRef: string;
  reason: string;
}

export interface Stats {
  pages: number;
  inserted: number;
  updated: number;
  removed: number;
  skipped: SkippedPage[];
  durationMs: number;
}

export interface Status {
  pages: number;
  dbSizeBytes: number;
  backend: string;
  schemaVersion: string;
  gitHead: string;
  uncommittedPages: number;
  unindexedPages: SkippedPage[];
}

export interface Query {
  text?: string;
  raw?: boolean;
  tagsAll?: string[];
  tagsAny?: string[];
  kinds?: string[];
  since?: string;
  until?: string;
  dateField?: string;
  volatility?: string[];
  includeSuperseded?: boolean;
  limit?: number;
}

export interface TagCount {
  tag: string;
  count: number;
}

/** One indexed page with its tag set folded in. */
export interface IndexedPage {
  pageRef: string;
  title: string;
  kind: string;
  tags: string[];
}

/** A pair of indexed pages sharing at least one tag, with the shared tags. */
export interface SharedTagPair {
  a: string;
  b: string;
  sharedTags: string[];
}

/** One indexed page's HEAD-blob identity (ADR-0028): the object ID a
 * Consolidation exclusion's fast path matches, and the semantic fingerprint its
 * fallback compares. Both ride in the row the index pass already parsed. */
export interface PageFact {
  pageRef: string;
  blobOid: string;
  fingerprint: string;
}

/** SQL `GROUP_CONCAT` separator; char 31 cannot occur in a tag or page ref. */
const GROUP_SEPARATOR = String.fromCharCode(31);
const GROUP_SEPARATOR_SQL = "char(31)";

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const BM25_WEIGHTS = "0.0,10.0,5.0,1.0";
const BACKEND_NAME = "fts5";

const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);
CREATE TABLE IF NOT EXISTS page (
    page_ref      TEXT PRIMARY KEY,
    title         TEXT,
    summary       TEXT,
    kind          TEXT,
    source_date   TEXT,
    git_date      TEXT,
    volatility    TEXT,
    supersedes    TEXT,
    superseded_by TEXT,
    blob_oid      TEXT,
    fingerprint   TEXT
);
CREATE TABLE IF NOT EXISTS page_tag (
    page_ref TEXT,
    tag TEXT,
    PRIMARY KEY (page_ref, tag)
);
CREATE INDEX IF NOT EXISTS ix_page_tag_tag ON page_tag(tag);
CREATE VIRTUAL TABLE IF NOT EXISTS page_fts USING fts5(
    page_ref UNINDEXED, title, summary, body,
    tokenize = 'porter unicode61'
);
`;

// ---------------------------------------------------------------------------
// Kind declaration key (ADR-0027)
// ---------------------------------------------------------------------------

/** The canonical form of a folder → kind map, compared to detect a declaration
 * change. Whole-map rather than a digest: declarations are few and this makes
 * the `meta` row debuggable. */
function kindDeclarationsKey(map: Record<string, string>): string {
  return JSON.stringify(
    Object.entries(map).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

// ---------------------------------------------------------------------------
// Page parsing
// ---------------------------------------------------------------------------

/** One page's record, or the parser's reason for refusing it — the single
 * classification the reindex walk and the on-disk diff both use. */
function parsePageRecord(
  pageRef: string,
  content: string,
  kindByFolder: Record<string, string>,
): { ok: true; record: PageRecord } | { ok: false; reason: string } {
  try {
    return { ok: true, record: newPageRecord(pageRef, content, kindByFolder) };
  } catch (err) {
    return { ok: false, reason: reasonOf(err, pageRef) };
  }
}

/** The parser names the ref at the head of every refusal, and its YAML detail
 * spans lines; the caller carries the ref and prints one line. */
function reasonOf(err: unknown, pageRef: string): string {
  const message = (err instanceof Error ? err.message : String(err))
    .replace(/\s+/g, " ")
    .trim();
  for (const prefix of [`"${pageRef}": `, `${pageRef}: `]) {
    if (message.startsWith(prefix)) return message.slice(prefix.length);
  }
  return message;
}

// ---------------------------------------------------------------------------
// Index
// ---------------------------------------------------------------------------

export class Index {
  /** Refs this index's passes could not hold, retained across them — a ref
   * leaves only when a later pass indexes or removes it. */
  private readonly skippedRefs = new Map<string, SkippedPage>();

  private constructor(
    private readonly root: string,
    private readonly dbPath: string,
    private readonly db: DatabaseType,
    private readonly git: Git,
    private kindByFolder: Record<string, string>,
  ) {}

  /**
   * Open (creating if needed) the index at root. Throws when root has no git
   * repository of its own; a work tree with no commits is an empty index, not
   * an error.
   */
  static async open(root: string): Promise<Index> {
    const { VaultGit } = await import("./vaultgit.js");
    const git = new VaultGit(root);
    if (!(await git.isWorkTree())) {
      throw new Error(
        `${root} has no git repository of its own (it may sit inside one); a vault is a git repository — run \`enchiridion init <root> --mode …\` to convert it`,
      );
    }
    return Index.openWithGit(root, git);
  }

  /** Open with a substituted Git surface — the test seam. */
  static async openWithGit(root: string, git: Git): Promise<Index> {
    const indexDir = path.join(root, ".wiki-knowledge");
    mkdirSafe(indexDir);
    const dbPath = path.join(indexDir, "index.db");
    const db = new Database(dbPath);
    const index = new Index(root, dbPath, db, git, kindByFolder(root));
    index.createSchema();
    // A schema bump or an edited declaration both strand the `kind` column, so
    // either one rebuilds from HEAD (ADR-0027).
    if (!index.schemaOk() || !index.kindDeclarationsMatch()) {
      await index.rebuildFull();
    }
    return index;
  }

  /** Open an in-memory index (for tests). */
  static async openInMemory(git: Git): Promise<Index> {
    const db = new Database();
    const index = new Index(":memory:", ":memory:", db, git, {});
    index.createSchema();
    if (!index.schemaOk()) {
      await index.rebuildFull();
    }
    return index;
  }

  close(): void {
    this.db.close();
  }

  // -------------------------------------------------------------------------
  // Schema lifecycle
  // -------------------------------------------------------------------------

  private createSchema(): void {
    this.db.exec(SCHEMA_DDL);
    this.db.run(
      "INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', ?)",
      [SCHEMA_VERSION],
    );
  }

  private schemaOk(): boolean {
    const row = this.db.get(
      "SELECT value FROM meta WHERE key = 'schema_version'",
    ) as { value: string } | null;
    return row?.value === SCHEMA_VERSION;
  }

  private kindDeclarationsMatch(): boolean {
    const row = this.db.get("SELECT value FROM meta WHERE key = ?", [
      KIND_DECLARATIONS_KEY,
    ]) as { value: string } | null;
    return row?.value === kindDeclarationsKey(this.kindByFolder);
  }

  private setKindDeclarationsKey(): void {
    this.db.run("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)", [
      KIND_DECLARATIONS_KEY,
      kindDeclarationsKey(this.kindByFolder),
    ]);
  }

  /** Re-read the working tree's declarations; true when the map changed, in
   * which case the `kind` column is stale and only a full rebuild fixes it. */
  private kindDeclarationsChanged(): boolean {
    if (this.root === ":memory:") return false;
    const fresh = kindByFolder(this.root);
    if (kindDeclarationsKey(fresh) === kindDeclarationsKey(this.kindByFolder)) {
      return false;
    }
    this.kindByFolder = fresh;
    return true;
  }

  // -------------------------------------------------------------------------
  // Core index walk
  // -------------------------------------------------------------------------

  async reindex(full: boolean): Promise<Stats> {
    const start = Date.now();
    let stats: Stats;
    if (full || this.kindDeclarationsChanged()) {
      stats = await this.rebuildFull();
    } else {
      // Forced range walk; unlike sync(), never short-circuits on HEAD == watermark.
      const watermark = this.watermark();
      const snap = await this.git.committedPages(watermark);
      stats = await this.apply(snap);
    }
    stats.skipped = this.withUnindexedOnDisk(stats.skipped);
    stats.durationMs = Date.now() - start;
    return stats;
  }

  /** This pass's skips plus the refs on disk the index cannot hold, deduped —
   * so a page an earlier pass dropped is named too, not silently absent. */
  private withUnindexedOnDisk(skipped: SkippedPage[]): SkippedPage[] {
    if (this.root === ":memory:") return skipped;
    const named = new Set(skipped.map((s) => s.pageRef));
    return [
      ...skipped,
      ...this.unindexedOnDisk().unindexed.filter((p) => !named.has(p.pageRef)),
    ];
  }

  private async sync(): Promise<Stats> {
    if (this.kindDeclarationsChanged()) return this.rebuildFull();
    const watermark = this.watermark();
    const snap = await this.git.committedPages(watermark);
    if (snap.head === watermark && !snap.fullRebuild) {
      return {
        pages: this.countPages(),
        inserted: 0,
        updated: 0,
        removed: 0,
        skipped: [],
        durationMs: 0,
      };
    }
    return this.apply(snap);
  }

  private async rebuildFull(): Promise<Stats> {
    const snap = await this.git.committedPages("");
    return this.apply(snap);
  }

  private async apply(snap: Snapshot): Promise<Stats> {
    let stats: Stats;
    if (snap.fullRebuild) {
      stats = this.applyFullRebuild(snap);
    } else {
      stats = this.applyDelta(snap);
    }
    this.setWatermark(snap.head);
    return stats;
  }

  private applyFullRebuild(snap: Snapshot): Stats {
    // Delete-and-rebuild is the migration strategy; never in-place ALTER.
    this.db.exec(`
      DROP TABLE IF EXISTS meta;
      DROP TABLE IF EXISTS page_tag;
      DROP TABLE IF EXISTS page;
      DROP TABLE IF EXISTS page_fts;
    `);
    this.createSchema();
    this.setKindDeclarationsKey();
    this.skippedRefs.clear();
    let inserted = 0;
    const skipped: SkippedPage[] = [];
    for (const page of snap.pages) {
      const skippedPage = this.upsertPage(page);
      if (skippedPage === null) inserted++;
      else skipped.push(skippedPage);
    }
    this.recomputeSupersededBy();
    const pages = this.countPages();
    return { pages, inserted, updated: 0, removed: 0, skipped, durationMs: 0 };
  }

  private applyDelta(snap: Snapshot): Stats {
    let inserted = 0;
    let updated = 0;
    let removed = 0;
    const skipped: SkippedPage[] = [];
    for (const page of snap.pages) {
      if (page.deleted) {
        this.removePage(page.pageRef);
        this.skippedRefs.delete(page.pageRef);
        removed++;
        continue;
      }
      const existed = this.pageIndexed(page.pageRef);
      const skippedPage = this.upsertPage(page);
      if (skippedPage !== null) {
        skipped.push(skippedPage);
        // Malformed page skipped; if it was indexed, count the drop as a removal.
        if (existed) removed++;
        continue;
      }
      if (existed) updated++;
      else inserted++;
    }
    this.recomputeSupersededBy();
    const pages = this.countPages();
    return { pages, inserted, updated, removed, skipped, durationMs: 0 };
  }

  private countPages(): number {
    const row = this.db.get("SELECT COUNT(*) AS n FROM page") as { n: number };
    return row?.n ?? 0;
  }

  private pageIndexed(pageRef: string): boolean {
    const row = this.db.get(
      "SELECT COUNT(*) AS n FROM page WHERE page_ref = ?",
      [pageRef],
    ) as { n: number };
    return (row?.n ?? 0) > 0;
  }

  // -------------------------------------------------------------------------
  // Watermark
  // -------------------------------------------------------------------------

  private watermark(): string {
    const row = this.db.get(
      "SELECT value FROM meta WHERE key = 'git_head'",
    ) as { value: string } | null;
    return row?.value ?? "";
  }

  private setWatermark(head: string): void {
    this.db.run(
      "INSERT OR REPLACE INTO meta(key, value) VALUES ('git_head', ?)",
      [head],
    );
  }

  // -------------------------------------------------------------------------
  // Per-page upsert / remove
  // -------------------------------------------------------------------------

  /** Index one page, or return the skip naming why, having removed any stale
   * row. Malformed pages are skipped, never a crash, so one buried in git
   * history cannot take down a reindex. */
  private upsertPage(page: PageChange): SkippedPage | null {
    const parsed = parsePageRecord(
      page.pageRef,
      page.content,
      this.kindByFolder,
    );
    if (!parsed.ok) {
      this.removePage(page.pageRef);
      const skippedPage = { pageRef: page.pageRef, reason: parsed.reason };
      this.skippedRefs.set(page.pageRef, skippedPage);
      return skippedPage;
    }
    const rec = parsed.record;
    const body = splitFrontmatter(page.content).body;
    const supersedes = supersedesOf(rec) ?? [];

    for (const stmt of [
      "DELETE FROM page WHERE page_ref = ?",
      "DELETE FROM page_tag WHERE page_ref = ?",
      "DELETE FROM page_fts WHERE page_ref = ?",
    ]) {
      this.db.run(stmt, [page.pageRef]);
    }

    this.db.run(
      `INSERT INTO page(page_ref, title, summary, kind, source_date,
          git_date, volatility, supersedes, superseded_by, blob_oid, fingerprint)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
      [
        page.pageRef,
        rec.title,
        rec.summary,
        rec.kind,
        rec.sourceDate,
        page.date || null,
        rec.volatility,
        JSON.stringify(supersedes),
        page.oid || null,
        semanticFingerprint(rec, body),
      ],
    );
    for (const tag of rec.tags) {
      this.db.run(
        "INSERT OR IGNORE INTO page_tag(page_ref, tag) VALUES (?, ?)",
        [page.pageRef, tag],
      );
    }
    this.db.run(
      "INSERT INTO page_fts(page_ref, title, summary, body) VALUES (?, ?, ?, ?)",
      [page.pageRef, rec.title, rec.summary, body],
    );
    this.skippedRefs.delete(page.pageRef);
    return null;
  }

  private removePage(pageRef: string): void {
    for (const stmt of [
      "DELETE FROM page WHERE page_ref = ?",
      "DELETE FROM page_tag WHERE page_ref = ?",
      "DELETE FROM page_fts WHERE page_ref = ?",
    ]) {
      this.db.run(stmt, [pageRef]);
    }
  }

  private recomputeSupersededBy(): void {
    this.db.run("UPDATE page SET superseded_by = NULL");
    const rows = this.db.all(
      "SELECT page_ref, supersedes FROM page WHERE supersedes IS NOT NULL",
    ) as { page_ref: string; supersedes: string }[];
    for (const row of rows) {
      let targets: string[];
      try {
        targets = JSON.parse(row.supersedes);
      } catch {
        continue;
      }
      for (const target of targets) {
        this.db.run(
          "UPDATE page SET superseded_by = ? WHERE page_ref = ? AND superseded_by IS NULL",
          [row.page_ref, target],
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // Public read API
  // -------------------------------------------------------------------------

  async status(): Promise<Status> {
    const pages = this.countPages();
    let dbSizeBytes = 0;
    if (this.dbPath !== ":memory:") {
      try {
        const stat = fs.statSync(this.dbPath);
        dbSizeBytes = stat.size;
      } catch {
        // file might not exist if no writes yet
      }
    }
    const schemaRow = this.db.get(
      "SELECT value FROM meta WHERE key = 'schema_version'",
    ) as { value: string } | null;
    const gitHead = this.watermark();

    let uncommittedPages = 0;
    let unindexedPages: SkippedPage[] = [];
    if (this.root !== ":memory:") {
      const split = this.unindexedOnDisk();
      uncommittedPages = split.uncommitted;
      unindexedPages = split.unindexed;
    }

    return {
      pages,
      dbSizeBytes,
      backend: BACKEND_NAME,
      schemaVersion: schemaRow?.value ?? "",
      gitHead,
      uncommittedPages,
      unindexedPages,
    };
  }

  /** Refs on disk the index does not hold, split by whether their on-disk
   * content parses: an unparsable page is unindexed, the rest uncommitted. */
  private unindexedOnDisk(): { unindexed: SkippedPage[]; uncommitted: number } {
    // Deliberately a one-sided set difference, not a subtraction of counts:
    // a committed deletion would otherwise cancel an uncommitted addition.
    const indexed = new Set(
      (this.db.all("SELECT page_ref FROM page") as { page_ref: string }[]).map(
        (row) => row.page_ref,
      ),
    );
    const unindexed: SkippedPage[] = [];
    let uncommitted = 0;
    for (const ref of enumeratePageRefs(this.root)) {
      if (indexed.has(ref)) continue;
      const skippedPage = this.onDiskFailure(ref);
      if (skippedPage === null) uncommitted++;
      else unindexed.push(skippedPage);
    }
    return { unindexed, uncommitted };
  }

  private onDiskFailure(pageRef: string): SkippedPage | null {
    let content: string;
    try {
      content = fs.readFileSync(
        path.join(this.root, ...pageRef.split("/")),
        "utf8",
      );
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      return {
        pageRef,
        reason: code ? `cannot be read (${code})` : "cannot be read",
      };
    }
    const parsed = parsePageRecord(pageRef, content, this.kindByFolder);
    return parsed.ok ? null : { pageRef, reason: parsed.reason };
  }

  async tagCounts(): Promise<TagCount[]> {
    await this.sync();
    const rows = this.db.all(
      "SELECT tag, COUNT(*) AS n FROM page_tag GROUP BY tag ORDER BY n DESC, tag ASC",
    ) as { tag: string; n: number }[];
    return rows.map((r) => ({ tag: r.tag, count: r.n }));
  }

  /** Every indexed page whose kind is in `includeKinds`, with its tag set. An
   * empty include-list names no kind, so it matches nothing — never everything.
   * A view of HEAD (ADR-0015), so an uncommitted page is invisible (ADR-0021). */
  async indexedPages(includeKinds: string[]): Promise<IndexedPage[]> {
    await this.sync();
    if (includeKinds.length === 0) return [];
    const rows = this.db.all(
      `SELECT p.page_ref, p.title, p.kind,
              (SELECT GROUP_CONCAT(t.tag, ${GROUP_SEPARATOR_SQL})
                 FROM page_tag t WHERE t.page_ref = p.page_ref) AS tags
       FROM page p WHERE p.kind IN (${placeholders(includeKinds.length)})
       ORDER BY p.page_ref`,
      includeKinds as import("node-sqlite3-wasm").JSValue[],
    ) as unknown as {
      page_ref: string;
      title: string | null;
      kind: string | null;
      tags: string | null;
    }[];
    return rows.map((r) => ({
      pageRef: r.page_ref,
      title: r.title ?? "",
      kind: r.kind ?? "",
      tags: r.tags ? r.tags.split(GROUP_SEPARATOR).sort() : [],
    }));
  }

  /** The HEAD-blob facts for the named pages, keyed by page ref. A page the
   * index does not hold (deleted, malformed, or never committed) is simply
   * absent — the caller reads that as "cannot be read at HEAD". */
  async pageFacts(pageRefs: string[]): Promise<Map<string, PageFact>> {
    await this.sync();
    const facts = new Map<string, PageFact>();
    if (pageRefs.length === 0) return facts;
    const rows = this.db.all(
      `SELECT page_ref, blob_oid, fingerprint FROM page
       WHERE page_ref IN (${placeholders(pageRefs.length)})`,
      pageRefs as import("node-sqlite3-wasm").JSValue[],
    ) as unknown as {
      page_ref: string;
      blob_oid: string | null;
      fingerprint: string | null;
    }[];
    for (const row of rows) {
      facts.set(row.page_ref, {
        pageRef: row.page_ref,
        blobOid: row.blob_oid ?? "",
        fingerprint: row.fingerprint ?? "",
      });
    }
    return facts;
  }

  /** Pairs of in-scope pages sharing at least one tag, most-shared first — an
   * exact-match tag count over `page_tag` (ADR-0021). An empty include-list
   * matches nothing. */
  async sharedTagPairs(includeKinds: string[]): Promise<SharedTagPair[]> {
    await this.sync();
    if (includeKinds.length === 0) return [];
    const rows = this.db.all(
      `SELECT t1.page_ref AS a, t2.page_ref AS b,
              GROUP_CONCAT(t1.tag, ${GROUP_SEPARATOR_SQL}) AS tags
       FROM page_tag t1
       JOIN page_tag t2 ON t1.tag = t2.tag AND t1.page_ref < t2.page_ref
       JOIN page p1 ON p1.page_ref = t1.page_ref
       JOIN page p2 ON p2.page_ref = t2.page_ref
       WHERE p1.kind IN (${placeholders(includeKinds.length)})
         AND p2.kind IN (${placeholders(includeKinds.length)})
       GROUP BY t1.page_ref, t2.page_ref
       ORDER BY COUNT(*) DESC, a, b`,
      [
        ...includeKinds,
        ...includeKinds,
      ] as import("node-sqlite3-wasm").JSValue[],
    ) as unknown as { a: string; b: string; tags: string }[];
    return rows.map((r) => ({
      a: r.a,
      b: r.b,
      sharedTags: r.tags.split(GROUP_SEPARATOR).sort(),
    }));
  }

  /** The refs this index's passes could not hold — empty on a clean vault, and
   * still populated when the search's own pass walked nothing (ADR-0015). */
  skippedPages(): SkippedPage[] {
    return [...this.skippedRefs.values()].sort((a, b) =>
      a.pageRef.localeCompare(b.pageRef),
    );
  }

  async search(q: Query): Promise<Hit[]> {
    await this.sync();

    const { where, params, err } = buildMetadataWhere(q);
    if (err) throw new Error(err);

    const limit = q.limit && q.limit > 0 ? q.limit : 20;

    let matchExpr = q.text ?? "";
    if (!q.raw) matchExpr = tokenizeQuery(matchExpr);

    if (!matchExpr) {
      return this.queryMetadataOnly(where, params, limit);
    }
    return this.queryFts(matchExpr, where, params, limit);
  }

  private queryMetadataOnly(
    where: string,
    params: unknown[],
    limit: number,
  ): Hit[] {
    const rows = this.db.all(
      `SELECT p.page_ref, 0.0 AS score, p.title, p.summary, p.kind,
              p.source_date, p.git_date, p.volatility, p.superseded_by
       FROM page p WHERE ${where} ORDER BY p.page_ref LIMIT ?`,
      [...params, limit] as import("node-sqlite3-wasm").JSValue[],
    ) as unknown as RawPageRow[];

    return rows.map((r) => ({
      pageRef: r.page_ref,
      score: 0,
      title: r.title ?? "",
      summary: r.summary ?? "",
      tags: [],
      kind: r.kind ?? "",
      sourceDate: r.source_date ?? "",
      gitDate: r.git_date ?? null,
      volatility: r.volatility ?? "",
      supersededBy: r.superseded_by ?? null,
      snippet: null,
    }));
  }

  private queryFts(
    matchExpr: string,
    where: string,
    params: unknown[],
    limit: number,
  ): Hit[] {
    const args = [
      matchExpr,
      ...params,
      limit,
    ] as import("node-sqlite3-wasm").JSValue[];
    let rows: RawFtsRow[];
    try {
      rows = this.db.all(
        `SELECT p.page_ref, bm25(page_fts, ${BM25_WEIGHTS}) AS raw_score,
                p.title, p.summary, p.kind,
                p.source_date, p.git_date, p.volatility, p.superseded_by,
                snippet(page_fts, 3, '', '', '…', 12) AS snip
         FROM page_fts
         JOIN page p ON p.page_ref = page_fts.page_ref
         WHERE page_fts MATCH ? AND ${where}
         ORDER BY raw_score LIMIT ?`,
        args,
      ) as unknown as RawFtsRow[];
    } catch (err) {
      // FTS5 rejects a malformed MATCH at prepare time; --raw is the escape
      // hatch, so an unguarded throw hands the agent a bare `fts5: syntax error`.
      throw new Error(
        `search: the query is not a valid FTS5 expression: ${
          err instanceof Error ? err.message : String(err)
        } — simplify the query, or pass --raw with a valid FTS5 MATCH expression`,
        { cause: err },
      );
    }

    const hits: Hit[] = rows.map((r) => ({
      pageRef: r.page_ref,
      score: -(r.raw_score as number),
      title: r.title ?? "",
      summary: r.summary ?? "",
      tags: [],
      kind: r.kind ?? "",
      sourceDate: r.source_date ?? "",
      gitDate: r.git_date ?? null,
      volatility: r.volatility ?? "",
      supersededBy: r.superseded_by ?? null,
      snippet: r.snip ?? null,
    }));

    for (const hit of hits) {
      hit.tags = this.tagsFor(hit.pageRef);
    }
    return hits;
  }

  private tagsFor(pageRef: string): string[] {
    const rows = this.db.all(
      "SELECT tag FROM page_tag WHERE page_ref = ? ORDER BY tag",
      [pageRef],
    ) as { tag: string }[];
    return rows.map((r) => r.tag);
  }
}

// ---------------------------------------------------------------------------
// Query builder
// ---------------------------------------------------------------------------

interface WhereResult {
  where: string;
  params: unknown[];
  err: string | null;
}

function buildMetadataWhere(q: Query): WhereResult {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (!q.includeSuperseded) {
    clauses.push("p.superseded_by IS NULL");
  }
  for (const tag of q.tagsAll ?? []) {
    clauses.push(
      "EXISTS (SELECT 1 FROM page_tag t WHERE t.page_ref = p.page_ref AND t.tag = ?)",
    );
    params.push(tag);
  }
  if ((q.tagsAny ?? []).length > 0) {
    clauses.push(
      `EXISTS (SELECT 1 FROM page_tag t WHERE t.page_ref = p.page_ref AND t.tag IN (${placeholders(q.tagsAny!.length)}))`,
    );
    params.push(...q.tagsAny!);
  }
  if ((q.kinds ?? []).length > 0) {
    clauses.push(`p.kind IN (${placeholders(q.kinds!.length)})`);
    params.push(...q.kinds!);
  }

  const dateField = q.dateField || "source_date";
  if (dateField !== "source_date" && dateField !== "git_date") {
    return {
      where: "1=1",
      params: [],
      err: `date_field must be 'source_date' or 'git_date', got '${dateField}'`,
    };
  }
  if (q.since) {
    clauses.push(`p.${dateField} >= ?`);
    params.push(q.since);
  }
  if (q.until) {
    clauses.push(`p.${dateField} <= ?`);
    params.push(q.until);
  }
  if ((q.volatility ?? []).length > 0) {
    clauses.push(`p.volatility IN (${placeholders(q.volatility!.length)})`);
    params.push(...q.volatility!);
  }

  return {
    where: clauses.length > 0 ? clauses.join(" AND ") : "1=1",
    params,
    err: null,
  };
}

/** Phrase-quote each whitespace-separated token for FTS5 MATCH. */
export function tokenizeQuery(text: string): string {
  if (!text.trim()) return "";
  return text
    .trim()
    .split(/\s+/)
    .map((t) => `"${t.replace(/"/g, '\\"')}"`)
    .join(" ");
}

function placeholders(n: number): string {
  return Array(n).fill("?").join(", ");
}

// ---------------------------------------------------------------------------
// Row types (internal)
// ---------------------------------------------------------------------------

interface RawPageRow {
  page_ref: string;
  title: string | null;
  summary: string | null;
  kind: string | null;
  source_date: string | null;
  git_date: string | null;
  volatility: string | null;
  superseded_by: string | null;
}

interface RawFtsRow extends RawPageRow {
  raw_score: number;
  snip: string | null;
}
