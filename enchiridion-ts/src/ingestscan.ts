/**
 * The ingestion sweep — scan `raw/` for files that need ingestion.
 *
 * Two independent gates: derived done-state (computed here) and declared policy
 * (`.ingestignore`). A raw file is *offered* when (a) no wiki page's
 * `raw_source` points at it, or (b) one does but the raw file is strictly newer
 * than that page's `git_date`, or `git status --porcelain` reports it dirty.
 * The policy file is read from the file's own folder only — see [ingestignore].
 */

import fs from "node:fs";
import path from "node:path";
import { Vault } from "./vault.js";
import type { PageWithText } from "./vault.js";
import { VaultGit } from "./vaultgit.js";
import {
  Filename,
  compile,
  parse as parseIngestignore,
  type Matcher,
} from "./ingestignore.js";

/** The slice of [VaultGit] the sweep needs. Both methods are lenient: an absent
 * date and an unknown dirty state fail toward offering. */
export interface Git {
  lastCommitDate(rel: string): Promise<string>;
  porcelainMentions(rel: string): Promise<boolean>;
}

/** No page's raw_source points at it. */
export const ReasonNeverIngested = "never-ingested";
/** Pages point at it, and it has moved on. */
export const ReasonChangedSinceIngestion = "changed-since-ingestion";

/** One raw file the sweep wants to offer. RawRel is vault-relative. */
export interface Candidate {
  rawRel: string;
  /** [ReasonNeverIngested] or [ReasonChangedSinceIngestion]; the latter's
   * backPointers list the pointing pages, passed to `wiki-ingest` as a
   * reconciliation hint. */
  reason: string;
  backPointers: string[];
}

/** The sweep's verdict on one (vault, folder). Ignored is reported rather than
 * silently dropped, so the sweep can say "3 ignored". */
export interface Result {
  eligible: Candidate[];
  ignored: string[];
}

/** The raw/ files that are instructions and policy, not content. */
const skipNames = new Set<string>(["INGESTION.md", ".ingestignore"]);

/** Every file under `root/raw/<folder>`, vault-relative and sorted; skips
 * `INGESTION.md` and `.ingestignore`. A missing folder yields nothing. */
export function walkRaw(root: string, folder: string): string[] {
  let rawRoot = path.join(root, "raw");
  if (folder !== "") rawRoot = path.join(rawRoot, ...folder.split("/"));
  let info: fs.Stats;
  try {
    info = fs.statSync(rawRoot);
  } catch (err) {
    if (isENOENT(err)) return [];
    throw err;
  }
  if (!info.isDirectory()) return [];

  const rels: string[] = [];
  const walk = (dir: string): void => {
    const entries = fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
      } else if (!skipNames.has(entry.name)) {
        rels.push(toSlash(path.relative(root, abs)));
      }
    }
  };
  walk(rawRoot);
  return rels;
}

/** The `.ingestignore` in folder, if any — this folder only, no ancestor walk.
 * A malformed policy file is an error, not an empty policy: reading it as
 * "ignore nothing" would offer every file it was meant to withdraw. */
export function loadIngestignore(folder: string): string[] {
  const filePath = path.join(folder, Filename);
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if (isENOENT(err)) return [];
    throw err;
  }
  return parseIngestignore(text);
}

/** `{raw_rel_lower: [page_ref, …]}` for every page with a raw_source. Keys are
 * lowercased so `scan` can match case-insensitively against the file on disk: an
 * agent may title-case a filename in the plan. */
export function backPointersByRaw(
  pages: Record<string, PageWithText>,
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [pageRef, page] of Object.entries(pages)) {
    for (const edge of page.record.edges) {
      if (edge.key !== "raw_source") continue;
      for (const target of edge.targets) {
        (out[target.toLowerCase()] ??= []).push(pageRef);
      }
    }
  }
  return out;
}

/** True when rawDate > pageDate (YYYY-MM-DD lexicographic); an absent page date
 * fails toward true, so the file is offered rather than silently skipped. */
export function strictlyNewer(rawDate: string, pageDate: string): boolean {
  if (pageDate === "") return true;
  if (rawDate === "") return false;
  return rawDate > pageDate;
}

/** Walk `root/raw/` and return the sweep's verdict (eligibility rule in the
 * module comment). A file matching its own folder's `.ingestignore` lands in
 * Ignored without being evaluated. `git` is injectable; null means the real
 * repository at root. */
export async function scan(
  root: string,
  folder: string,
  git: Git | null,
): Promise<Result> {
  const vault = new Vault(root);
  const pages = vault.pagesWithText();
  const backPointers = backPointersByRaw(pages);
  // null means the real repo: build the batched facts once, not a per-file
  // VaultGit surface, so a folder sweep stays O(tree + history).
  if (git === null) git = await new VaultGit(root).scanFacts();

  const rels = walkRaw(root, folder);

  const result: Result = { eligible: [], ignored: [] };
  const matcherCache = new Map<string, Matcher>();
  for (const rel of rels) {
    // Own folder only: raw/emails/.ingestignore does not govern
    // raw/emails/sub/ — that folder needs its own.
    const dir = path.dirname(path.join(root, ...rel.split("/")));
    let matcher = matcherCache.get(dir);
    if (matcher === undefined) {
      let patterns: string[];
      try {
        patterns = loadIngestignore(dir);
      } catch (err) {
        throw new Error(`${rel}: ${(err as Error).message}`, { cause: err });
      }
      matcher = compile(patterns);
      matcherCache.set(dir, matcher);
    }
    if (matcher.matches(path.basename(rel))) {
      result.ignored.push(rel);
      continue;
    }

    const pointing = backPointers[rel.toLowerCase()] ?? [];
    if (pointing.length === 0) {
      result.eligible.push({
        rawRel: rel,
        reason: ReasonNeverIngested,
        backPointers: [],
      });
      continue;
    }

    if (await git.porcelainMentions(rel)) {
      result.eligible.push({
        rawRel: rel,
        reason: ReasonChangedSinceIngestion,
        backPointers: pointing,
      });
      continue;
    }

    const rawDate = await git.lastCommitDate(rel);
    for (const pageRel of pointing) {
      if (strictlyNewer(rawDate, await git.lastCommitDate(pageRel))) {
        result.eligible.push({
          rawRel: rel,
          reason: ReasonChangedSinceIngestion,
          backPointers: pointing,
        });
        break;
      }
    }
  }
  return result;
}

function toSlash(p: string): string {
  return p.split(path.sep).join("/");
}

function isENOENT(err: unknown): boolean {
  return (err as NodeJS.ErrnoException).code === "ENOENT";
}
