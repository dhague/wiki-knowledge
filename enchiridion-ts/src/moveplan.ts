/**
 * Move and consolidation planning — the post-operation vault computed from page
 * texts, plus the comparison normal form a Consolidation's losslessness check
 * needs. Pure: no I/O.
 */

import { Page } from "./frontmatter.js";
import { isVaultRelativeDest } from "./linkencoding.js";
import { applyEdits, iterLinks, resolveLinkDest } from "./wikipage.js";
import type { Edit } from "./wikipage.js";

/**
 * Compute the post-move vault from pages (a {pageRef: text} map). Pure: the
 * moved page appears under newRel, every other page keeps its key, and inbound
 * and outbound links are both fixed.
 *
 * oldRel need not be a key of pages: a caller retargeting links at a non-page
 * file (a `raw/` artifact) passes only the pages whose *inbound* links should
 * follow the rename.
 */
export function planMove(
  pages: Record<string, string>,
  oldRel: string,
  newRel: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rel, text] of Object.entries(pages)) {
    const key = rel === oldRel ? newRel : rel;
    out[key] = new Page(text).retarget(rel, oldRel, newRel).text;
  }
  return out;
}

/**
 * [planMove]'s sibling for consolidation: every link to a consolidated page is
 * repointed at `survivor`, and the consolidated pages are dropped. The
 * survivor's text is whatever the caller placed at `survivor` in `pages` —
 * including a freshly authored one. Moves links and nothing else, the link half
 * of a Consolidation being lossless (ADR-0021).
 */
export function planConsolidate(
  pages: Record<string, string>,
  losers: string[],
  survivor: string,
): Record<string, string> {
  const dropped = new Set(losers);
  const out: Record<string, string> = {};
  for (const [rel, text] of Object.entries(pages)) {
    if (dropped.has(rel)) continue;
    // One pass per consolidated page, so the mapping composes as repeated
    // rewriteText calls do.
    let next = text;
    for (const loser of losers) {
      next = new Page(next).retarget(rel, loser, survivor).text;
    }
    out[rel] = next;
  }
  return out;
}

/**
 * Return text with every vault-relative link/image destination replaced by the
 * vault-relative page it resolves to from pageDir (ADR-0009) — the document
 * read as *where it points* rather than how each destination is spelled.
 *
 * A comparison helper, not a writer: nothing here percent-encodes and the
 * result never reaches disk. Two spellings of the same link come out identical,
 * which is what lets a Consolidation's losslessness check (ADR-0021) compare an
 * absorbed body against that same body inside the survivor.
 *
 * `target` maps a resolved vault-relative ref to the ref a reader should treat
 * it as. Destinations that aren't vault-relative — URLs, absolute paths, bare
 * anchors — are left byte-identical.
 */
export function canonicalizeLinkTargets(
  text: string,
  pageDir: string,
  target: (ref: string) => string = (ref) => ref,
): string {
  const edits: Edit[] = [];
  for (const link of iterLinks(text)) {
    if (!isVaultRelativeDest(link.decodedPath)) continue;
    const resolved = target(resolveLinkDest(link.decodedPath, pageDir));
    const dest =
      link.decodedAnchor === ""
        ? resolved
        : `${resolved}#${link.decodedAnchor}`;
    if (dest !== link.dest)
      edits.push({ start: link.start, end: link.end, dest });
  }
  return applyEdits(text, edits);
}
