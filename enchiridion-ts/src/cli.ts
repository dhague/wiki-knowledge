#!/usr/bin/env node
/**
 * enchiridion CLI entry point: one subcommand per capability (ADR-0017).
 *
 * `vault`, `page`, and `hook` are deliberately spelled with the nested
 * sub-subcommands CLAUDE.md documents (`vault root|move`, `page
 * get|set|merge`, `hook session-start|post-tool-use`).
 */

import { Command, InvalidArgumentError } from "commander";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import util from "node:util";
import { Page, isStringListKey } from "./wikipage.js";
import { captureSession } from "./transcriptcapture.js";
import { formatSummary, logPath, readLog, summarize } from "./toolcallstats.js";
import { KindFolders, Kinds, path as placePath } from "./place.js";
import { Vault, readKindMeta, resolveRoot, vaultForFile } from "./vault.js";
import { VaultGit } from "./vaultgit.js";
import { resolve as resolveSuperseded } from "./supersededby.js";
import { scan as scanIngest } from "./ingestscan.js";
import { commit as commitManifest, type Manifest } from "./commit.js";
import { init as initWiki, Modes } from "./initwiki.js";
import { sessionStart, postToolUse } from "./hooks.js";
import { decodePlan, resolve, type Plan } from "./ingest.js";
import { append as appendIngestignore } from "./ingestignore.js";
import { Index, type Hit, type Query } from "./searchindex.js";
import {
  check as checkDiscover,
  discover as discoverCandidates,
  tagsContaining,
  tagCounts,
  DefaultLimit as DiscoverDefaultLimit,
  DefaultMaxCandidates as DiscoverDefaultMaxCandidates,
  DuplicateThreshold as DiscoverDuplicateThreshold,
  RelatedThreshold as DiscoverRelatedThreshold,
} from "./discover.js";
import {
  DefaultDebounceSeconds,
  DefaultPollIntervalSeconds,
  acquireLock,
  forRoot,
  removeFromQueue,
  runWatch,
} from "./watch.js";
import { canonicalSourceDate } from "./sourcedate.js";
import {
  edgeLink,
  edgeRefusal,
  isEdgeKey,
  isListEdgeKey,
  type RefLookup,
} from "./pageedge.js";
import { CHECKS, DefaultMinSimilarity, FIXES } from "./check.js";
import { Volatilities } from "./pagerecord.js";
import { emitDocument, emitRows, fail, failureMessage } from "./output.js";
import {
  runExport,
  buildCandidates,
  vaultPageRefs,
  ExportDirtyError,
  ExportStartPageError,
  ExportTargetIsDirectoryError,
  ExportTargetNotEmptyError,
} from "./exportwriter.js";
import { SINGLE_FILE_DEFAULT_NAME } from "./exportsingle.js";
import {
  exportConfigPath,
  normalizeStartPageRef,
  saveExportStartPage,
  saveExportTitle,
} from "./exportconfig.js";
import type { StarterEntry } from "./exportmeta.js";

function stub(command: Command, label: string): void {
  command.action(() => fail(`enchiridion ${label}: not yet implemented`));
}

function loadPage(file: string): Page {
  return new Page(fs.readFileSync(file, "utf8"));
}

function writePageFile(file: string, page: Page): void {
  fs.writeFileSync(file, page.text, { mode: 0o644 });
}

/**
 * A normalizer over one page's vault, so a list of values resolves the root
 * and reads each target's title once. The vault is the file's own location
 * ([vaultForFile]) — never `$WIKI_ROOT` or cwd.
 */
function edgeNormalizer(file: string): (key: string, value: string) => string {
  const { vault, pageDir } = vaultForFile(file);
  const lookup: RefLookup = (ref) =>
    vault.exists(ref)
      ? { exists: true, title: vault.load(ref).getString("title") }
      : { exists: false, title: "" };
  return (key, value) => edgeLink(key, value, pageDir, lookup);
}

/** The value `page set` writes for an edge key: a single link for
 * `raw_source`, a list of links otherwise. A bare scalar would be read as no
 * edge at all, so `--json` may pass a longer list, or an empty one to clear. */
function edgeSetValue(
  file: string,
  key: string,
  value: unknown,
): string | string[] {
  const normalize = edgeNormalizer(file);
  if (!isListEdgeKey(key)) {
    if (Array.isArray(value))
      fail(`${key} holds a single link; pass one value`);
    if (typeof value !== "string") fail(edgeRefusal(key, value));
    return normalize(key, value);
  }
  const items = Array.isArray(value) ? value : [value];
  return items.map((item) => {
    if (typeof item !== "string") fail(edgeRefusal(key, item));
    return normalize(key, item);
  });
}

/** The value `page set` writes for a string-list key: a one-element list for
 * one bare value, the list itself for a list. A bare value shaped like a JSON
 * array is read as one (the shape `page merge` takes); anything else
 * non-string is refused. The write rule itself is [canonicalForWrite]'s. */
function stringListSetValue(key: string, value: unknown): string[] {
  if (typeof value === "string") {
    const text = value.trim();
    if (!text.startsWith("[") || !text.endsWith("]")) return [value];
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      fail(`${key} starts like a JSON list but does not parse: ${value}`);
    }
    return stringListSetValue(key, parsed);
  }
  if (!Array.isArray(value)) fail(`${key} expects a JSON list of values`);
  return value.map((item) => {
    if (typeof item !== "string") fail(`${key} expects a JSON list of strings`);
    return item;
  });
}

/** Render a value as plain text — notably a list as `['a', 'b']`, the form
 * callers of `page get` parse. */
function formatFrontmatterValue(value: unknown): string {
  if (!Array.isArray(value)) return formatScalar(value);
  return "[" + value.map((v) => `'${formatScalar(v)}'`).join(", ") + "]";
}

function formatScalar(value: unknown): string {
  if (typeof value === "boolean") return value ? "True" : "False";
  return String(value);
}

const FLAT_SUBCOMMANDS = [] as const;

/** "" and "raw/" both mean all of raw/; a "raw/" prefix is stripped, so
 * "notes" and "raw/notes" are interchangeable. */
function normalizeFolderArg(arg: string): string {
  if (arg === "" || arg === "raw/") return "";
  return arg.startsWith("raw/") ? arg.slice("raw/".length) : arg;
}

/** Render the scan result's tabular form: right-aligned raw/ paths followed by
 * their reason, then the ignored block. */
function renderScanTable(result: {
  eligible: { rawRel: string; reason: string }[];
  ignored: string[];
}): void {
  if (result.eligible.length === 0 && result.ignored.length === 0) {
    console.log("no eligible files; 0 ignored");
    return;
  }
  let width = 10;
  for (const c of result.eligible) {
    if (c.rawRel.length > width) width = c.rawRel.length;
  }
  for (const rawRel of result.ignored) {
    if (rawRel.length > width) width = rawRel.length;
  }
  for (const c of result.eligible) {
    console.log(`${c.rawRel.padEnd(width)}  ${c.reason}`);
  }
  if (result.ignored.length > 0) {
    console.log(`\n${result.ignored.length} ignored by .ingestignore:`);
    for (const rawRel of result.ignored) console.log(`  ${rawRel}`);
  }
}

/** Execute an IngestPlan from a plan file ('-' reads stdin): print the commit
 * SHA first, then the tool-call summary, and delete the plan file. */
async function runPlan(
  planPath: string,
  root: string,
  dryRun: boolean,
): Promise<void> {
  let text: string;
  if (planPath === "-") {
    text = fs.readFileSync(0, "utf8");
  } else {
    text = fs.readFileSync(planPath, "utf8");
  }
  const plan: Plan = decodePlan(text);
  const resolved = resolve(plan, root);
  resolved.validate();
  if (dryRun) {
    console.log(resolved.describe());
    return;
  }

  const sha = await resolved.execute(new VaultGit(root));
  console.log(sha);
  printToolCallSummary();
  if (planPath !== "-") {
    fs.unlinkSync(planPath);
  }
}

/** Report this run's tool-call cost from the PostToolUse hook log; silent when
 * no log exists, which is not an ingest error. The SHA stays the first line
 * either way, so callers can still capture it. */
function printToolCallSummary(): void {
  const sessionID = process.env.CLAUDE_CODE_SESSION_ID;
  if (!sessionID) return;
  const events = readLog(sessionID, "");
  if (events.length === 0) return;
  console.log(formatSummary(summarize(events)));
}

/** The tag-vocabulary fields discover may report; the selected form rides in
 * the one JSON document. */
interface VocabularyFields {
  vocabulary?: { tag: string; count: number }[];
  tag_matches?: string[];
  tag_counts?: { tag: string; count: number }[];
}

type PlanPayload = {
  pages: { title: string; candidates: unknown[] }[];
} & VocabularyFields;

/** Split on commas, trimming whitespace and dropping empties. */
function splitCommaList(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/** Commander repeatable-flag processor: (value, previous), appended in order. */
function collectFlag(value: string, previous: string[]): string[] {
  return [...previous, value];
}

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

/** Execute `discover --plan`: classify every planned page, emitting the pages
 * payload plus the tag vocabulary in whichever form was asked for. The
 * filtered forms ride in the same JSON document as named fields, so a caller
 * reading stdout as JSON sees them. */
async function runDiscoverPlan(
  index: Index,
  planPath: string,
  opts: {
    limit: number;
    duplicateThreshold: number;
    relatedThreshold: number;
    maxCandidates: number;
  },
  tagsContain: string,
  tagCount: string,
): Promise<void> {
  let text: string;
  if (planPath === "-") {
    text = fs.readFileSync(0, "utf8");
  } else {
    text = fs.readFileSync(planPath, "utf8");
  }
  const plan: Plan = decodePlan(text);
  const results = await discoverCandidates(index, plan.pages, opts);

  const pages = results.map((r) => ({
    title: r.title,
    candidates: r.candidates,
  }));

  const vocab = await index.tagCounts();

  const payload: PlanPayload = { pages };
  if (tagsContain === "" && tagCount === "") {
    payload.vocabulary = vocab;
  } else {
    if (tagsContain !== "") {
      payload.tag_matches = tagsContaining(vocab, splitCommaList(tagsContain));
    }
    if (tagCount !== "") {
      payload.tag_counts = tagCounts(vocab, splitCommaList(tagCount));
    }
  }
  emitDocument(payload);
}

/** Append rawRel to its own folder's `.ingestignore`. rawRel is
 * vault-relative, exactly as the sweep prints it (`raw/emails/foo.eml`). */
function ignoreRawFile(root: string, rawRel: string, comment: string): void {
  const rel = path.posix.normalize(rawRel);
  if (!rel.startsWith("raw/") || rel.length <= "raw/".length) {
    fail(
      `--ignore takes a vault-relative path under raw/, got ${JSON.stringify(rawRel)}`,
    );
  }
  const folder = path.join(
    root,
    "raw",
    path.posix.dirname(rel.slice("raw/".length)),
  );
  appendIngestignore(folder, path.posix.basename(rel), comment);
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("enchiridion")
    .description(
      "Wiki-knowledge plugin script layer (TypeScript bundle — ADR-0017)",
    )
    .allowExcessArguments(true)
    .allowUnknownOption(true);

  for (const name of FLAT_SUBCOMMANDS) {
    const sub = program
      .command(`${name} [args...]`)
      .description("not yet implemented");
    stub(sub, name);
  }

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
      "filter by kind (concept|entity|source|synthesis); comma-separated for multiple",
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
        const { root } = resolveRoot();
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

  // init <path> — scaffold a brand-new vault from an explicit path, not a
  // resolved root; the resolved vault root is the only thing on stdout.
  program
    .command("init <path>")
    .description(
      `Scaffold a brand-new wiki vault; --mode is one of: ${Modes.join(", ")}`,
    )
    .requiredOption(
      "--mode <mode>",
      `deployment mode: one of ${Modes.join(", ")}`,
    )
    .option(
      "--plugin-root <dir>",
      "this plugin's install dir (required for query-from-anywhere)",
    )
    .action(
      async (
        vaultPath: string,
        opts: { mode: string; pluginRoot?: string },
      ) => {
        const root = await initWiki(
          vaultPath,
          opts.mode,
          opts.pluginRoot ?? "",
        );
        console.log(root);
      },
    );

  // place <kind> <title> — compute a page's vault-relative path. Resolves no
  // vault root and accepts only the four canonical kinds, never a discovered
  // custom kind-folder.
  program
    .command("place <kind> <title>")
    .description(
      `Compute a new page's vault-relative path from its kind and title; kind is one of: ${Kinds.join(", ")}`,
    )
    .action((kind: string, title: string) => {
      const rel = placePath(kind, title, undefined);
      console.log(rel);
    });

  // save-session — write this session's transcript as a raw file, printing its
  // vault-relative path.
  program
    .command("save-session")
    .description("Save this session's transcript as a raw file in the vault")
    .option(
      "--slug <phrase>",
      "phrase naming what this session covered; sanitized, first-save only",
    )
    .action(async (opts: { slug?: string }) => {
      const { root } = resolveRoot();
      const rel = await captureSession(
        root,
        opts.slug ?? "",
        "",
        undefined,
        new Date(),
      );
      console.log(rel);
    });

  // tool-call-stats — summarise one session's tool-call log.
  program
    .command("tool-call-stats")
    .description("Summarise a session's tool-call log")
    .option(
      "--session-id <id>",
      "session to summarise (default: $CLAUDE_CODE_SESSION_ID)",
    )
    .action((opts: { sessionId?: string }) => {
      let id = opts.sessionId ?? "";
      if (id === "") id = process.env.CLAUDE_CODE_SESSION_ID ?? "";
      if (id === "") {
        fail(
          "no session_id — pass --session-id or set $CLAUDE_CODE_SESSION_ID",
        );
      }
      const events = readLog(id, "");
      if (events.length === 0) {
        fail(`no log found at ${logPath(id, "")}`);
      }
      console.log(formatSummary(summarize(events)));
    });

  // vault — bare or `vault root` prints the resolved root, `vault move`
  // moves a page and fixes every link, `vault kinds` lists placement kinds as
  // JSON. The parent's action runs for bare `vault` and is inherited by a
  // subcommand with no handler of its own.
  const vault = program
    .command("vault")
    .description(
      "Resolve the vault root, or move a page within it (moves need exactly two page refs)",
    )
    .action(() => {
      const { root } = resolveRoot();
      console.log(root);
    });
  vault
    .command("root")
    .description("Print the resolved vault root (the no-argument default)")
    .action(() => {
      const { root } = resolveRoot();
      console.log(root);
    });
  vault
    .command("move")
    .description(
      "Move a page within the vault and fix every link, inbound and outbound",
    )
    .argument("<old_ref>", "vault-relative path of the page to move")
    .argument("<new_ref>", "vault-relative destination path")
    .action((oldRef: string, newRef: string) => {
      const { root } = resolveRoot();
      const changed = new Vault(root).movePage(oldRef, newRef);
      for (const pageRef of changed) console.log(pageRef);
    });
  vault
    .command("kinds")
    .description(
      "List all placement kinds as a compact JSON array: canonical four plus any discovered custom folders",
    )
    .action(() => {
      const { root } = resolveRoot();
      const custom = new Vault(root).discoveredKinds();
      const result: {
        kind: string;
        folder: string;
        canonical: boolean;
        definition: { kind: string; summary: string } | null;
      }[] = [];
      for (const kind of Kinds) {
        result.push({
          kind,
          folder: KindFolders[kind],
          canonical: true,
          definition: null,
        });
      }
      for (const [kind, folder] of Object.entries(custom)) {
        const meta = readKindMeta(path.join(root, "wiki", folder));
        result.push({ kind, folder, canonical: false, definition: meta });
      }
      emitDocument(result);
    });

  // check <name> [--json] — run one vault health check by name.
  const checkNames = Object.keys(CHECKS).join(", ");
  const check = program
    .command("check")
    .description(`Run a vault health check by name; names: ${checkNames}`)
    .argument("<name>", "check name")
    .option("--json", "emit findings as JSON Lines (one object per line)")
    .option(
      "--min-similarity <n>",
      `concept-fragmentation cutoff, 0-1 (default ${DefaultMinSimilarity})`,
      (v: string) => {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0 || n > 1) {
          throw new InvalidArgumentError(
            `must be a number in [0, 1], got "${v}"`,
          );
        }
        return n;
      },
    )
    .action(
      async (
        name: string,
        opts: { json?: boolean; minSimilarity?: number },
      ) => {
        const fn = CHECKS[name];
        if (!fn) {
          fail(
            `enchiridion check: unknown check "${name}"; known: ${checkNames}`,
          );
        }
        const { root } = resolveRoot();
        const findings = await fn(root, { minSimilarity: opts.minSimilarity });
        if (opts.json) {
          emitRows(findings);
        } else {
          for (const f of findings) console.log(`${f.pageRef}: ${f.detail}`);
        }
      },
    );
  void check; // referenced only for side effect of registering the command

  // fix <name> — apply an auto-fix by name; prints each changed page ref.
  const fixNames = Object.keys(FIXES).join(", ");
  const fix = program
    .command("fix")
    .description(`Apply an auto-fix by name; names: ${fixNames}`)
    .argument("<name>", "fix name")
    .action(async (name: string) => {
      const fn = FIXES[name];
      if (!fn) {
        fail(`enchiridion fix: unknown fix "${name}"; known: ${fixNames}`);
      }
      const { root } = resolveRoot();
      const changed = await fn(root);
      for (const ref of changed) console.log(ref);
    });
  void fix; // referenced only for side effect of registering the command

  // page get|set|merge <file> <key> ... — the frontmatter trio. Resolves no
  // vault root for a plain value, but an edge key's value may be a
  // vault-relative ref composed against the vault the file sits in.
  const page = program
    .command("page")
    .description(
      "Read and edit one page's frontmatter (edge keys take a markdown link or a vault-relative page ref)",
    );

  page
    .command("get")
    .argument("<file>", "markdown file")
    .argument("<key>", "frontmatter key")
    .description("Print a frontmatter value")
    .action((file: string, key: string) => {
      const p = loadPage(file);
      const { value, ok } = p.get(key);
      if (!ok || value === null || value === undefined) {
        fail(`no frontmatter key "${key}" in ${file}`);
      }
      console.log(formatFrontmatterValue(value));
    });

  page
    .command("set")
    .argument("<file>", "markdown file")
    .argument("<key>", "frontmatter key")
    .argument(
      "<value>",
      "value; for an edge key, exactly one markdown link or a vault-relative page ref; for tags, one value or a JSON list (a list-valued key is replaced)",
    )
    .option("--json", "parse value as JSON; a list for a list-valued key")
    .description(
      "Set a frontmatter value in place — replaces the key, including a list-valued edge key",
    )
    .action(
      (file: string, key: string, raw: string, opts: { json?: boolean }) => {
        const p = loadPage(file);
        let value: unknown = raw;
        if (opts.json) {
          try {
            value = JSON.parse(raw);
          } catch {
            fail(`parsing ${key} as JSON: invalid JSON`);
          }
        }
        if (key === "source_date") value = canonicalSourceDate(value);
        if (isEdgeKey(key)) value = edgeSetValue(file, key, value);
        // The writer wraps a scalar; the CLI's job is the argument, so a
        // non-string is refused here.
        if (isStringListKey(key)) value = stringListSetValue(key, value);
        const updated = p.set(key, value);
        writePageFile(file, updated);
      },
    );

  page
    .command("merge")
    .argument("<file>", "markdown file")
    .argument("<key>", "frontmatter key")
    .argument(
      "<json-list>",
      "JSON list of values to union in; edge links or vault-relative page refs",
    )
    .description(
      "Union a JSON list into an existing list-valued key (page set replaces it instead)",
    )
    .action((file: string, key: string, raw: string) => {
      const p = loadPage(file);
      let values: unknown[];
      try {
        values = JSON.parse(raw);
      } catch {
        fail(`merge expects a JSON list for ${key}`);
      }
      if (!Array.isArray(values)) {
        fail(`merge expects a JSON list for ${key}`);
      }
      if (key === "raw_source") {
        fail("raw_source holds a single link; use page set");
      }
      if (isEdgeKey(key)) {
        const normalize = edgeNormalizer(file);
        values = values.map((item) => {
          if (typeof item !== "string") fail(edgeRefusal(key, item));
          return normalize(key, item);
        });
      }
      const updated = p.merge(key, values);
      writePageFile(file, updated);
    });

  // read-page <ref> — print a page's full content by vault-relative ref; the
  // read-only companion to search, for a host with no Read tool.
  program
    .command("read-page <ref>")
    .description("Print a page's full content by vault-relative ref")
    .option("--json", "emit {page_ref, frontmatter, body} as one JSON line")
    .action((ref: string, opts: { json?: boolean }) => {
      const { root } = resolveRoot();
      const vault = new Vault(root);
      if (!vault.exists(ref)) {
        fail(`page not found: ${ref}`);
      }
      const page = vault.load(ref);
      if (opts.json) {
        emitDocument({
          page_ref: ref,
          frontmatter: page.frontmatter(),
          body: page.body(),
        });
        return;
      }
      process.stdout.write(page.text);
    });

  // superseded-by <page_ref>... — resolve refs to their current supersession
  // heads.
  program
    .command("superseded-by <page_ref...>")
    .description("Resolve page refs to their current supersession heads")
    .option("--json", "emit results as JSON Lines (one object per line)")
    .action(async (pageRefs: string[], opts: { json?: boolean }) => {
      const { root } = resolveRoot();
      const records = new Vault(root).pages();
      const resolutions = resolveSuperseded(pageRefs, records);

      if (opts.json) {
        emitRows(resolutions);
        return;
      }
      for (const res of resolutions) {
        if (res.chain.length === 0) {
          console.log(`${res.seed}  (current)`);
          continue;
        }
        let via = "";
        if (res.chain.length > 1) {
          via = ` via ${res.chain.slice(0, -1).join(" -> ")}`;
        }
        console.log(`${res.seed}  ->  ${res.active}${via}`);
      }
    });

  // ingest-scan [folder] — scan raw/ for files that need ingestion.
  program
    .command("ingest-scan [folder]")
    .description("Scan raw/ for files that need ingestion")
    .option(
      "--json",
      "emit JSON Lines (one eligible or ignored record per line)",
    )
    .action(async (folderArg: string | undefined, opts: { json?: boolean }) => {
      const { root } = resolveRoot();
      const folder =
        folderArg === undefined ? "" : normalizeFolderArg(folderArg);
      // null → scan builds the batched git facts (one tree walk + one history
      // walk) rather than the per-file VaultGit surface.
      const result = await scanIngest(root, folder, null);
      if (opts.json) {
        const rows: Record<string, unknown>[] = [];
        for (const c of result.eligible) {
          rows.push({
            kind: "eligible",
            raw_rel: c.rawRel,
            reason: c.reason,
            back_pointers: c.backPointers,
          });
        }
        for (const rawRel of result.ignored) {
          rows.push({ kind: "ignored", raw_rel: rawRel });
        }
        emitRows(rows);
        return;
      }
      renderScanTable(result);
    });

  // watch — a long-running filesystem watcher over raw/ with per-file
  // debounce, an exclusive lock, and a queue file. `--dequeue <raw_rel>`
  // removes one queue entry and exits.
  program
    .command("watch")
    .description("Watch raw/ for new files and enqueue eligible ones")
    .option("--vault <root>", "vault root; defaults to resolve_vault_root()")
    .option(
      "--debounce <seconds>",
      `per-file debounce, seconds (default ${DefaultDebounceSeconds})`,
      (v: string) => Number(v),
      DefaultDebounceSeconds,
    )
    .option(
      "--poll-interval <seconds>",
      `how often to check for settled files, seconds (default ${DefaultPollIntervalSeconds})`,
      (v: string) => Number(v),
      DefaultPollIntervalSeconds,
    )
    .option(
      "--dequeue <rel>",
      "remove this vault-relative path from the watch queue and exit, instead of watching",
    )
    .action(
      async (opts: {
        vault?: string;
        debounce: number;
        pollInterval: number;
        dequeue?: string;
      }) => {
        let root = opts.vault ?? "";
        if (root === "") {
          ({ root } = resolveRoot());
        } else {
          try {
            root = fs.realpathSync(root);
          } catch {
            // A root that doesn't exist yet resolves as-is.
          }
        }
        const paths = forRoot(root);

        if (opts.dequeue) {
          removeFromQueue(paths.queue, opts.dequeue);
          return;
        }

        const { acquired, stalePID } = acquireLock(paths.lock);
        if (!acquired) {
          fail(`another watcher is already running (lock at ${paths.lock})`);
        }
        if (stalePID !== null) {
          console.log(
            `previous watcher exited without cleanup, removing stale lock (pid=${stalePID})`,
          );
        }
        await runWatch(paths, {
          debounceSeconds: opts.debounce,
          pollIntervalSeconds: opts.pollInterval,
        });
      },
    );

  // ingest — execute an IngestPlan against the resolved vault, printing the
  // commit SHA as the first stdout line.
  program
    .command("ingest")
    .description("Execute an IngestPlan against the resolved vault")
    .option(
      "--plan <file>",
      "path to an IngestPlan JSON file ('-' reads stdin)",
    )
    .option(
      "--ignore <rawRel>",
      "never offer this raw/ file again for a sweep (appends it to its folder's .ingestignore); repeatable",
      collectFlag,
      [] as string[],
    )
    .option(
      "--ignore-comment <comment>",
      "optional trailing comment for the --ignore entry",
    )
    .option(
      "--dry-run",
      "resolve and validate the plan, print what would be written, write nothing",
    )
    .action(
      async (opts: {
        plan?: string;
        ignore?: string[];
        ignoreComment?: string;
        dryRun?: boolean;
      }) => {
        const planPath = opts.plan ?? "";
        const ignoreRels = opts.ignore ?? [];
        if (opts.dryRun && planPath === "") {
          fail("--dry-run only applies to --plan; --ignore always writes");
        }
        if ((planPath === "") === (ignoreRels.length === 0)) {
          fail("exactly one of --plan or --ignore is required");
        }
        const { root } = resolveRoot();
        if (ignoreRels.length > 0) {
          const comment = opts.ignoreComment ?? "";
          for (const ignoreRel of ignoreRels) {
            ignoreRawFile(root, ignoreRel, comment);
          }
          return;
        }
        await runPlan(planPath, root, opts.dryRun ?? false);
      },
    );

  // commit — write one structured commit from a hand-built manifest; `ingest`
  // commits its own plan.
  program
    .command("commit")
    .description("Write one structured git commit per manifest")
    .option(
      "--manifest <file>",
      "path to a manifest JSON file ('-' reads stdin)",
    )
    .action(async (opts: { manifest?: string }) => {
      if (!opts.manifest) {
        fail("required option '--manifest <file>' not specified");
      }
      const { root } = resolveRoot();
      let text: string;
      if (opts.manifest === "-") {
        text = fs.readFileSync(0, "utf8");
      } else {
        text = fs.readFileSync(opts.manifest, "utf8");
      }
      const manifest = JSON.parse(text) as Manifest;
      const sha = await commitManifest(root, manifest, new VaultGit(root));
      console.log(sha);
    });

  // discover — two modes: --plan discovers candidates for every page in a
  // draft plan plus the vault's tag vocabulary; --title/--summary/--body-file
  // is single-page mode, emitting one candidate per line.
  program
    .command("discover")
    .description(
      "Find pages overlapping a planned page, plus the tag vocabulary",
    )
    .option(
      "--plan <file>",
      "path to a draft IngestPlan JSON ('-' reads stdin); discovers candidates for every page in it, plus the vault's tag vocabulary",
    )
    .option("--title <text>", "the planned page's own title (single-page mode)")
    .option(
      "--summary <text>",
      "the planned page's own summary (single-page mode)",
    )
    .option(
      "--body-file <file>",
      "path to the planned page's own body text (single-page mode)",
    )
    .option(
      "--limit <n>",
      `max hits scanned per page; 0 = unbounded (score is the real filter) (default ${DiscoverDefaultLimit})`,
      (v: string) => Number(v),
      DiscoverDefaultLimit,
    )
    .option(
      "--max-candidates <n>",
      `max candidates kept per page, highest-scoring first; 0 = use default`,
      (v: string) => Number(v),
      DiscoverDefaultMaxCandidates,
    )
    .option(
      "--duplicate-threshold <n>",
      "",
      (v: string) => Number(v),
      DiscoverDuplicateThreshold,
    )
    .option(
      "--related-threshold <n>",
      "",
      (v: string) => Number(v),
      DiscoverRelatedThreshold,
    )
    .option(
      "--tags-containing <substrings>",
      "comma-separated substrings (case-insensitive OR match); with --plan, selects the tag_matches field in place of the full tag-vocabulary dump",
    )
    .option(
      "--tag-count <tags>",
      "comma-separated exact tag names; with --plan, selects the tag_counts field (per-tag page counts, 0 if the tag doesn't exist yet) in place of the full tag-vocabulary dump",
    )
    .action(
      async (opts: {
        plan?: string;
        title?: string;
        summary?: string;
        bodyFile?: string;
        limit: number;
        maxCandidates: number;
        duplicateThreshold: number;
        relatedThreshold: number;
        tagsContaining?: string;
        tagCount?: string;
      }) => {
        const { root } = resolveRoot();
        const discoverOpts = {
          limit: opts.limit,
          duplicateThreshold: opts.duplicateThreshold,
          relatedThreshold: opts.relatedThreshold,
          maxCandidates: opts.maxCandidates,
        };
        // The one index handle for this run — one per vault at a time
        // (ADR-0010).
        const index = await Index.open(root);
        try {
          if (opts.plan) {
            await runDiscoverPlan(
              index,
              opts.plan,
              discoverOpts,
              opts.tagsContaining ?? "",
              opts.tagCount ?? "",
            );
            return;
          }
          let body = "";
          if (opts.bodyFile) {
            body = fs.readFileSync(opts.bodyFile, "utf8");
          }
          const candidates = await checkDiscover(
            index,
            opts.title ?? "",
            opts.summary ?? "",
            body,
            discoverOpts,
          );
          emitRows(candidates);
        } finally {
          index.close();
        }
      },
    );

  // hook session-start|post-tool-use — read their payload on stdin and fail
  // open (CLAUDE.md): a hook error must never interrupt the session.
  const hook = program
    .command("hook")
    .description("Handle a Claude Code hook payload read from stdin")
    .action(() => {
      // A bare or unrecognised event is an error, not commander's
      // help-and-exit-0 — a hooks.json typo must not look like it worked.
      fail(
        `hook: name the event, one of ${["session-start", "post-tool-use"].join(", ")}`,
      );
    });
  for (const action of ["session-start", "post-tool-use"] as const) {
    hook
      .command(action)
      .description("Handle the " + action + " hook event")
      .action(() => {
        // Fail open: read the payload, run the handler, and swallow every
        // error, malformed JSON on stdin included.
        try {
          const payload = JSON.parse(fs.readFileSync(0, "utf8"));
          if (action === "session-start") sessionStart(payload);
          else postToolUse(payload);
        } catch {
          // Deliberately dropped, not reported: hook stderr surfaces to the
          // user mid-session with nothing they can act on.
        }
      });
  }

  program
    .command("export")
    .description("Produce a static HTML site from the vault")
    .option(
      "--single-file",
      `write one self-contained HTML file instead of a directory tree (--out names that file, default: ${SINGLE_FILE_DEFAULT_NAME} at the vault root)`,
    )
    .option("--out <path>", "output directory, or file under --single-file")
    .option("--raw", "include raw/ section")
    .option("--force", "overwrite non-empty output directory")
    .option("--allow-dirty", "skip dirty-tree check")
    .option(
      "--title <title>",
      "wiki title for this run only (default: the saved title, else the vault directory name)",
    )
    .option(
      "--save-title <title>",
      "save the wiki title as the persistent default and exit (writes no site)",
    )
    .option(
      "--start-page <ref>",
      "vault-relative page ref to export as the site's front page for this run only (default: the saved start page, else the generated front page)",
    )
    .option(
      "--save-start-page <ref>",
      "save a page ref as the vault's persistent start page and exit (a blank ref clears it; writes no site)",
    )
    .option(
      "--candidates",
      "emit the ranked candidate list as one JSON line to stdout and exit (writes nothing)",
    )
    .option(
      "--starters <refs...>",
      "page refs (optionally as ref=annotation) for the get-started block",
    )
    .action(
      async (opts: {
        singleFile?: boolean;
        out?: string;
        raw?: boolean;
        force?: boolean;
        allowDirty?: boolean;
        title?: string;
        saveTitle?: string;
        startPage?: string;
        saveStartPage?: string;
        candidates?: boolean;
        starters?: string[];
      }) => {
        const { root } = resolveRoot();

        // Persist-and-exit, like --candidates: a second full export over a
        // non-empty target is not what "save" means.
        if (opts.saveTitle !== undefined) {
          try {
            saveExportTitle(root, opts.saveTitle);
          } catch (err) {
            fail(`enchiridion export: ${(err as Error).message}`);
          }
          console.log(
            `Saved wiki title "${opts.saveTitle.trim()}" to ${exportConfigPath(root)}`,
          );
          return;
        }

        // The one thing this path validates is that the ref names a page of
        // the vault; a blank ref means "no start page", not an error.
        if (opts.saveStartPage !== undefined) {
          const ref = normalizeStartPageRef(opts.saveStartPage);
          if (ref !== "" && !vaultPageRefs(root).has(ref)) {
            fail(
              `enchiridion export: --save-start-page "${ref}" does not name a page of this vault`,
            );
          }
          saveExportStartPage(root, opts.saveStartPage);
          console.log(
            ref === ""
              ? `Cleared the saved start page in ${exportConfigPath(root)}`
              : `Saved start page "${ref}" to ${exportConfigPath(root)}`,
          );
          return;
        }

        if (opts.candidates) {
          emitDocument(buildCandidates(root));
          return;
        }

        const starters: StarterEntry[] = [];
        for (const item of opts.starters ?? []) {
          const eqIdx = item.indexOf("=");
          if (eqIdx === -1) {
            starters.push({ pageRef: item });
          } else {
            starters.push({
              pageRef: item.slice(0, eqIdx),
              annotation: item.slice(eqIdx + 1),
            });
          }
        }

        // `--out` names a directory in the default mode and the output file
        // under --single-file, so the fallback default differs too.
        const outPath = opts.out
          ? path.resolve(opts.out)
          : path.join(root, opts.singleFile ? SINGLE_FILE_DEFAULT_NAME : "web");

        try {
          await runExport(root, {
            out: outPath,
            singleFile: opts.singleFile,
            raw: opts.raw,
            force: opts.force,
            allowDirty: opts.allowDirty,
            // The per-run flag, not the resolved title: runExport owns the
            // resolution order (flag → saved title → directory name).
            title: opts.title,
            // Likewise the start page: flag → saved ref → none.
            startPage: opts.startPage,
            starters,
          });
          console.log(`Exported to ${outPath}`);
        } catch (err) {
          if (
            err instanceof ExportDirtyError ||
            err instanceof ExportTargetNotEmptyError ||
            err instanceof ExportTargetIsDirectoryError ||
            err instanceof ExportStartPageError
          ) {
            fail(`enchiridion export: ${(err as Error).message}`);
          } else {
            throw err;
          }
        }
      },
    );

  return program;
}

/** Detect a direct CLI invocation across both execution shapes: the esbuild
 * CJS bundle (require.main === module) and the tsx/ESM source path
 * (import.meta.url vs argv[1]). */
function isMainModule(): boolean {
  if (typeof require !== "undefined" && require.main === module) return true;
  const arg = process.argv[1];
  if (arg === undefined) return false;
  return import.meta.url === pathToFileURL(path.resolve(arg)).href;
}

/** The in-process (plugin) entry. Captures stdout/stderr as data instead of
 * writing to the process streams, and overrides commander's exit so neither
 * help() nor an error can terminate the host process. */
export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export async function run(argv: string[]): Promise<RunResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const program = buildProgram();
  program.exitOverride().configureOutput({
    writeOut: (s: string) => stdout.push(s),
    writeErr: (s: string) => stderr.push(s),
  });

  // Swap both the process streams and console for the run (console.log
  // bypasses process.stdout.write on Bun) and restore them in a finally, so
  // the host process keeps its own streams.
  const outWrite = process.stdout.write;
  const errWrite = process.stderr.write;
  const consoleLog = console.log;
  const consoleError = console.error;
  process.stdout.write = ((chunk: unknown, ..._rest: unknown[]) => {
    stdout.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: unknown, ..._rest: unknown[]) => {
    stderr.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  console.log = (...args: unknown[]) => {
    stdout.push(util.format(...args) + "\n");
  };
  console.error = (...args: unknown[]) => {
    stderr.push(util.format(...args) + "\n");
  };

  try {
    // Bare invocation: usage to stdout, exit 0. Under exitOverride help()
    // writes to the captured streams and throws a CommanderError with
    // exitCode 0 instead of process.exit(0).
    if (argv.length === 0) {
      try {
        program.help();
      } catch {
        /* CommanderError with exitCode 0 — swallowed */
      }
      return { stdout: stdout.join(""), stderr: stderr.join(""), exitCode: 0 };
    }

    try {
      await program.parseAsync([process.execPath, "enchiridion", ...argv]);
    } catch (err) {
      // CommanderError (help/version/exit) — its .exitCode is the outcome.
      if (err && typeof err === "object" && "exitCode" in err) {
        return {
          stdout: stdout.join(""),
          stderr: stderr.join(""),
          exitCode: (err as { exitCode: number }).exitCode,
        };
      }
      // An action handler failed — `fail`, or an error commander rejected
      // parseAsync with rather than wrapping in a CommanderError. Render it as
      // main() does: message on stderr, exit 1, as data rather than an exit.
      stderr.push(failureMessage(err));
      return { stdout: stdout.join(""), stderr: stderr.join(""), exitCode: 1 };
    }
    // Read a leaked process.exitCode so it is reported rather than swallowed,
    // but never leave it set on the host process.
    const exitCode = Number(process.exitCode ?? 0);
    process.exitCode = 0;
    return { stdout: stdout.join(""), stderr: stderr.join(""), exitCode };
  } finally {
    process.stdout.write = outWrite;
    process.stderr.write = errWrite;
    console.log = consoleLog;
    console.error = consoleError;
  }
}

function main(): void {
  const program = buildProgram();
  if (process.argv.slice(2).length === 0) {
    // Commander would treat bare invocation as a missing subcommand (help to
    // stderr, exit 1); match the established usage-to-stdout, exit-0 behaviour
    // instead.
    program.help();
    return;
  }
  // Render a failed command exactly as run() does: message on stderr, exit 1,
  // no stack trace standing in for a diagnostic.
  void program.parseAsync(process.argv).catch((err: unknown) => {
    process.stderr.write(failureMessage(err));
    process.exitCode = 1;
  });
}

// Importing the module must be inert, so a host can import it and call run()
// without hijacking the process.
if (isMainModule()) {
  main();
}
