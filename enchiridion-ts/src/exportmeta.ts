/**
 * The pure metadata pass for `enchiridion export` — tags, kinds, inbound-link
 * counts and the get-started ranking — with no filesystem or model access.
 *
 * The exported set is wiki/ always, raw/ only when `includeRaw`; decided here
 * once and published as [ExportMeta.exported]. A nominated start page is mapped
 * to the front page's output path by [ExportMeta.outputPathFor].
 */

import path from "node:path";
import { PageRecord } from "./pagerecord.js";
import { iterLinks, resolveLinkDest } from "./wikipage.js";
import { KindFolders, slugify } from "./place.js";

/** The front page's output path — the one path naming a role, not a page. */
export const FRONT_PAGE_PATH = "index.html";

/** The slug the tags index occupies under `tags/`; a tag that would take it
 *  moves aside in [buildTagSlugMap], since the two would otherwise collide on
 *  output path (and, in single-file output, on the `tags-index` section id). */
export const TAGS_INDEX_SLUG = "index";

/** The output path of the page for a tag's slug. */
export function tagPagePath(slug: string): string {
  return `tags/${slug}.html`;
}

export const TAGS_INDEX_PATH = tagPagePath(TAGS_INDEX_SLUG);

/** Vault-relative `.md` → `.html`; a non-markdown ref (a `raw/` artifact
 *  keeping its own extension) is left alone. */
export function mdToHtml(ref: string): string {
  return ref.endsWith(".md") ? ref.slice(0, -3) + ".html" : ref;
}

export type OutputPathFor = (pageRef: string) => string;

/** One user-supplied entry for the get-started block. */
export interface StarterEntry {
  pageRef: string;
  annotation?: string;
}

/** Options controlling which subtrees are included in the export. */
export interface ExportOptions {
  /** Include raw/ pages in the exported set; default false. */
  includeRaw?: boolean;
  /** User-supplied get-started list, replacing the fallback ranking; refs not
   *  in the exported set are silently skipped. */
  starters?: StarterEntry[];
  /** Wiki title for the nav and front page, already resolved by the caller. */
  title?: string;
  /** Normalised vault-relative ref of the page filling the front page;
   *  undefined means none. */
  startPage?: string;
}

/** The nav title when the caller has no vault to name. */
const UNNAMED_VAULT_TITLE = "Wiki";

export function exportTitle(opts: ExportOptions): string {
  return opts.title?.trim() || UNNAMED_VAULT_TITLE;
}

export interface GetStartedEntry {
  pageRef: string;
  title: string;
  summary: string;
  kind: string;
  tags: string[];
  inboundCount: number;
}

export interface ExportMeta {
  /**
   * Which pageRefs the export carries — wiki/ always, raw/ only under
   * `includeRaw`. The one owner of that rule: consumers ask this set rather
   * than re-deriving it from ref prefixes.
   */
  exported: Set<string>;
  /** Tag → sorted pageRefs. A start page is listed like any other member. */
  tagMap: Map<string, string[]>;
  /**
   * Kind → the pageRefs that kind's index lists. A start page is absent (it is
   * already the front page), and a kind left with no members is absent, so no
   * index page is written for it.
   */
  kindMap: Map<string, string[]>;
  /** pageRef → count of exported pages linking to it. */
  inboundCounts: Map<string, number>;
  /** Top-12 fallback candidates, ranked by inbound count then title; wiki/
   *  only, even under `includeRaw`. */
  getStarted: GetStartedEntry[];
  /** The ref filling the front page, when one was nominated. */
  startPage?: string;
  /**
   * Where a pageRef's output is written: the start page at [FRONT_PAGE_PATH],
   * every other page at its own `.html` path. With no start page this is
   * [mdToHtml] and nothing else.
   */
  outputPathFor: OutputPathFor;
}

const GET_STARTED_COUNT = 12;

/**
 * Map each tag to a unique URL slug; tags sharing a base slug get "foo",
 * "foo-2", "foo-3", …. Input is sorted for determinism before assignment.
 *
 * [TAGS_INDEX_SLUG] is reserved after the ordinary assignment, so a tag that
 * naturally slugifies to `index-2` keeps it.
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

  for (const [tag, slug] of slugMap) {
    if (slug !== TAGS_INDEX_SLUG) continue;
    let n = 2;
    let candidate = `${TAGS_INDEX_SLUG}-${n}`;
    while (assigned.has(candidate)) {
      n++;
      candidate = `${TAGS_INDEX_SLUG}-${n}`;
    }
    slugMap.set(tag, candidate);
    assigned.add(candidate);
  }

  return slugMap;
}

/**
 * Every vault-relative link target in a page's full text (body + frontmatter),
 * resolved; anchor fragments stripped, duplicates dropped.
 */
function outboundRefs(pageRef: string, body: string): Set<string> {
  const pageDir = path.posix.dirname(pageRef);
  // resolveLinkDest expects "" for vault root; dirname returns "." for flat paths.
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
 * All aggregate metadata from pageRef → { record?, text } plus export options.
 * `text` feeds link extraction; a raw/ ref may omit its record and then
 * contributes only inbound counts.
 */
export function buildExportMeta(
  pages: Map<string, { record?: PageRecord; text: string }>,
  opts: ExportOptions = {},
): ExportMeta {
  const includeRaw = opts.includeRaw ?? false;
  const startPage = opts.startPage;

  const outputPathFor: OutputPathFor = (pageRef) =>
    startPage !== undefined && pageRef === startPage
      ? FRONT_PAGE_PATH
      : mdToHtml(pageRef);

  const exported = new Set<string>();
  for (const pageRef of pages.keys()) {
    if (
      pageRef.startsWith("wiki/") ||
      (includeRaw && pageRef.startsWith("raw/"))
    ) {
      exported.add(pageRef);
    }
  }

  const tagMap = new Map<string, string[]>();
  const kindMap = new Map<string, string[]>();
  const inboundCounts = new Map<string, number>();

  for (const pageRef of exported) {
    inboundCounts.set(pageRef, 0);
  }

  for (const pageRef of exported) {
    const entry = pages.get(pageRef)!;
    const { record } = entry;

    if (pageRef.startsWith("wiki/") && record) {
      for (const tag of record.tags) {
        if (!tagMap.has(tag)) tagMap.set(tag, []);
        tagMap.get(tag)!.push(pageRef);
      }

      const kind = record.kind;
      if (pageRef !== startPage) {
        if (!kindMap.has(kind)) kindMap.set(kind, []);
        kindMap.get(kind)!.push(pageRef);
      }
    }

    const refs = outboundRefs(pageRef, entry.text);
    for (const target of refs) {
      if (exported.has(target)) {
        inboundCounts.set(target, (inboundCounts.get(target) ?? 0) + 1);
      }
    }
  }

  for (const list of tagMap.values()) list.sort();
  for (const list of kindMap.values()) list.sort();

  // Wiki-only is this list's own rule, not a consequence of `exported`: under
  // includeRaw the export carries raw/ pages the fallback must never rank.
  const wikiEntries: GetStartedEntry[] = [];
  for (const [pageRef, entry] of pages) {
    if (!pageRef.startsWith("wiki/")) continue;
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

  return {
    exported,
    tagMap,
    kindMap,
    inboundCounts,
    getStarted,
    startPage,
    outputPathFor,
  };
}

/**
 * The folder a kind's pages live in: the canonical kind folder when the plugin
 * fixes one, else inferred from the page's own path.
 */
export function kindFolder(kind: string, pageRefs: string[]): string {
  if (KindFolders[kind]) return KindFolders[kind];
  if (pageRefs.length > 0) {
    const parts = pageRefs[0].split("/");
    if (parts.length >= 2) return parts[1];
  }
  return kind;
}

/** The kind index's label — its folder, capitalised. */
export function kindLabel(folder: string): string {
  return folder.charAt(0).toUpperCase() + folder.slice(1);
}
