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
 * Two layers, matching exportrender: renderAggregateParts yields pages with
 * no document shell, renderAggregatePages wraps them in the multi-page shape.
 *
 * Pure: no filesystem access, no model. The same RenderedParts/RenderedPage
 * types as exportrender; callers concatenate the matching generators from both
 * modules to get the full output set.
 */

import { parse as parseYaml } from "yaml";
import { PageRecord } from "./pagerecord.js";
import {
  ExportMeta,
  ExportOptions,
  GetStartedEntry,
  buildTagSlugMap,
  exportTitle,
} from "./exportmeta.js";
import {
  LinkMode,
  RenderedParts,
  RenderedPage,
  buildNavBar,
  escHtml,
  hrefFor,
  mdToHtml,
  shellPages,
} from "./exportrender.js";
import { KindFolders } from "./place.js";
import { splitFrontmatter } from "./wikipage.js";

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
  mode: LinkMode,
): string {
  return `<a href="${escHtml(hrefFor(mode)(fromHtmlPath, mdToHtml(toPageRef)))}">${escHtml(title)}</a>`;
}

// ---------------------------------------------------------------------------
// Tag pages
// ---------------------------------------------------------------------------

function renderTagPage(
  tag: string,
  slug: string,
  pageRefs: string[],
  pages: Map<string, { record?: PageRecord; text: string }>,
  wikiTitle: string,
  mode: LinkMode,
): RenderedParts {
  const htmlPath = `tags/${slug}.html`;
  const nav = buildNavBar(htmlPath, wikiTitle, mode);
  const items = pageRefs
    .map((ref) => {
      const title = pages.get(ref)?.record?.title ?? ref;
      const link = pageLink(htmlPath, ref, title, mode);
      return `<li>${link}</li>`;
    })
    .join("\n");
  const main = `<h1>${escHtml(tag)}</h1>\n<ul>\n${items}\n</ul>`;
  return { path: htmlPath, parts: { title: tag, nav, main } };
}

// ---------------------------------------------------------------------------
// Tag index page
// ---------------------------------------------------------------------------

function renderTagIndex(
  tagSlugMap: Map<string, string>,
  meta: ExportMeta,
  wikiTitle: string,
  mode: LinkMode,
): RenderedParts {
  const htmlPath = "tags/index.html";
  const nav = buildNavBar(htmlPath, wikiTitle, mode);

  const sortedTags = [...tagSlugMap.keys()].sort();
  const rows = sortedTags.map((tag) => {
    const slug = tagSlugMap.get(tag)!;
    const count = meta.tagMap.get(tag)?.length ?? 0;
    const href = escHtml(hrefFor(mode)(htmlPath, `tags/${slug}.html`));
    return `<li><a href="${href}">${escHtml(tag)}</a> (${count})</li>`;
  });

  const main = `<h1>Tags</h1>\n<ul>\n${rows.join("\n")}\n</ul>`;
  return { path: htmlPath, parts: { title: "Tags", nav, main } };
}

// ---------------------------------------------------------------------------
// Kind index pages
// ---------------------------------------------------------------------------

function renderKindIndex(
  kind: string,
  folder: string,
  pageRefs: string[],
  pages: Map<string, { record?: PageRecord; text: string }>,
  wikiTitle: string,
  mode: LinkMode,
): RenderedParts {
  const htmlPath = `wiki/${folder}/index.html`;
  const nav = buildNavBar(htmlPath, wikiTitle, mode);

  const label = folder.charAt(0).toUpperCase() + folder.slice(1);
  const items = pageRefs
    .map((ref) => {
      const record = pages.get(ref)?.record;
      const title = record?.title ?? ref;
      const summary = record?.summary ?? "";
      const link = pageLink(htmlPath, ref, title, mode);
      const summaryHtml = summary ? ` — ${escHtml(summary)}` : "";
      return `<li>${link}${summaryHtml}</li>`;
    })
    .join("\n");

  const main = `<h1>${escHtml(label)}</h1>\n<ul>\n${items}\n</ul>`;
  return { path: htmlPath, parts: { title: label, nav, main } };
}

// ---------------------------------------------------------------------------
// Front page
// ---------------------------------------------------------------------------

function renderFrontPage(
  meta: ExportMeta,
  opts: ExportOptions,
  pages: Map<string, { record?: PageRecord; text: string }>,
  tagSlugMap: Map<string, string>,
  wikiTitle: string,
  mode: LinkMode,
): RenderedParts {
  const htmlPath = "index.html";
  const nav = buildNavBar(htmlPath, wikiTitle, mode);

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
      const href = escHtml(
        hrefFor(mode)(htmlPath, `wiki/${folder}/index.html`),
      );
      return `<li><a href="${href}">${escHtml(label)}</a> (${refs.length})${blurbHtml}</li>`;
    });

  // Get-started block. An explicitly supplied starter is admitted when the
  // export carries it — `meta.exported` is that set, raw/ included under
  // includeRaw, so a raw starter the operator named is emitted. The fallback
  // list below is the ranked candidates, which are wiki-only by their own
  // construction (see buildExportMeta); nothing here re-derives either rule.
  let startedItems: string[];
  const suppliedStarters = opts.starters?.filter((s) =>
    meta.exported.has(s.pageRef),
  );
  if (suppliedStarters && suppliedStarters.length > 0) {
    startedItems = suppliedStarters.map(({ pageRef, annotation }) => {
      const title = pages.get(pageRef)?.record?.title ?? pageRef;
      const link = pageLink(htmlPath, pageRef, title, mode);
      const annHtml = annotation ? ` — ${escHtml(annotation)}` : "";
      return `<li>${link}${annHtml}</li>`;
    });
  } else {
    startedItems = meta.getStarted.map((entry: GetStartedEntry) => {
      const link = pageLink(htmlPath, entry.pageRef, entry.title, mode);
      const summaryHtml = entry.summary ? ` — ${escHtml(entry.summary)}` : "";
      return `<li>${link}${summaryHtml}</li>`;
    });
  }

  const tagsHref = escHtml(hrefFor(mode)(htmlPath, "tags/index.html"));
  const main = [
    `<h1>${escHtml(wikiTitle)}</h1>`,
    `<p>${totalPages} page${totalPages === 1 ? "" : "s"} · <a href="${tagsHref}">Tags</a></p>`,
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

  return { path: htmlPath, parts: { title: wikiTitle, nav, main } };
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

/**
 * Lazy generator yielding the aggregate pages' parts, with no document shell
 * wrapped around them.
 *
 * Yields (in order): tag pages, tag index, per-kind index pages, front page.
 * Concatenate with renderPageParts for the complete set of page fragments.
 *
 * `mode` is the same choice renderPageParts takes: multi-page output (the
 * default) links relative `.html` files, a single-file caller links sections
 * by fragment. The aggregate pages link to each other and to every listed
 * page, so they need it at least as much as the pages do.
 */
export function* renderAggregateParts(
  pages: Map<string, { record?: PageRecord; text: string }>,
  meta: ExportMeta,
  opts: ExportOptions = {},
  mode: LinkMode = "multi-page",
): Generator<RenderedParts> {
  const tagSlugMap = buildTagSlugMap([...meta.tagMap.keys()]);
  const wikiTitle = exportTitle(opts);

  // Tag pages
  for (const [tag, pageRefs] of meta.tagMap) {
    const slug = tagSlugMap.get(tag)!;
    yield renderTagPage(tag, slug, pageRefs, pages, wikiTitle, mode);
  }

  // Tag index (always emit — nav on every page links to it)
  yield renderTagIndex(tagSlugMap, meta, wikiTitle, mode);

  // Per-kind index pages
  for (const [kind, pageRefs] of meta.kindMap) {
    const folder = kindFolder(kind, pageRefs);
    yield renderKindIndex(kind, folder, pageRefs, pages, wikiTitle, mode);
  }

  // Front page
  yield renderFrontPage(meta, opts, pages, tagSlugMap, wikiTitle, mode);
}

/**
 * Lazy generator yielding aggregate HTML pages for the exported vault, in the
 * multi-page shape. Concatenate with renderPages for the complete output set.
 */
export function* renderAggregatePages(
  pages: Map<string, { record?: PageRecord; text: string }>,
  meta: ExportMeta,
  opts: ExportOptions = {},
): Generator<RenderedPage> {
  yield* shellPages(renderAggregateParts(pages, meta, opts));
}
