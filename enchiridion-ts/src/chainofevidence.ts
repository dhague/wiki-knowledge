/**
 * chainofevidence — the page -> stub -> raw file chain every raw ingestion must
 * leave: a raw file producing pages must also produce a `wiki/sources/` stub
 * whose `raw_source` points back at it, and every other page from it must carry
 * a `source` edge to that stub.
 *
 * The stand-in must be one of the plan's own pages — `commit` re-runs this gate
 * over the manifest's pages alone, so a stub already in the vault is worth
 * naming but never satisfies the rule.
 *
 * `ingest` runs it before any write; `commit` re-runs it as the hard gate.
 */

import path from "node:path";
import { KindFolders } from "./place.js";
import { Page, linkDest, resolveLinkDest } from "./wikipage.js";

const sourceDir = `wiki/${KindFolders["source"]}`;

/** Find the vault's own stand-in for a raw artifact, or "" — consulted only to
 * word a refusal, never to satisfy the rule. */
export type StubLookup = (raw: string) => string;

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
      `${raw} needs a wiki/${KindFolders["source"]}/ stub among this plan's own pages whose raw_source points at it ` +
        `(op:"create", kind:"source", even a thin one)` +
        (onDisk === ""
          ? ""
          : ` — ${onDisk} on disk already stands in for it, but the stub must be one of this plan's pages`) +
        `, and every other page in the plan — updates included — needs a source edge to that stub`,
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
