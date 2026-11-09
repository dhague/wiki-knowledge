/**
 * chainofevidence — the page -> stub -> raw file chain every raw ingestion must
 * leave: a raw file producing pages must also produce a `wiki/sources/` stub
 * whose `raw_source` points back at it, and every other page from it must carry
 * a `source` edge to that stub.
 *
 * The stub must be one of the pages the plan writes: `commit` re-runs this gate
 * over the manifest's own pages, so a stub already in the vault is named in the
 * refusal but never satisfies the rule.
 *
 * `ingest` runs it before any write; `commit` re-runs it as the hard gate.
 *
 * [checkSources] is the multi-source generalisation: one stub per source,
 * every non-stub page sources at least one of them. [check] is the
 * single-source form — a thin wrapper kept for callers with one raw artifact.
 */

import path from "node:path";
import { KindFolders } from "./place.js";
import { Page } from "./frontmatter.js";
import { linkDest, resolveLinkDest } from "./wikipage.js";

const sourceDir = `wiki/${KindFolders["source"]}`;

/** Find the vault's own stand-in for a raw artifact, or "" — consulted only to
 * word a refusal, never to satisfy the rule. */
export type StubLookup = (raw: string) => string;

/**
 * Multi-source generalisation of [check]: finds one stub per entry in raws,
 * then checks every non-stub page sources at least one of them. Results are
 * in sorted-ref order so the outcome is independent of map insertion order.
 * Throws on unparseable frontmatter. [existingStub] is consulted only when
 * no staged page stands in for a given source, to name an on-disk stand-in.
 */
export function checkSources(
  staged: Record<string, Page>,
  raws: string[],
  existingStub?: StubLookup,
): string[] {
  if (raws.length === 0) return [];
  if (raws.length === 1) return check(staged, raws[0], existingStub);

  const normalizedRaws = raws.map((r) => path.posix.normalize(r));
  const refs = sortedRefs(staged);
  const problems: string[] = [];

  // Find the stub for each source; record problems for missing stubs.
  const stubRefs = new Set<string>();
  for (const raw of normalizedRaws) {
    let stubRef = "";
    for (const pageRef of refs) {
      if (path.posix.dirname(pageRef) !== sourceDir) continue;
      const link = staged[pageRef].getString("raw_source");
      if (link === "") continue;
      const { dest, ok } = linkDest(link);
      if (ok && resolveLinkDest(dest, path.posix.dirname(pageRef)) === raw) {
        stubRef = pageRef;
        break;
      }
    }
    if (stubRef === "") {
      const onDisk = existingStub === undefined ? "" : existingStub(raw);
      problems.push(
        `${raw} needs a wiki/${KindFolders["source"]}/ stub among the pages this plan writes whose raw_source points at it` +
          (onDisk === ""
            ? ` — add one (op:"create", kind:"source", even a thin one)`
            : ` — ${onDisk} on disk already stands in for it, so bring it into the plan (op:"update")`) +
          `; every other page in the plan — updates included — needs a source edge to that stub`,
      );
    } else {
      stubRefs.add(stubRef);
    }
  }

  if (stubRefs.size === 0) return problems;

  // Every non-stub page must source at least one stub from this plan.
  const sortedStubs = [...stubRefs].sort();
  for (const pageRef of refs) {
    if (stubRefs.has(pageRef)) continue;
    const links = staged[pageRef].getStringList("source");
    const pageDir = path.posix.dirname(pageRef);
    let found = false;
    for (const link of links) {
      const { dest, ok } = linkDest(link);
      if (ok) {
        const resolved = resolveLinkDest(dest, pageDir);
        if (stubRefs.has(resolved)) {
          found = true;
          break;
        }
      }
    }
    if (!found) {
      problems.push(
        `${pageRef} needs a source edge to one of the plan's stubs (${sortedStubs.join(", ")})`,
      );
    }
  }
  return problems;
}

/**
 * Report whether staged leaves a valid page -> stub -> raw chain. staged holds
 * every page one ingestion/commit touches, keyed by its post-write
 * vault-relative path. Returns problems, empty when the chain holds, in
 * sorted-ref order so the result never depends on map order. Throws on
 * unparseable frontmatter rather than treating the page as edge-less.
 * [existingStub] is consulted only when no staged page stands in, and only to
 * name an on-disk stand-in in the problem.
 */
export function check(
  staged: Record<string, Page>,
  raw: string,
  existingStub?: StubLookup,
): string[] {
  raw = path.posix.normalize(raw);
  const refs = sortedRefs(staged);

  let stubRef = "";
  for (const pageRef of refs) {
    if (path.posix.dirname(pageRef) !== sourceDir) continue;
    const link = staged[pageRef].getString("raw_source");
    if (link === "") continue;
    const { dest, ok } = linkDest(link);
    if (ok && resolveLinkDest(dest, path.posix.dirname(pageRef)) === raw) {
      stubRef = pageRef;
      break;
    }
  }

  if (stubRef === "") {
    const onDisk = existingStub === undefined ? "" : existingStub(raw);
    return [
      `${raw} needs a wiki/${KindFolders["source"]}/ stub among the pages this plan writes whose raw_source points at it` +
        (onDisk === ""
          ? ` — add one (op:"create", kind:"source", even a thin one)`
          : ` — ${onDisk} on disk already stands in for it, so bring it into the plan (op:"update")`) +
        `; every other page in the plan — updates included — needs a source edge to that stub`,
    ];
  }

  const problems: string[] = [];
  for (const pageRef of refs) {
    if (pageRef === stubRef) continue;
    const links = staged[pageRef].getStringList("source");
    const pageDir = path.posix.dirname(pageRef);
    let found = false;
    for (const link of links) {
      const { dest, ok } = linkDest(link);
      if (ok && resolveLinkDest(dest, pageDir) === stubRef) {
        found = true;
        break;
      }
    }
    if (!found) {
      problems.push(`${pageRef} needs a source edge to the stub ${stubRef}`);
    }
  }
  return problems;
}

function sortedRefs(staged: Record<string, Page>): string[] {
  return Object.keys(staged).sort();
}
