/**
 * Per-page HTML render pass for `enchiridion export`.
 *
 * Two layers, deliberately separable: renderPageParts yields a page's parts
 * (title, nav, main) with no document shell, and renderPages wraps those parts
 * in the multi-page shell (assets/style.css). Both are lazy generators and
 * pure; the path is vault-relative with .html extension.
 *
 * Link rewriting follows [LinkMode]: multi-page rewrites the export's own `.md`
 * destinations to `.html` (anchors preserved), single-file rewrites every
 * relative destination to the section that holds it, and either mode strips a
 * claimed destination outside the exported set to plain label text. Aggregate
 * pages are a separate pass in exportaggregate.ts, in the same two layers.
 *
 * A nominated start page is an output-path redirect: it is yielded at the front
 * page's path, every link site asks `meta.outputPathFor` for both ends, and the
 * generated front page is then not rendered at all (see exportaggregate).
 */

import path from "node:path";
import MarkdownIt from "markdown-it";
import { parse as parseYaml } from "yaml";
import { PageRecord, EdgeKeys } from "./pagerecord.js";
import {
  ExportMeta,
  ExportOptions,
  FRONT_PAGE_PATH,
  OutputPathFor,
  TAGS_INDEX_PATH,
  buildTagSlugMap,
  exportTitle,
  kindFolder,
  kindLabel,
  mdToHtml,
  tagPagePath,
} from "./exportmeta.js";
import {
  isVaultRelativeDest,
  iterLinks,
  resolveLinkDest,
  splitFrontmatter,
} from "./wikipage.js";
import { slugify } from "./place.js";
import { STYLESHEET_DIR, STYLESHEET_FILE } from "./exportstyle.js";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface RenderedPage {
  /** Vault-relative path of the output HTML file, e.g. wiki/concepts/foo.html */
  path: string;
  content: string;
}

/**
 * A single page, disassembled: the document-independent pieces every export
 * mode assembles for itself.
 */
export interface PageParts {
  /** Text for the document's <title>. A nominated start page is an ordinary
   *  page here: its own title, exported at the front page's path. Unescaped. */
  title: string;
  /** The sticky navigation bar, already positioned for this page's depth. */
  nav: string;
  /** Everything below the nav: the page header, then the article, then the
   *  frontmatter table as a footer. */
  main: string;
}

/** One page's parts, at the path they would occupy in multi-page output. */
export interface RenderedParts {
  /** Vault-relative path of the output HTML file, e.g. wiki/concepts/foo.html */
  path: string;
  parts: PageParts;
}

// ---------------------------------------------------------------------------
// markdown-it setup
// ---------------------------------------------------------------------------

const mdRender = new MarkdownIt({ html: false, linkify: true });

mdRender.renderer.rules.heading_open = (tokens, idx) => {
  const token = tokens[idx];
  const inlineToken = tokens[idx + 1];
  const text =
    inlineToken?.children
      ?.filter((t) => t.type === "text" || t.type === "softbreak")
      ?.map((t) => t.content)
      .join("") ??
    inlineToken?.content ??
    "";
  const id = slugify(text, 0);
  const idAttr = id ? ` id="${escHtml(id)}"` : "";
  return `<${token.tag}${idAttr}>`;
};

// ---------------------------------------------------------------------------
// HTML helpers
// ---------------------------------------------------------------------------

export function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Vault-relative directory of a page's HTML file. */
function pageHtmlDir(pageRef: string): string {
  return path.posix.dirname(mdToHtml(pageRef));
}

/** Relative path from a page's HTML file to a target HTML file, with optional anchor. */
function relHtmlPath(
  fromPageRef: string,
  toPageRef: string,
  anchor = "",
): string {
  const rel = path.posix.relative(
    pageHtmlDir(fromPageRef),
    mdToHtml(toPageRef),
  );
  return anchor ? `${rel}#${anchor}` : rel;
}

/** Relative path from an HTML file to the output root (e.g. "../../"). */
function rootPrefix(htmlPath: string): string {
  const depth = htmlPath.split("/").length - 1;
  if (depth === 0) return "./";
  return "../".repeat(depth);
}

/**
 * Relative path to the shared stylesheet directory from a page's own HTML file
 * — "./assets" at the root, "../assets" one level deep, and so on.
 */
export function assetsRootFor(htmlPath: string): string {
  return `${rootPrefix(htmlPath)}${STYLESHEET_DIR}`;
}

// ---------------------------------------------------------------------------
// Where a link points: the one thing that differs between the two output modes
// ---------------------------------------------------------------------------

/**
 * The section id of the front page in single-file output. No derived id can
 * collide with it: the derivation maps every non-alphanumeric to `-`, so an
 * underscore never survives it.
 */
export const FRONT_SECTION_ID = "__front";

/**
 * The id of the `<section>` a page becomes in single-file output — and so the
 * fragment every link to that page is rewritten to. Derived from the output path
 * alone, so the id a section is written with and the fragment a link carries
 * cannot disagree. The front page alone is not derived: it takes the reserved
 * [FRONT_SECTION_ID].
 */
export function sectionIdFor(htmlPath: string): string {
  if (htmlPath === FRONT_PAGE_PATH) return FRONT_SECTION_ID;
  const withoutExt = htmlPath.endsWith(".html")
    ? htmlPath.slice(0, -".html".length)
    : htmlPath;
  return withoutExt.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * The two shapes the export takes, as the render layer sees them: a directory
 * of linked `.html` pages, or one document whose pages are sections. The mode
 * decides both the href a link carries and what happens to a relative
 * destination the export does not carry — they are the same question, so they
 * are answered together.
 */
export type LinkMode = "multi-page" | "single-file";

/** How a link to a page in the exported set is spelled in a given mode. */
type HrefFor = (
  fromHtmlPath: string,
  toHtmlPath: string,
  anchor?: string,
) => string;

/** Multi-page: a relative path to the target's own `.html` file. */
const relativeHref: HrefFor = (
  fromHtmlPath: string,
  toHtmlPath: string,
  anchor = "",
) => relHtmlPath(fromHtmlPath, toHtmlPath, anchor);

/**
 * Single-file: the target section's fragment.
 *
 * A cross-page `#anchor` is dropped: showing the section is the part that must
 * not fail, so the link lands at the top of the target page. In-page anchors
 * name no page and keep resolving to their heading.
 */
const hashHref: HrefFor = (_fromHtmlPath, toHtmlPath) =>
  `#${sectionIdFor(toHtmlPath)}`;

/** The href strategy a mode spells a page link with. Link sites that know
 *  their target is a page call this; the rewriters above serve the rest. */
export function hrefFor(mode: LinkMode): HrefFor {
  return mode === "single-file" ? hashHref : relativeHref;
}

/**
 * Everything a link site needs to spell a destination: which refs the export
 * carries, which mode's href strategy to use, and where each ref is written.
 * They travel together — a site never wants one without the others.
 */
export interface LinkContext {
  /** `meta.exported` — the one owner of "the export carries this ref". */
  exported: Set<string>;
  mode: LinkMode;
  /** `meta.outputPathFor` — the start page's promotion lives here. */
  outputPathFor: OutputPathFor;
}

/** The link context a render pass threads through its link sites. */
export function linkContext(meta: ExportMeta, mode: LinkMode): LinkContext {
  return { exported: meta.exported, mode, outputPathFor: meta.outputPathFor };
}

/**
 * One kind index page as a list entry, shared by the generated front page's
 * browse block and a start page's foot list. The two are never rendered
 * together, but must agree on which kinds appear, in what order, at what href.
 */
export interface KindIndexEntry {
  kind: string;
  folder: string;
  label: string;
  count: number;
  href: string;
}

/**
 * The kind index entries, in the display order both lists use — by kind name.
 * `fromHtmlPath` is the listing page's own output path, `index.html` for both.
 */
export function kindIndexEntries(
  meta: ExportMeta,
  fromHtmlPath: string,
  mode: LinkMode,
): KindIndexEntry[] {
  return [...meta.kindMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([kind, refs]) => {
      const folder = kindFolder(kind, refs);
      return {
        kind,
        folder,
        label: kindLabel(folder),
        count: refs.length,
        href: hrefFor(mode)(fromHtmlPath, `wiki/${folder}/index.html`),
      };
    });
}

/**
 * The nav bar's link to one of the site's own two landmarks (the front page and
 * the tag index): a path from the output root in multi-page output, the
 * section's fragment in single-file output. Never sibling-relative.
 */
function navHref(htmlPath: string, targetPath: string, mode: LinkMode): string {
  if (mode === "single-file") return hashHref(htmlPath, targetPath);
  return `${rootPrefix(htmlPath)}${targetPath}`;
}

/** Vault-relative page directory for resolving relative markdown links. */
function vaultPageDir(pageRef: string): string {
  const d = path.posix.dirname(pageRef);
  return d === "." ? "" : d;
}

// ---------------------------------------------------------------------------
// Link rewriting
// ---------------------------------------------------------------------------

interface Edit {
  start: number;
  end: number;
  replacement: string;
}

function applyEdits(src: string, edits: Edit[]): string {
  edits.sort((a, b) => b.start - a.start);
  for (const e of edits) {
    src = src.slice(0, e.start) + e.replacement + src.slice(e.end);
  }
  return src;
}

/**
 * Whether a mode claims a destination an author wrote — the export rewrites it
 * rather than leaving it as it stands. A `.md` destination is a vault page in
 * either mode; every other relative destination belongs to single-file output
 * alone, since a relative path in a one-file document is a link out of it.
 *
 * Neither mode rewrites a bare in-page anchor, an absolute destination, or a
 * URI with a scheme — exactly the question [isVaultRelativeDest] answers.
 */
function claimsDest(dest: string, mode: LinkMode): boolean {
  if (!isVaultRelativeDest(dest)) return false;
  if (dest.endsWith(".md")) return true;
  return mode === "single-file";
}

/**
 * Rewrite/strip links in the body text before markdown-it rendering: a claimed
 * destination naming an exported page becomes that page's href in this mode; one
 * naming anything else is stripped to its label, not left as a dead href.
 */
function rewriteBodyLinks(
  bodyText: string,
  pageRef: string,
  link: LinkContext,
): string {
  const { exported, mode, outputPathFor } = link;
  const pageDir = vaultPageDir(pageRef);
  const href = hrefFor(mode);
  const fromHtmlPath = outputPathFor(pageRef);
  const edits: Edit[] = [];

  for (const anchor of iterLinks(bodyText)) {
    // A picture cannot navigate, so single-file output leaves images alone —
    // stripping one would replace the picture with its alt text.
    if (anchor.isImage && mode === "single-file") continue;
    const p = anchor.decodedPath;
    if (!claimsDest(p, mode)) continue;

    const target = resolveLinkDest(p, pageDir);

    edits.push(
      exported.has(target)
        ? {
            start: anchor.start,
            end: anchor.end,
            replacement: href(
              fromHtmlPath,
              outputPathFor(target),
              anchor.decodedAnchor,
            ),
          }
        : // Strip link: replace full [label](dest) with label text
          {
            start: anchor.fullStart,
            end: anchor.fullEnd,
            replacement: anchor.label,
          },
    );
  }

  return applyEdits(bodyText, edits);
}

// ---------------------------------------------------------------------------
// Frontmatter table rendering
// ---------------------------------------------------------------------------

const FM_LINK_KEYS = new Set(EdgeKeys);

/**
 * The two frontmatter keys lifted out of the table and into the page header:
 * the page's identity and its one-line abstract.
 */
const HEADER_KEYS = new Set(["title", "summary"]);

/**
 * Render a frontmatter value that is a markdown link string as HTML — a typed
 * edge, a `supersedes`, or the `raw_source` pointer, which is why this is not a
 * `.md`-only path: a raw artifact keeps its own extension (`.txt`, `.pdf`, …).
 *
 * The same two [claimsDest] rules as the body, for the same reason.
 */
function renderFmLink(
  markdownLink: string,
  pageRef: string,
  context: LinkContext,
): string {
  const { exported, mode, outputPathFor } = context;
  const links = iterLinks(markdownLink);
  if (links.length === 0) return escHtml(markdownLink);
  const link = links[0];
  const p = link.decodedPath;

  if (!claimsDest(p, mode)) {
    return `<a href="${escHtml(link.dest)}">${escHtml(link.label)}</a>`;
  }

  const target = resolveLinkDest(p, vaultPageDir(pageRef));
  if (!exported.has(target)) return escHtml(link.label);
  const href = hrefFor(mode);
  return `<a href="${escHtml(href(outputPathFor(pageRef), outputPathFor(target), link.decodedAnchor))}">${escHtml(link.label)}</a>`;
}

/** Render a tag as a link to its tag page. */
function renderTagLink(
  tag: string,
  pageRef: string,
  tagSlugMap: Map<string, string>,
  context: LinkContext,
): string {
  const slug = tagSlugMap.get(tag) ?? slugify(tag, 0);
  const href = hrefFor(context.mode)(
    context.outputPathFor(pageRef),
    tagPagePath(slug),
  );
  return `<a href="${escHtml(href)}">${escHtml(tag)}</a>`;
}

/** Render a single frontmatter value as HTML. */
function renderFmValue(
  key: string,
  value: unknown,
  pageRef: string,
  tagSlugMap: Map<string, string>,
  context: LinkContext,
): string {
  if (value === null || value === undefined) return "";

  if (key === "tags") {
    if (!Array.isArray(value)) return escHtml(String(value));
    const items = value.map(
      (tag) =>
        `<li>${renderTagLink(typeof tag === "string" ? tag : String(tag), pageRef, tagSlugMap, context)}</li>`,
    );
    return `<ul>${items.join("")}</ul>`;
  }

  if (FM_LINK_KEYS.has(key)) {
    if (Array.isArray(value)) {
      const items = value.map(
        (item) =>
          `<li>${renderFmLink(typeof item === "string" ? item : String(item), pageRef, context)}</li>`,
      );
      return `<ul>${items.join("")}</ul>`;
    }
    return renderFmLink(
      typeof value === "string" ? value : String(value),
      pageRef,
      context,
    );
  }

  if (Array.isArray(value)) {
    const items = value.map(
      (item) => `<li>${escHtml(String(item ?? ""))}</li>`,
    );
    return `<ul>${items.join("")}</ul>`;
  }

  return escHtml(String(value));
}

/** Render a link to a page as HTML (for superseded_by). */
function renderPageLink(
  targetRef: string,
  pageRef: string,
  allPages: Map<string, { record?: PageRecord; text: string }>,
  context: LinkContext,
): string {
  const entry = allPages.get(targetRef);
  const label = entry?.record?.title ?? targetRef;
  if (!context.exported.has(targetRef)) return escHtml(label);
  const href = hrefFor(context.mode)(
    context.outputPathFor(pageRef),
    context.outputPathFor(targetRef),
  );
  return `<a href="${escHtml(href)}">${escHtml(label)}</a>`;
}

function renderFrontmatterTable(
  pageRef: string,
  record: PageRecord,
  text: string,
  allPages: Map<string, { record?: PageRecord; text: string }>,
  tagSlugMap: Map<string, string>,
  context: LinkContext,
): string {
  const { frontmatter, hasFrontmatter } = splitFrontmatter(text);
  if (!hasFrontmatter) return "";

  const fm = frontmatter.trim() ? (parseYaml(frontmatter) as unknown) : null;
  if (typeof fm !== "object" || fm === null) return "";

  const fmMap = fm as Record<string, unknown>;
  const rows: string[] = [];

  // Literal keys in original order, minus the two the page header owns.
  for (const [key, value] of Object.entries(fmMap)) {
    if (HEADER_KEYS.has(key)) continue;
    rows.push(
      `<tr><td>${escHtml(key)}</td><td>${renderFmValue(key, value, pageRef, tagSlugMap, context)}</td></tr>`,
    );
  }

  // The table keeps the divider wherever the remaining authored rows leave it,
  // including with nothing above it.
  rows.push(`<tr class="fm-divider"><td colspan="2"></td></tr>`);

  // Derived: kind
  rows.push(`<tr><td>kind</td><td>${escHtml(record.kind)}</td></tr>`);

  // Derived: superseded_by — list when multiple, bare link when one, empty when none
  const sb = record.supersededBy;
  let sbHtml: string;
  if (sb.length === 0) {
    sbHtml = "";
  } else if (sb.length === 1) {
    sbHtml = renderPageLink(sb[0], pageRef, allPages, context);
  } else {
    sbHtml = `<ul>${sb.map((ref) => `<li>${renderPageLink(ref, pageRef, allPages, context)}</li>`).join("")}</ul>`;
  }
  rows.push(`<tr><td>superseded_by</td><td>${sbHtml}</td></tr>`);

  return `<table class="frontmatter">\n${rows.join("\n")}\n</table>`;
}

// ---------------------------------------------------------------------------
// Page assembly
// ---------------------------------------------------------------------------

/**
 * The sticky navigation bar every page carries: the wiki title on the left, the
 * site's own links on the right. Styled in the shared stylesheet, never inline.
 */
export function buildNavBar(
  htmlPath: string,
  wikiTitle: string,
  mode: LinkMode,
): string {
  const home = escHtml(navHref(htmlPath, FRONT_PAGE_PATH, mode));
  const tags = escHtml(navHref(htmlPath, TAGS_INDEX_PATH, mode));
  return `<nav class="wiki-nav">
<span class="wiki-nav-title">${escHtml(wikiTitle)}</span>
<span class="wiki-nav-links"><a href="${home}">Home</a> · <a href="${tags}">Tags</a></span>
</nav>`;
}

/**
 * The skeleton every exported document shares: one HTML file, a title, the
 * viewport meta, one source of styling, and a body.
 *
 * `style` is a whole element (`<link …>` or `<style>…</style>`): the two output
 * shapes carry different styling, not merely a different spelling of it.
 */
export function buildDocument(
  title: string,
  style: string,
  body: string,
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(title)}</title>
${style}
</head>
<body>
${body}
</body>
</html>`;
}

/**
 * Wrap a page's parts in a complete document, pointing it at the shared
 * stylesheet at its own depth — the multi-page shape. `assetsRoot` is the
 * relative path to the `assets/` directory (see [assetsRootFor]).
 */
export function buildHtmlShell(parts: PageParts, assetsRoot: string): string {
  const style = `<link rel="stylesheet" href="${escHtml(assetsRoot)}/${STYLESHEET_FILE}">`;
  return buildDocument(parts.title, style, `${parts.nav}\n${parts.main}`);
}

/**
 * A page's `<article>` followed by the blocks that trail it: the start page's
 * kind-index list (when there is one), then the frontmatter table, which stays
 * last — provenance trails the content it describes. One spelling for both
 * assembly sites so they cannot drift on block order.
 */
function articleWithFooter(
  bodyHtml: string,
  kindListHtml: string,
  fmHtml: string,
): string {
  const blocks = [`<article>\n${bodyHtml}</article>`];
  if (kindListHtml) blocks.push(kindListHtml);
  if (fmHtml) blocks.push(fmHtml);
  return blocks.join("\n");
}

/**
 * The list of kind index pages a start page carries at the foot of its article.
 * A start page replaces the generated front page, so without this list the kind
 * indexes become unreachable. Counts come from `meta.kindMap`, so the start page
 * is absent from its own kind's row. Empty when no kind remains.
 */
function renderKindIndexList(
  meta: ExportMeta,
  fromHtmlPath: string,
  mode: LinkMode,
): string {
  const rows = kindIndexEntries(meta, fromHtmlPath, mode).map(
    ({ href, label, count }) =>
      `<li><a href="${escHtml(href)}">${escHtml(label)}</a> (${count})</li>`,
  );
  if (rows.length === 0) return "";
  return [
    `<section>`,
    `<h2>Browse by Kind</h2>`,
    `<ul>`,
    ...rows,
    `</ul>`,
    `</section>`,
  ].join("\n");
}

/**
 * The page header: the frontmatter's `title` and `summary`, above the article.
 * Empty when the page has neither.
 *
 * `anchor` is the slug of a body heading this header replaced (see
 * [liftTitleEcho]); the `<h1>` carries it so a link to that heading still lands.
 */
function renderPageHeader(
  title: string,
  summary: string,
  anchor: string | null,
): string {
  const parts: string[] = [];
  if (title) {
    const id = anchor ? ` id="${escHtml(anchor)}"` : "";
    parts.push(`<h1${id}>${escHtml(title)}</h1>`);
  }
  if (summary) {
    parts.push(`<p class="page-summary">${escHtml(summary)}</p>`);
  }
  if (parts.length === 0) return "";
  return `<header class="page-header">\n${parts.join("\n")}\n</header>`;
}

/**
 * The visible text of a small HTML fragment, for comparing a rendered heading
 * against the frontmatter title it may echo.
 */
function htmlText(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .trim();
}

/**
 * A page's rendered body, with a leading H1 removed when it merely repeats the
 * frontmatter title — plus that heading's `id`, so `page.html#the-title` still
 * resolves once the header shows the title. Detection is on the rendered HTML,
 * not the markdown, so every H1 spelling works and the anchor is the one
 * markdown-it wrote rather than a second slug that could disagree with it.
 */
function liftTitleEcho(
  bodyHtml: string,
  title: string,
): { bodyHtml: string; anchor: string | null } {
  if (!title) return { bodyHtml, anchor: null };
  const heading = /^\s*<h1(\s[^>]*)?>([\s\S]*?)<\/h1>/.exec(bodyHtml);
  if (!heading || htmlText(heading[2]) !== title.trim()) {
    return { bodyHtml, anchor: null };
  }
  const anchor = /\sid="([^"]+)"/.exec(heading[1] ?? "")?.[1] ?? null;
  const rest =
    bodyHtml.slice(0, heading.index) +
    bodyHtml.slice(heading.index + heading[0].length);
  return { bodyHtml: rest, anchor };
}

function buildPageParts(
  pageRef: string,
  record: PageRecord,
  text: string,
  meta: ExportMeta,
  allPages: Map<string, { record?: PageRecord; text: string }>,
  tagSlugMap: Map<string, string>,
  wikiTitle: string,
  mode: LinkMode,
): PageParts {
  // `index.html` when this is the start page — both the nav bar and every href
  // are spelled from the output path, never from the ref.
  const htmlPath = meta.outputPathFor(pageRef);
  const context = linkContext(meta, mode);
  const nav = buildNavBar(htmlPath, wikiTitle, mode);
  const fmTable = renderFrontmatterTable(
    pageRef,
    record,
    text,
    allPages,
    tagSlugMap,
    context,
  );
  const { body } = splitFrontmatter(text);
  const bodyHtml = mdRender.render(rewriteBodyLinks(body, pageRef, context));
  const lifted = liftTitleEcho(bodyHtml, record.title);
  const header = renderPageHeader(record.title, record.summary, lifted.anchor);
  const kindList =
    meta.startPage === pageRef ? renderKindIndexList(meta, htmlPath, mode) : "";
  const article = articleWithFooter(lifted.bodyHtml, kindList, fmTable);
  const main = header ? `${header}\n${article}` : article;
  return { title: record.title || pageRef, nav, main };
}

/** Minimal rendering for raw/ pages (no PageRecord). */
function buildRawPageParts(
  pageRef: string,
  text: string,
  meta: ExportMeta,
  wikiTitle: string,
  mode: LinkMode,
): PageParts {
  const htmlPath = meta.outputPathFor(pageRef);
  const context = linkContext(meta, mode);
  const nav = buildNavBar(htmlPath, wikiTitle, mode);
  const { body, hasFrontmatter, frontmatter } = splitFrontmatter(text);
  let fmSection = "";
  if (hasFrontmatter && frontmatter.trim()) {
    const fm = parseYaml(frontmatter) as unknown;
    if (typeof fm === "object" && fm !== null) {
      const rows = Object.entries(fm as Record<string, unknown>).map(
        ([k, v]) =>
          `<tr><td>${escHtml(k)}</td><td>${escHtml(String(v ?? ""))}</td></tr>`,
      );
      fmSection = `<table class="frontmatter">\n${rows.join("\n")}\n</table>`;
    }
  }
  const bodyHtml = mdRender.render(rewriteBodyLinks(body, pageRef, context));
  // A raw page can be the start page too, so it needs the same kind list.
  const kindList =
    meta.startPage === pageRef ? renderKindIndexList(meta, htmlPath, mode) : "";
  const main = articleWithFooter(bodyHtml, kindList, fmSection);
  return { title: pageRef, nav, main };
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

/**
 * Lazy generator yielding one page's parts per exported page, with no document
 * shell around them.
 *
 * A page is yielded at `meta.outputPathFor(pageRef)` — the front page's path for
 * the start page, its own otherwise — so the promoted page is exported exactly
 * once and nothing is written at its old path. `meta.exported` is the one owner
 * of what the export carries; `mode` is [LinkMode].
 */
export function* renderPageParts(
  pages: Map<string, { record?: PageRecord; text: string }>,
  meta: ExportMeta,
  opts: ExportOptions = {},
  mode: LinkMode = "multi-page",
): Generator<RenderedParts> {
  const wikiTitle = exportTitle(opts);

  const tagSlugMap = buildTagSlugMap([...meta.tagMap.keys()]);

  for (const pageRef of meta.exported) {
    const entry = pages.get(pageRef)!;
    const { record, text } = entry;
    const htmlPath = meta.outputPathFor(pageRef);
    if (!record) {
      yield {
        path: htmlPath,
        parts: buildRawPageParts(pageRef, text, meta, wikiTitle, mode),
      };
      continue;
    }
    yield {
      path: htmlPath,
      parts: buildPageParts(
        pageRef,
        record,
        text,
        meta,
        pages,
        tagSlugMap,
        wikiTitle,
        mode,
      ),
    };
  }
}

/**
 * Wrap a stream of page parts in the multi-page shape: the shared shell, pointed
 * at the shared stylesheet at that page's own depth. The one place that shape is
 * spelled, so the per-page and aggregate passes cannot drift.
 */
export function* shellPages(
  parts: Iterable<RenderedParts>,
): Generator<RenderedPage> {
  for (const { path: htmlPath, parts: pageParts } of parts) {
    yield {
      path: htmlPath,
      content: buildHtmlShell(pageParts, assetsRootFor(htmlPath)),
    };
  }
}

/**
 * Lazy generator yielding one { path, content } entry per exported page, in
 * the multi-page shape.
 */
export function* renderPages(
  pages: Map<string, { record?: PageRecord; text: string }>,
  meta: ExportMeta,
  opts: ExportOptions = {},
): Generator<RenderedPage> {
  yield* shellPages(renderPageParts(pages, meta, opts));
}
