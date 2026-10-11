/**
 * The search command group: the lexical-index query plus its index management
 * (--reindex, --full, --status). Registers itself against the shared program.
 */

import type { Command } from "commander";
import {
  Index,
  type Hit,
  type Query,
  type SkippedPage,
} from "./searchindex.js";
import { Volatilities } from "./pagerecord.js";
import { Kinds } from "./place.js";
import { Vault, resolveRoot } from "./vault.js";
import { emitDocument, emitRows, fail } from "./output.js";
import { collectFlag, splitCommaList } from "./cliargs.js";
import { CANONICAL_DATE_FORMAT, canonicalSourceDate } from "./sourcedate.js";

/** Render "" as "-". */
function orDash(s: string): string {
  if (s === "") return "-";
  return s;
}

/** Render null or "" as "-". */
function orDashPtr(s: string | null): string {
  if (s === null) return "-";
  return orDash(s);
}

function hitRow(hit: Hit): Record<string, unknown> {
  return {
    page_ref: hit.pageRef,
    score: hit.score,
    title: hit.title,
    summary: hit.summary,
    tags: hit.tags,
    kind: hit.kind,
    source_date: hit.sourceDate,
    git_date: hit.gitDate,
    volatility: hit.volatility,
    superseded_by: hit.supersededBy,
    snippet: hit.snippet,
  };
}

function renderHits(hits: Hit[], asJSON: boolean): void {
  if (asJSON) {
    emitRows(hits.map(hitRow));
    return;
  }
  let width = 0;
  for (const hit of hits) {
    if (hit.pageRef.length > width) width = hit.pageRef.length;
  }
  for (const hit of hits) {
    console.log(
      `${hit.pageRef.padEnd(width)}  ${hit.score.toFixed(2).padStart(7)}  ${orDash(hit.title)}  [${orDash(hit.volatility)}]  src=${orDash(hit.sourceDate)}  git=${orDashPtr(hit.gitDate)}`,
    );
  }
}

function renderStatus(
  st: {
    pages: number;
    dbSizeBytes: number;
    backend: string;
    schemaVersion: string;
    gitHead: string;
    uncommittedPages: number;
    unindexedPages: SkippedPage[];
  },
  asJSON: boolean,
): void {
  if (asJSON) {
    emitDocument({
      pages: st.pages,
      db_size_bytes: st.dbSizeBytes,
      backend: st.backend,
      schema_version: st.schemaVersion,
      git_head: st.gitHead,
      uncommitted_pages: st.uncommittedPages,
      unindexed_pages: st.unindexedPages.map((p) => ({
        page_ref: p.pageRef,
        reason: p.reason,
      })),
    });
    return;
  }
  console.log(`pages:             ${st.pages}`);
  console.log(`db_size_bytes:     ${st.dbSizeBytes}`);
  console.log(`backend:           ${st.backend}`);
  console.log(`schema_version:    ${st.schemaVersion}`);
  console.log(`git_head:          ${orDash(st.gitHead)}`);
  if (st.unindexedPages.length > 0) {
    console.log(
      `unindexed_pages: ${st.unindexedPages.length} page(s) the index cannot hold:`,
    );
    for (const page of st.unindexedPages) {
      console.log(`  ${page.pageRef}: ${page.reason}`);
    }
  } else {
    console.log(`unindexed_pages: 0`);
  }
  if (st.uncommittedPages > 0) {
    console.log(
      `uncommitted_pages: ${st.uncommittedPages} page(s) on disk not yet committed — not searchable.`,
    );
  } else {
    console.log(`uncommitted_pages: 0`);
  }
}

/** Name each ref the index could not hold, on stderr, so no stdout contract —
 * the JSON-Lines query rows included — is touched. */
function renderSkipped(skipped: SkippedPage[]): void {
  for (const page of skipped) {
    console.error(`skipped ${page.pageRef}: ${page.reason}`);
  }
}

function renderReindex(
  stats: {
    pages: number;
    inserted: number;
    updated: number;
    removed: number;
    skipped: SkippedPage[];
    durationMs: number;
  },
  full: boolean,
  asJSON: boolean,
): void {
  renderSkipped(stats.skipped);
  if (asJSON) {
    emitDocument({
      pages: stats.pages,
      inserted: stats.inserted,
      updated: stats.updated,
      removed: stats.removed,
      duration_ms: stats.durationMs,
    });
    return;
  }
  const action = full ? "full reindex" : "reindex";
  console.log(
    `${action}: ${stats.pages} pages (+${stats.inserted} ~${stats.updated} -${stats.removed}) in ${stats.durationMs.toFixed(1)} ms`,
  );
}

/** A digits-only positive integer the index can bind; Number() alone accepts
 * `1e21` and `0x10`, which the index rejects with a leaked datatype mismatch. */
function positiveInteger(flag: string): (value: string) => number {
  return (value: string) => {
    const n = Number(value);
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < 1) {
      fail(`${flag} must be a positive integer, got "${value}"`);
    }
    return n;
  };
}

/** A date the index's YYYY-MM-DD columns can hold exactly, or a refusal naming
 * the flag and the value — a timestamp or a loose spelling compares wrongly. */
function calendarDate(flag: string): (value: string) => string {
  return (value: string) => {
    let canonical: string | null | undefined = null;
    try {
      canonical = canonicalSourceDate(value);
    } catch {
      // Refused below, under this flag's name rather than source_date's.
    }
    if (canonical !== value) {
      fail(
        `${flag} must be a calendar date (${CANONICAL_DATE_FORMAT}), got "${value}"`,
      );
    }
    return value;
  };
}

/** A comma-separated volatility list, refusing any value outside the
 * vocabulary — the index would otherwise match nothing, silently. */
function volatilityList(value: string): string[] {
  const values = splitCommaList(value);
  for (const v of values) {
    if (!(Volatilities as readonly string[]).includes(v)) {
      fail(`--volatility must be one of ${Volatilities.join("|")}, got "${v}"`);
    }
  }
  return values;
}

export function registerSearchCommand(program: Command): void {
  // search [text] — query the lexical index, or manage it with --reindex /
  // --status. --json emits one Hit per line, else the compact table.
  program
    .command("search [text]")
    .description("Search the wiki vault via the lexical index")
    .option(
      "--tag <tag>",
      "filter by tag; repeat for tags_all (AND) and combine with --tag-any for OR",
      collectFlag,
      [] as string[],
    )
    .option(
      "--tag-any <tag>",
      "filter by tag (OR semantics across the listed tags)",
      collectFlag,
      [] as string[],
    )
    .option(
      "--kind <kinds>",
      "filter by kind — a canonical kind or a discovered custom kind-folder; comma-separated for multiple",
      splitCommaList,
      [] as string[],
    )
    .option(
      "--since <date>",
      `calendar date (${CANONICAL_DATE_FORMAT}); inclusive lower bound on date_field`,
      calendarDate("--since"),
    )
    .option(
      "--until <date>",
      `calendar date (${CANONICAL_DATE_FORMAT}); inclusive upper bound on date_field`,
      calendarDate("--until"),
    )
    .option(
      "--date-field <field>",
      "which date the --since/--until bounds apply to (source_date|git_date)",
      (value: string) => {
        if (value !== "source_date" && value !== "git_date") {
          fail(
            `--date-field must be 'source_date' or 'git_date', got "${value}"`,
          );
        }
        return value;
      },
      "source_date",
    )
    .option(
      "--volatility <vols>",
      `filter by volatility (${Volatilities.join("|")}); comma-separated for multiple`,
      volatilityList,
      [] as string[],
    )
    .option(
      "--limit <n>",
      "max hits (a positive integer)",
      positiveInteger("--limit"),
      20,
    )
    .option(
      "--include-superseded",
      "include pages that have been superseded (default: filter them out)",
    )
    .option(
      "--exclude <ref>",
      "drop this vault-relative page ref from the results; repeatable, and --limit still counts the rows returned",
      collectFlag,
      [] as string[],
    )
    .option(
      "--raw",
      "pass the text through as a literal FTS5 expression (escape hatch)",
    )
    .option("--json", "emit results as JSON Lines (one object per line)")
    .option("--reindex", "rebuild the index")
    .option("--full", "with --reindex: wipe the index and rebuild from scratch")
    .option(
      "--status",
      "print index status and exit; unindexed_pages lists {page_ref, reason} for pages the index cannot hold",
    )
    .action(
      async (
        text: string | undefined,
        opts: {
          tag: string[];
          tagAny: string[];
          kind: string[];
          since?: string;
          until?: string;
          dateField: string;
          volatility: string[];
          limit: number;
          includeSuperseded?: boolean;
          exclude: string[];
          raw?: boolean;
          json?: boolean;
          reindex?: boolean;
          full?: boolean;
          status?: boolean;
        },
      ) => {
        const root = resolveRoot();
        if (opts.kind.length > 0) {
          // The accepted set is canonical kinds plus the vault's discovered
          // custom kinds, which only the vault can supply — so it validates
          // here, and only when a kind filter was actually asked for.
          const knownKinds = [
            ...Kinds,
            ...Object.keys(new Vault(root).discoveredKinds()),
          ];
          for (const kind of opts.kind) {
            if (!knownKinds.includes(kind)) {
              fail(
                `--kind must be one of ${knownKinds.join(", ")}, got "${kind}"`,
              );
            }
          }
        }
        const index = await Index.open(root);
        try {
          if (opts.status) {
            renderStatus(await index.status(), opts.json ?? false);
            return;
          }
          if (opts.reindex) {
            renderReindex(
              await index.reindex(opts.full ?? false),
              opts.full ?? false,
              opts.json ?? false,
            );
            return;
          }
          const query: Query = {
            text: text ?? "",
            raw: opts.raw ?? false,
            tagsAll: opts.tag,
            tagsAny: opts.tagAny,
            kinds: opts.kind,
            since: opts.since ?? "",
            until: opts.until ?? "",
            dateField: opts.dateField,
            volatility: opts.volatility,
            includeSuperseded: opts.includeSuperseded ?? false,
            exclude: opts.exclude,
            limit: opts.limit,
          };
          const hits = await index.search(query);
          renderSkipped(index.skippedPages());
          renderHits(hits, opts.json ?? false);
        } finally {
          index.close();
        }
      },
    );
}
