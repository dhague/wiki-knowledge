/**
 * Aggregate HTML pages for `enchiridion export`.
 *
 * Yields the index and listing pages that sit alongside the per-page output
 * from renderPages:
 *   - tags/<slug>.html   — one per tag, listing every page that carries it
 *   - tags/index.html    — all tags with page counts
 *   - wiki/<folder>/index.html — per-kind listing pages
 *   - index.html         — front page (counts, kind summaries, get-started)
 *
 * Pure: no filesystem access, no model. The same RenderedPage type as
 * renderPages; callers concatenate both generators to get the full output set.
 */

import path from "node:path";
import { parse as parseYaml } from "yaml";
import { PageRecord } from "./pagerecord.js";
import {
  ExportMeta,
  ExportOptions,
  GetStartedEntry,
  buildTagSlugMap,
} from "./exportmeta.js";
import {
  RenderedPage,
  escHtml,
  buildHtmlShell,
  mdToHtml,
} from "./exportrender.js";
import { KindFolders } from "./place.js";
import { splitFrontmatter } from "./wikipage.js";

// ---------------------------------------------------------------------------
// Nav bar for aggregate pages (takes the html output path directly)
// ---------------------------------------------------------------------------

function navBar(htmlPath: string): string {
  const depth = htmlPath.split("/").length - 1;
  const prefix = depth === 0 ? "./" : "../".repeat(depth);
  return `<nav><a href="${prefix}index.html">Home</a> · <a href="${prefix}tags/index.html">Tags</a></nav>`;
}

// ---------------------------------------------------------------------------
// KIND.md summary blurb
// ---------------------------------------------------------------------------

function kindBlurb(
  kind: string,
  pages: Map<string, { record?: PageRecord; text: string }>,
): string {
  const folder = KindFolders[kind];
  if (!folder) return "";
  const ref = `wiki/${folder}/KIND.md`;
  const entry = pages.get(ref);
  if (!entry) return "";
  const { frontmatter, hasFrontmatter } = splitFrontmatter(entry.text);
  if (!hasFrontmatter) return "";
  const fm = parseYaml(frontmatter) as unknown;
  if (typeof fm !== "object" || fm === null) return "";
  return String((fm as Record<string, unknown>)["summary"] ?? "");
}

// ---------------------------------------------------------------------------
// Folder for a kind — canonical first, then infer from page paths
// ---------------------------------------------------------------------------

function kindFolder(kind: string, pageRefs: string[]): string {
  if (KindFolders[kind]) return KindFolders[kind];
  // Infer from first page: wiki/<folder>/...
  if (pageRefs.length > 0) {
    const parts = pageRefs[0].split("/");
    if (parts.length >= 2) return parts[1];
  }
  return kind;
}

// ---------------------------------------------------------------------------
// Page link helper (used by tag pages and kind index pages)
// ---------------------------------------------------------------------------

function pageLink(
  fromHtmlPath: string,
  toPageRef: string,
  title: string,
): string {
  const toHtml = mdToHtml(toPageRef);
  const rel = path.posix.relative(path.posix.dirname(fromHtmlPath), toHtml);
  return `<a href="${escHtml(rel)}">${escHtml(title)}</a>`;
}

// ---------------------------------------------------------------------------
// Tag pages
// ---------------------------------------------------------------------------

function renderTagPage(
  tag: string,
  slug: string,
  pageRefs: string[],
  pages: Map<string, { record?: PageRecord; text: string }>,
): RenderedPage {
  const htmlPath = `tags/${slug}.html`;
  const nav = navBar(htmlPath);
  const items = pageRefs
    .map((ref) => {
      const title = pages.get(ref)?.record?.title ?? ref;
      const link = pageLink(htmlPath, ref, title);
      return `<li>${link}</li>`;
    })
    .join("\n");
  const main = `<h1>${escHtml(tag)}</h1>\n<ul>\n${items}\n</ul>`;
  return { path: htmlPath, content: buildHtmlShell(escHtml(tag), nav, main) };
}

// ---------------------------------------------------------------------------
// Tag index page
// ---------------------------------------------------------------------------

function renderTagIndex(
  tagSlugMap: Map<string, string>,
  meta: ExportMeta,
): RenderedPage {
  const htmlPath = "tags/index.html";
  const nav = navBar(htmlPath);

  const sortedTags = [...tagSlugMap.keys()].sort();
  const rows = sortedTags.map((tag) => {
    const slug = tagSlugMap.get(tag)!;
    const count = meta.tagMap.get(tag)?.length ?? 0;
    return `<li><a href="${escHtml(slug)}.html">${escHtml(tag)}</a> (${count})</li>`;
  });

  const main = `<h1>Tags</h1>\n<ul>\n${rows.join("\n")}\n</ul>`;
  return { path: htmlPath, content: buildHtmlShell("Tags", nav, main) };
}

// ---------------------------------------------------------------------------
// Kind index pages
// ---------------------------------------------------------------------------

function renderKindIndex(
  kind: string,
  folder: string,
  pageRefs: string[],
  pages: Map<string, { record?: PageRecord; text: string }>,
): RenderedPage {
  const htmlPath = `wiki/${folder}/index.html`;
  const nav = navBar(htmlPath);

  const label = folder.charAt(0).toUpperCase() + folder.slice(1);
  const items = pageRefs
    .map((ref) => {
      const record = pages.get(ref)?.record;
      const title = record?.title ?? ref;
      const summary = record?.summary ?? "";
      const link = pageLink(htmlPath, ref, title);
      const summaryHtml = summary ? ` — ${escHtml(summary)}` : "";
      return `<li>${link}${summaryHtml}</li>`;
    })
    .join("\n");

  const main = `<h1>${escHtml(label)}</h1>\n<ul>\n${items}\n</ul>`;
  return {
    path: htmlPath,
    content: buildHtmlShell(escHtml(label), nav, main),
  };
}

// ---------------------------------------------------------------------------
// Front page
// ---------------------------------------------------------------------------

function renderFrontPage(
  meta: ExportMeta,
  opts: ExportOptions,
  pages: Map<string, { record?: PageRecord; text: string }>,
  tagSlugMap: Map<string, string>,
): RenderedPage {
  const htmlPath = "index.html";
  const nav = navBar(htmlPath);

  // Total page count
  const totalPages = Array.from(meta.kindMap.values()).reduce(
    (sum, refs) => sum + refs.length,
    0,
  );

  // Per-kind section
  const kindRows = [...meta.kindMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, refs]) => {
      const folder = kindFolder(kind, refs);
      const blurb = kindBlurb(kind, pages);
      const label = folder.charAt(0).toUpperCase() + folder.slice(1);
      const blurbHtml = blurb ? ` — ${escHtml(blurb)}` : "";
      return `<li><a href="${escHtml(`wiki/${folder}/index.html`)}">${escHtml(label)}</a> (${refs.length})${blurbHtml}</li>`;
    });

  // Get-started block
  const exported = new Set<string>();
  for (const ref of pages.keys()) {
    if (ref.startsWith("wiki/")) exported.add(ref);
    if ((opts.includeRaw ?? false) && ref.startsWith("raw/")) exported.add(ref);
  }

  let startedItems: string[];
  const suppliedStarters = opts.starters?.filter((s) =>
    exported.has(s.pageRef),
  );
  if (suppliedStarters && suppliedStarters.length > 0) {
    startedItems = suppliedStarters.map(({ pageRef, annotation }) => {
      const title = pages.get(pageRef)?.record?.title ?? pageRef;
      const link = pageLink(htmlPath, pageRef, title);
      const annHtml = annotation ? ` — ${escHtml(annotation)}` : "";
      return `<li>${link}${annHtml}</li>`;
    });
  } else {
    startedItems = meta.getStarted.map((entry: GetStartedEntry) => {
      const link = pageLink(htmlPath, entry.pageRef, entry.title);
      const summaryHtml = entry.summary ? ` — ${escHtml(entry.summary)}` : "";
      return `<li>${link}${summaryHtml}</li>`;
    });
  }

  const main = [
    `<h1>Wiki</h1>`,
    `<p>${totalPages} page${totalPages === 1 ? "" : "s"} · <a href="tags/index.html">Tags</a></p>`,
    `<section>`,
    `<h2>Browse by Kind</h2>`,
    `<ul>`,
    ...kindRows,
    `</ul>`,
    `</section>`,
    `<section>`,
    `<h2>Get Started</h2>`,
    `<ul>`,
    ...startedItems,
    `</ul>`,
    `</section>`,
  ].join("\n");

  return { path: htmlPath, content: buildHtmlShell("Wiki", nav, main) };
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

/**
 * Lazy generator yielding aggregate HTML pages for the exported vault.
 *
 * Yields (in order): tag pages, tag index, per-kind index pages, front page.
 * Concatenate with renderPages to get the complete output set.
 */
export function* renderAggregatePages(
  pages: Map<string, { record?: PageRecord; text: string }>,
  meta: ExportMeta,
  opts: ExportOptions = {},
): Generator<RenderedPage> {
  const tagSlugMap = buildTagSlugMap([...meta.tagMap.keys()]);

  // Tag pages
  for (const [tag, pageRefs] of meta.tagMap) {
    const slug = tagSlugMap.get(tag)!;
    yield renderTagPage(tag, slug, pageRefs, pages);
  }

  // Tag index (always emit — nav on every page links to it)
  yield renderTagIndex(tagSlugMap, meta);

  // Per-kind index pages
  for (const [kind, pageRefs] of meta.kindMap) {
    const folder = kindFolder(kind, pageRefs);
    yield renderKindIndex(kind, folder, pageRefs, pages);
  }

  // Front page
  yield renderFrontPage(meta, opts, pages, tagSlugMap);
}
