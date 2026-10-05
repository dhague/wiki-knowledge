/**
 * The ingestion command group: the plan executor (`ingest`), the manifest
 * commit, discovery, the raw-inbox scan and the foreground watcher — everything
 * that turns raw artifacts into pages.
 */

import type { Command } from "commander";
import fs from "node:fs";
import path from "node:path";
import { formatSummary, readLog, summarize } from "./toolcallstats.js";
import { resolveRoot } from "./vault.js";
import { VaultGit } from "./vaultgit.js";
import { scan as scanIngest } from "./ingestscan.js";
import { commit as commitManifest, type Manifest } from "./commit.js";
import { decodePlan, resolve, type Plan } from "./ingest.js";
import { assessmentErrors } from "./assess.js";
import { append as appendIngestignore } from "./ingestignore.js";
import { Index } from "./searchindex.js";
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
import {
  IngestStdout,
  WatchLockedMarker,
  WatchStartedMarker,
} from "./contract.js";
import { emitDocument, emitRows, fail } from "./output.js";
import { collectFlag, splitCommaList } from "./cliargs.js";

/** Read a plan or manifest from a path, or stdin when the path is "-". */
function readInput(pathOrDash: string): string {
  if (pathOrDash === "-") return fs.readFileSync(0, "utf8");
  return fs.readFileSync(pathOrDash, "utf8");
}

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
  const text = readInput(planPath);
  const plan: Plan = decodePlan(text);
  const resolved = resolve(plan, root);
  resolved.validate();
  // A plan that pinned the snapshot it was assessed at must still find it: the
  // merged body was authored against those exact revisions (ADR-0028).
  if (plan.assessed !== null) {
    const stale = await assessmentErrors(
      plan.assessed,
      plan.consolidates,
      root,
    );
    if (stale.length > 0) fail(`stale assessment: ${stale.join("; ")}`);
  }
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
  const text = readInput(planPath);
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

export function registerIngestCommands(program: Command): void {
  // ingest-scan [folder] — scan raw/ for files that need ingestion.
  program
    .command("ingest-scan [folder]")
    .description("Scan raw/ for files that need ingestion")
    .option(
      "--json",
      "emit JSON Lines (one eligible or ignored record per line)",
    )
    .action(async (folderArg: string | undefined, opts: { json?: boolean }) => {
      const root = resolveRoot();
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
    .description(
      `Watch raw/ for new files and enqueue eligible ones; once observing it prints "${WatchStartedMarker}<raw> (debounce=<s>s, pid=<pid>)", and refuses with "${WatchLockedMarker}<lock>)" when another watcher holds the lock`,
    )
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
          root = resolveRoot();
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
          fail(`${WatchLockedMarker}${paths.lock})`);
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

  // ingest — resolve the whole plan before any write; no rollback, so a rerun
  // after a fix is safe.
  program
    .command("ingest")
    .description(
      `Execute an IngestPlan against the resolved vault; a writing --plan run prints the ${IngestStdout[0]} on line 1, then the ${IngestStdout[1]} when a hook log exists`,
    )
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
        const root = resolveRoot();
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
      const root = resolveRoot();
      const text = readInput(opts.manifest);
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
        const root = resolveRoot();
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
}
