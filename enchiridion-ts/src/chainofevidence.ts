/**
 * chainofevidence — the page -> stub -> raw file chain every raw ingestion must
 * leave: a raw file producing pages must also produce a `wiki/sources/` stub
 * whose `raw_source` points back at it, and every other page from it must carry
 * a `source` edge to that stub.
 *
 * `ingest` runs it before any write; `commit` re-runs it as the hard gate.
 */

import path from "node:path";
import { KindFolders } from "./place.js";
import { Page, linkDest, resolveLinkDest } from "./wikipage.js";

const sourceDir = `wiki/${KindFolders["source"]}`;

/**
 * Report whether staged leaves a valid page -> stub -> raw chain. staged holds
 * every page one ingestion/commit touches, keyed by its post-write
 * vault-relative path. Returns problems, empty when the chain holds, in
 * sorted-ref order so the result never depends on map order. Throws on
 * unparseable frontmatter rather than treating the page as edge-less.
 */
export function check(staged: Record<string, Page>, raw: string): string[] {
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
    return [
      `${raw} needs a ${KindFolders["source"]}/ page whose raw_source points at it ` +
        `— every ingested raw file gets a stand-in, even a thin stub`,
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
