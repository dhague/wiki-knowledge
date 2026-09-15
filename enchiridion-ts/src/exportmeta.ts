/**
 * Pure metadata pass for `enchiridion export`.
 *
 * Takes an array of in-memory page records (already loaded via loadRecords)
 * plus export options and produces all aggregate metadata the render pass
 * needs: tag→pages map, per-kind page lists, inbound-link counts, and the
 * fallback get-started ranking. No filesystem access, no model — purely
 * deterministic from its inputs.
 *
 * "Exported set" is determined by ExportOptions: wiki/ pages are always
 * included; raw/ pages only when includeRaw is true. Inbound-link counts
 * only count links whose sources and targets are both within the exported
 * set.
 */

import path from "node:path";
import { PageRecord } from "./pagerecord.js";
import { iterLinks, resolveLinkDest } from "./wikipage.js";
import { slugify } from "./place.js";

/** One user-supplied entry for the get-started block. */
export interface StarterEntry {
  pageRef: string;
  /** Optional annotation shown next to the link. */
  annotation?: string;
}

/** Options controlling which subtrees are included in the export. */
export interface ExportOptions {
  /** When true, raw/ pages are included in the exported set. Default false. */
  includeRaw?: boolean;
  /**
   * User-supplied get-started list. When provided, the front page uses these
   * instead of the fallback ranking. pageRefs not in the exported set are
   * silently skipped.
   */
  starters?: StarterEntry[];
}

/** One entry in the get-started ranking. */
export interface GetStartedEntry {
  pageRef: string;
  title: string;
  summary: string;
  kind: string;
  tags: string[];
  inboundCount: number;
}

/** All aggregate metadata produced by the pure metadata pass. */
export interface ExportMeta {
  /** Map from tag string to sorted list of pageRefs carrying that tag. */
  tagMap: Map<string, string[]>;
  /** Map from kind string to sorted list of pageRefs of that kind. */
  kindMap: Map<string, string[]>;
  /** Map from pageRef to count of exported pages that link to it. */
  inboundCounts: Map<string, number>;
  /**
   * Top-12 get-started candidates, ranked by inbound-link count (desc),
   * title tie-break (asc). Only wiki/ pages; raw/ excluded even when
   * includeRaw is true.
   */
  getStarted: GetStartedEntry[];
}

/** Number of pages in the fallback get-started list. */
const GET_STARTED_COUNT = 12;

/**
 * Maps each tag string to a unique URL slug. Tags that produce the same base
 * slug get a numeric suffix: "foo", "foo-2", "foo-3", …
 * Input is sorted for determinism before assignment.
 */
export function buildTagSlugMap(tags: string[]): Map<string, string> {
  const sorted = [...tags].sort();
  const slugMap = new Map<string, string>();
  const assigned = new Set<string>();

  for (const tag of sorted) {
    const base = slugify(tag, 0);
    if (!assigned.has(base)) {
      slugMap.set(tag, base);
      assigned.add(base);
    } else {
      let n = 2;
      let candidate = `${base}-${n}`;
      while (assigned.has(candidate)) {
        n++;
        candidate = `${base}-${n}`;
      }
      slugMap.set(tag, candidate);
      assigned.add(candidate);
    }
  }

  return slugMap;
}

/**
 * Collect all vault-relative link targets found in a page's full text
 * (body + frontmatter), resolving relative destinations to vault-relative
 * paths. Anchor fragments are stripped; duplicate targets are deduplicated.
 */
function outboundRefs(pageRef: string, body: string): Set<string> {
  const pageDir = path.posix.dirname(pageRef);
  // resolveLinkDest expects "" for vault root; path.posix.dirname returns "." for flat paths.
  const baseDir = pageDir === "." ? "" : pageDir;
  const refs = new Set<string>();
  for (const link of iterLinks(body)) {
    if (link.isImage) continue;
    const resolved = resolveLinkDest(link.decodedPath, baseDir);
    refs.add(resolved);
  }
  return refs;
}

/**
 * Compute all aggregate export metadata from a map of pageRef → { record?,
 * text } entries and export options.
 *
 * `pages` maps vault-relative page refs (e.g. `wiki/concepts/foo.md`) to
 * objects with the full page text (used for link extraction) and an optional
 * parsed PageRecord. Wiki pages (`wiki/`) supply a record; raw pages (`raw/`)
 * may omit it — they contribute inbound-link counts only, never tags or kinds.
 */
export function buildExportMeta(
  pages: Map<string, { record?: PageRecord; text: string }>,
  opts: ExportOptions = {},
): ExportMeta {
  const includeRaw = opts.includeRaw ?? false;

  // Build the exported set — which pageRefs are included.
  const exported = new Set<string>();
  for (const pageRef of pages.keys()) {
    if (
      pageRef.startsWith("wiki/") ||
      (includeRaw && pageRef.startsWith("raw/"))
    ) {
      exported.add(pageRef);
    }
  }

  // tag → pageRefs
  const tagMap = new Map<string, string[]>();
  // kind → pageRefs
  const kindMap = new Map<string, string[]>();
  // pageRef → inbound count
  const inboundCounts = new Map<string, number>();

  // Initialise counts for every exported page.
  for (const pageRef of exported) {
    inboundCounts.set(pageRef, 0);
  }

  for (const pageRef of exported) {
    const entry = pages.get(pageRef)!;
    const { record } = entry;

    // Tags and kinds — only wiki/ pages with a record contribute.
    if (pageRef.startsWith("wiki/") && record) {
      for (const tag of record.tags) {
        if (!tagMap.has(tag)) tagMap.set(tag, []);
        tagMap.get(tag)!.push(pageRef);
      }

      const kind = record.kind;
      if (!kindMap.has(kind)) kindMap.set(kind, []);
      kindMap.get(kind)!.push(pageRef);
    }

    // Inbound-link counts — walk all links in the page text.
    const refs = outboundRefs(pageRef, entry.text);
    for (const target of refs) {
      if (exported.has(target)) {
        inboundCounts.set(target, (inboundCounts.get(target) ?? 0) + 1);
      }
    }
  }

  // Sort tagMap values and kindMap values for determinism.
  for (const list of tagMap.values()) list.sort();
  for (const list of kindMap.values()) list.sort();

  // Build get-started ranking — wiki/ pages only, ranked by inbound count
  // desc, title asc as tie-break.
  const wikiEntries: GetStartedEntry[] = [];
  for (const pageRef of exported) {
    if (!pageRef.startsWith("wiki/")) continue;
    const entry = pages.get(pageRef)!;
    const { record } = entry;
    if (!record) continue;
    wikiEntries.push({
      pageRef,
      title: record.title,
      summary: record.summary,
      kind: record.kind,
      tags: record.tags,
      inboundCount: inboundCounts.get(pageRef) ?? 0,
    });
  }

  wikiEntries.sort((a, b) => {
    const byCount = b.inboundCount - a.inboundCount;
    if (byCount !== 0) return byCount;
    return a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
  });

  const getStarted = wikiEntries.slice(0, GET_STARTED_COUNT);

  return { tagMap, kindMap, inboundCounts, getStarted };
}
