/**
 * Aggregate HTML pages for `enchiridion export`.
 *
 * Yields the index and listing pages that sit alongside the per-page output
 * from renderPages:
 *   - tags/<slug>.html   — one per tag, listing every page that carries it
 *   - tags/index.html    — all tags with page counts
 *   - wiki/<folder>/index.html — per-kind listing pages
 *   - index.html         — front page (counts, kind summaries, get-started)
 *     omitted entirely when a start page fills the front page instead
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
  TAGS_INDEX_PATH,
  buildTagSlugMap,
  exportTitle,
  kindFolder,
  kindLabel,
  tagPagePath,
} from "./exportmeta.js";
import {
  LinkContext,
  LinkMode,
  RenderedParts,
  RenderedPage,
  buildNavBar,
  escHtml,
  hrefFor,
  kindIndexEntries,
  linkContext,
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

// `kindFolder` — the folder a kind's pages live in — now lives in exportmeta,
// because the start page's kind-index list needs it too and exportrender (which
// builds that list) must not import this module.

// ---------------------------------------------------------------------------
// Page link helper (used by tag pages and kind index pages)
// ---------------------------------------------------------------------------

function pageLink(
  fromHtmlPath: string,
  toPageRef: string,
  title: string,
  context: LinkContext,
): string {
  return `<a href="${escHtml(hrefFor(context.mode)(fromHtmlPath, context.outputPathFor(toPageRef)))}">${escHtml(title)}</a>`;
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
  context: LinkContext,
): RenderedParts {
  const htmlPath = tagPagePath(slug);
  const nav = buildNavBar(htmlPath, wikiTitle, context.mode);
  const items = pageRefs
    .map((ref) => {
      const title = pages.get(ref)?.record?.title ?? ref;
      const link = pageLink(htmlPath, ref, title, context);
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
  context: LinkContext,
): RenderedParts {
  const htmlPath = TAGS_INDEX_PATH;
  const nav = buildNavBar(htmlPath, wikiTitle, context.mode);

  const sortedTags = [...tagSlugMap.keys()].sort();
  const rows = sortedTags.map((tag) => {
    const slug = tagSlugMap.get(tag)!;
    const count = meta.tagMap.get(tag)?.length ?? 0;
    const href = escHtml(hrefFor(context.mode)(htmlPath, tagPagePath(slug)));
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
  context: LinkContext,
): RenderedParts {
  const htmlPath = `wiki/${folder}/index.html`;
  const nav = buildNavBar(htmlPath, wikiTitle, context.mode);

  const label = kindLabel(folder);
  const items = pageRefs
    .map((ref) => {
      const record = pages.get(ref)?.record;
      const title = record?.title ?? ref;
      const summary = record?.summary ?? "";
      const link = pageLink(htmlPath, ref, title, context);
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
  context: LinkContext,
): RenderedParts {
  const htmlPath = "index.html";
  const nav = buildNavBar(htmlPath, wikiTitle, context.mode);

  // Total page count
  const totalPages = Array.from(meta.kindMap.values()).reduce(
    (sum, refs) => sum + refs.length,
    0,
  );

  // Per-kind section. The same entries a start page's foot list uses, plus the
  // KIND.md blurb this page is the only one to carry.
  const kindRows = kindIndexEntries(meta, htmlPath, context.mode).map(
    ({ kind, href, label, count }) => {
      const blurb = kindBlurb(kind, pages);
      const blurbHtml = blurb ? ` — ${escHtml(blurb)}` : "";
      return `<li><a href="${escHtml(href)}">${escHtml(label)}</a> (${count})${blurbHtml}</li>`;
    },
  );

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
      const link = pageLink(htmlPath, pageRef, title, context);
      const annHtml = annotation ? ` — ${escHtml(annotation)}` : "";
      return `<li>${link}${annHtml}</li>`;
    });
  } else {
    startedItems = meta.getStarted.map((entry: GetStartedEntry) => {
      const link = pageLink(htmlPath, entry.pageRef, entry.title, context);
      const summaryHtml = entry.summary ? ` — ${escHtml(entry.summary)}` : "";
      return `<li>${link}${summaryHtml}</li>`;
    });
  }

  const tagsHref = escHtml(hrefFor(context.mode)(htmlPath, TAGS_INDEX_PATH));
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
 * Yields (in order): tag pages, tag index, per-kind index pages, front page —
 * the last unless a start page has taken the front page's path, in which case
 * only the listing pages are yielded. Concatenate with renderPageParts for the
 * complete set of page fragments.
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
  const context = linkContext(meta, mode);

  // Tag pages
  for (const [tag, pageRefs] of meta.tagMap) {
    const slug = tagSlugMap.get(tag)!;
    yield renderTagPage(tag, slug, pageRefs, pages, wikiTitle, context);
  }

  // Tag index (always emit — nav on every page links to it)
  yield renderTagIndex(tagSlugMap, meta, wikiTitle, context);

  // Per-kind index pages. `meta.kindMap` is the membership, so a kind whose
  // only member was the start page has no entry and gets no index page.
  for (const [kind, pageRefs] of meta.kindMap) {
    const folder = kindFolder(kind, pageRefs);
    yield renderKindIndex(kind, folder, pageRefs, pages, wikiTitle, context);
  }

  // Front page — the generated aggregate, unless a start page has taken the
  // front page's path. Writing both would put two files at `index.html` (two
  // sections in single-file mode), and this pass runs last, so it would win
  // silently; skipping it here is what makes the promotion exclusive.
  if (!meta.startPage) {
    yield renderFrontPage(meta, opts, pages, tagSlugMap, wikiTitle, context);
  }
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
