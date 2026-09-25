/**
 * commit — write one structured git commit per ingestion/edit.
 *
 * This doc comment is the commit-message format's only specification:
 *
 *	ingest: <source doc title>
 *
 *	created: wiki/concepts/prepared-statements.md
 *	updated: wiki/concepts/db-connection-pooling.md
 *	deleted: wiki/concepts/connection-pooling-notes.md
 *	superseded: wiki/sources/deploy-capistrano.md -> wiki/sources/deploy-github-actions.md
 *	source-date: 2026-03-01
 *
 * `deleted` is a Consolidation's absorbed pages (ADR-0021) — deliberately not
 * spelled `superseded`, which keeps both pages to preserve a conflicting claim.
 *
 * Git is a hard dependency: a root that isn't a work tree is an error, never a
 * silent skip.
 */

import fs from "node:fs";
import path from "node:path";
import { Page } from "./wikipage.js";
import { check } from "./chainofevidence.js";

/** Thrown when a manifest fails the chain-of-evidence gate; distinct from a
 * git failure, which is an environment problem rather than a planning bug. */
export class ErrGate extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ErrGate";
  }
}

/** The slice of [VaultGit] this module needs, so tests can commit against an
 * in-memory fake. [stageAndCommit] is one atomic unit so implementations can
 * hold a file lock across the stage+commit sequence (concurrent ingests). */
export interface Git {
  isWorkTree(): Promise<boolean>;
  stageAndCommit(paths: string[], message: string): Promise<string>;
}

/** One `old -> new` pair in a manifest. */
export interface Supersession {
  old: string;
  new: string;
}

/** The deterministic description of one ingestion/edit's touched files. */
export interface Manifest {
  title: string;
  action?: string;
  created?: string[];
  updated?: string[];
  /** Pages a Consolidation absorbed and removed — `git rm`'d, not superseded
   * (ADR-0021). */
  deleted?: string[];
  superseded?: Supersession[];
  source_date?: string;
  /** The raw/ artifact this ingestion is sourced from, if any. Staged in the
   * same commit as the pages it produced. */
  raw_source?: string;
}

/** The verb a manifest that names none commits under. */
const defaultAction = "ingest";

/** Every path this manifest touches, de-duplicated, in a stable order. */
export function stagedPaths(m: Manifest): string[] {
  const paths: string[] = [];
  paths.push(...(m.created ?? []));
  paths.push(...(m.updated ?? []));
  paths.push(...(m.deleted ?? []));
  for (const s of m.superseded ?? []) paths.push(s.old, s.new);
  if (m.raw_source) paths.push(m.raw_source);

  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const p of paths) {
    if (!seen.has(p)) {
      seen.add(p);
      ordered.push(p);
    }
  }
  return ordered;
}

/** Render the manifest to its structured commit message (format above).
 * Deterministic. */
export function buildMessage(m: Manifest): string {
  const action = m.action === "" ? defaultAction : (m.action ?? defaultAction);
  const lines: string[] = [`${action}: ${m.title}`, ""];
  for (const pageRef of m.created ?? []) lines.push(`created: ${pageRef}`);
  for (const pageRef of m.updated ?? []) lines.push(`updated: ${pageRef}`);
  for (const pageRef of m.deleted ?? []) lines.push(`deleted: ${pageRef}`);
  for (const s of m.superseded ?? [])
    lines.push(`superseded: ${s.old} -> ${s.new}`);
  if (m.source_date) lines.push(`source-date: ${m.source_date}`);
  return lines.join("\n") + "\n";
}

/** Gate the commit on [check]; a no-op when `raw_source` is unset. Pages are
 * read from disk — the caller has already written them — and a staged page
 * missing from disk is skipped. */
async function checkChainOfEvidence(root: string, m: Manifest): Promise<void> {
  if (!m.raw_source) return;

  const staged: Record<string, Page> = {};
  for (const pageRef of [...(m.created ?? []), ...(m.updated ?? [])]) {
    const abs = path.join(root, ...pageRef.split("/"));
    let text: string;
    try {
      text = fs.readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    staged[pageRef] = new Page(text);
  }

  const problems = check(staged, m.raw_source);
  if (problems.length > 0) {
    throw new ErrGate(`commit gated: ${problems.join("; ")}`);
  }
}

/** Stage the manifest's paths and write one structured commit, returning the
 * SHA. Git is injectable for tests. */
export async function commit(
  root: string,
  m: Manifest,
  git: Git,
): Promise<string> {
  if (!(await git.isWorkTree())) {
    throw new Error(
      `${root} is not a git work tree; the vault's history is not optional`,
    );
  }
  await checkChainOfEvidence(root, m);
  const paths = stagedPaths(m);
  return git.stageAndCommit(paths, buildMessage(m));
}
