/**
 * The search command group: the lexical-index query plus its index management
 * (--reindex, --full, --status). Registers itself against the shared program.
 */

import type { Command } from "commander";
import { Index, type Hit, type Query } from "./searchindex.js";
import { Volatilities } from "./pagerecord.js";
import { resolveRoot } from "./vault.js";
import { emitDocument, emitRows, fail } from "./output.js";
import { collectFlag, splitCommaList } from "./cliargs.js";

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
    });
    return;
  }
  console.log(`pages:             ${st.pages}`);
  console.log(`db_size_bytes:     ${st.dbSizeBytes}`);
  console.log(`backend:           ${st.backend}`);
  console.log(`schema_version:    ${st.schemaVersion}`);
  console.log(`git_head:          ${orDash(st.gitHead)}`);
  if (st.uncommittedPages > 0) {
    console.log(
      `uncommitted_pages: ${st.uncommittedPages} page(s) on disk not yet committed — not searchable.`,
    );
  } else {
    console.log(`uncommitted_pages: 0`);
  }
}

function renderReindex(
  stats: {
    pages: number;
    inserted: number;
    updated: number;
    removed: number;
    durationMs: number;
  },
  full: boolean,
  asJSON: boolean,
): void {
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
      "filter by kind — a canonical kind or a folder's declared kind; comma-separated for multiple",
      splitCommaList,
      [] as string[],
    )
    .option("--since <date>", "ISO date; inclusive lower bound on date_field")
    .option("--until <date>", "ISO date; inclusive upper bound on date_field")
    .option(
      "--date-field <field>",
      "which date the --since/--until bounds apply to (source_date|git_date)",
      (value: string) => {
        if (value !== "source_date" && value !== "git_date") {
          fail(`must be 'source_date' or 'git_date', got "${value}"`);
        }
        return value;
      },
      "source_date",
    )
    .option(
      "--volatility <vols>",
      `filter by volatility (${Volatilities.join("|")}); comma-separated for multiple`,
      splitCommaList,
      [] as string[],
    )
    .option("--limit <n>", "max hits", (v: string) => Number(v), 20)
    .option(
      "--include-superseded",
      "include pages that have been superseded (default: filter them out)",
    )
    .option(
      "--raw",
      "pass the text through as a literal FTS5 expression (escape hatch)",
    )
    .option("--json", "emit results as JSON Lines (one object per line)")
    .option("--reindex", "rebuild the index")
    .option("--full", "with --reindex: wipe the index and rebuild from scratch")
    .option("--status", "print index status and exit")
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
          raw?: boolean;
          json?: boolean;
          reindex?: boolean;
          full?: boolean;
          status?: boolean;
        },
      ) => {
        const root = resolveRoot();
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
            limit: opts.limit,
          };
          renderHits(await index.search(query), opts.json ?? false);
        } finally {
          index.close();
        }
      },
    );
}
