/**
 * Per-page HTML render pass for `enchiridion export`.
 *
 * Two layers, deliberately separable:
 *
 *   1. renderPageParts — a page's parts (title, nav, main) with no document
 *      shell around them. This is what a mode that assembles its own document
 *      needs: single-file export nests the same fragments in its own sections.
 *   2. renderPages — the multi-page shape, wrapping each page's parts in the
 *      shared shell and pointing it at `assets/style.css`.
 *
 * Both are lazy generators over page records + export metadata + options, and
 * both are pure — no filesystem access, no model. The path is vault-relative
 * with .html extension.
 *
 * Link rewriting uses the iterLinks/offset-splice path from wikipage.ts, and
 * follows the mode: multi-page output rewrites the export's own `.md`
 * destinations to `.html` (anchors preserved), single-file output rewrites
 * every relative destination to the section that holds it — and either mode
 * strips a claimed destination whose target is outside the exported set to
 * plain label text rather than leaving a dead href. See [LinkMode].
 *
 * Aggregate pages (tag pages, tag index, per-kind index pages, front page)
 * are a separate pass in exportaggregate.ts, in the same two layers —
 * concatenate the page generators to get the full output set.
 */

import path from "node:path";
import MarkdownIt from "markdown-it";
import { parse as parseYaml } from "yaml";
import { PageRecord, EdgeKeys } from "./pagerecord.js";
import {
  ExportMeta,
  ExportOptions,
  buildTagSlugMap,
  exportTitle,
} from "./exportmeta.js";
import { iterLinks, resolveLinkDest, splitFrontmatter } from "./wikipage.js";
import { slugify } from "./place.js";
import {
  EXPORT_STYLESHEET,
  STYLESHEET_DIR,
  STYLESHEET_FILE,
} from "./exportstyle.js";

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
  /** Text for the document's <title> — this page's own title (a tag name, a
   *  kind's label, a page title); a page that *is* the wiki's front door
   *  carries the wiki's title. Unescaped: the shell escapes it. */
  title: string;
  /** The sticky navigation bar, already positioned for this page's depth. */
  nav: string;
  /** Everything below the nav: frontmatter table then article. */
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

/** Convert a vault-relative .md path to a .html path. */
export function mdToHtml(ref: string): string {
  return ref.endsWith(".md") ? ref.slice(0, -3) + ".html" : ref;
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
 * Relative path to the shared stylesheet directory from a page's own HTML
 * file — "./assets" at the root, "../assets" one level deep, and so on. Every
 * page's stylesheet link is this plus the stylesheet's filename, so the href
 * is right by construction rather than by a per-page hand-count.
 */
export function assetsRootFor(htmlPath: string): string {
  return `${rootPrefix(htmlPath)}${STYLESHEET_DIR}`;
}

// ---------------------------------------------------------------------------
// Where a link points: the one thing that differs between the two output modes
// ---------------------------------------------------------------------------

/** The front page's output path, at the output root. */
const FRONT_PAGE_PATH = "index.html";

/** The tag index's output path. */
const TAGS_INDEX_PATH = "tags/index.html";

/**
 * The section id of the front page in single-file output. No derived id can
 * collide with it: the derivation maps every non-alphanumeric to `-`, so an
 * underscore never survives it.
 */
export const FRONT_SECTION_ID = "__front";

/**
 * The id of the `<section>` a page becomes in single-file output — and so the
 * fragment every link to that page is rewritten to. Derived from the page's
 * output path alone (separators and the `.html` extension dropped, every run
 * of remaining non-alphanumerics collapsed to one `-`), so the id a section is
 * written with and the fragment a link to it carries cannot disagree: both are
 * this function's answer for the same path.
 *
 * The front page is the one page whose id is not derived — it takes the
 * reserved [FRONT_SECTION_ID], because "the page you land on with no hash" is
 * a role the document needs to name, not a path.
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
 * of linked `.html` pages, or one document whose pages are sections.
 *
 * The mode is one choice, not two. Which href a link to a page carries and
 * what happens to a relative destination the export does not carry are the
 * same question asked twice — a document with no second file to point at
 * cannot spell a relative path either — so they are decided together, here,
 * rather than at each of a dozen link sites or by a pair of flags that could
 * be set to disagree.
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
 * A cross-page `#anchor` is dropped rather than carried. One fragment can name
 * either the section to show or a heading inside it, and showing the section
 * is the part that must not fail — so the link lands at the top of the target
 * page. In-page anchors never come through here (they name no page) and keep
 * resolving to their heading.
 */
const hashHref: HrefFor = (_fromHtmlPath, toHtmlPath) =>
  `#${sectionIdFor(toHtmlPath)}`;

/** The href strategy a mode spells a page link with. The link sites that know
 *  their target is a page (tag links, index listings) call this directly; the
 *  ones that resolve an author's destination ask the rewriters above instead. */
export function hrefFor(mode: LinkMode): HrefFor {
  return mode === "single-file" ? hashHref : relativeHref;
}

/**
 * The nav bar's link to one of the site's own two landmarks — the front page
 * and the tag index — which is the one link in the export that is not spelled
 * as a path to a sibling.
 *
 * Multi-page output has written these from the output root since the bar
 * existed: `./index.html` at the root, `../tags/index.html` a level down.
 * That is not the sibling-relative spelling [hrefFor] produces, and it is not
 * worth restating 300 pages' worth of nav bars to unify them; single-file
 * output names the two sections, which is the same idea — a destination
 * absolute to the document that carries it.
 */
function navHref(htmlPath: string, targetPath: string, mode: LinkMode): string {
  if (mode === "single-file") return `#${sectionIdFor(targetPath)}`;
  return `${rootPrefix(htmlPath)}${targetPath}`;
}

/**
 * A URI scheme at the start of a destination (`https:`, `mailto:`, `data:`).
 * Only single-file mode needs to ask: it claims every relative destination,
 * so it has to be able to tell one from an absolute URI that merely lacks
 * `//`. Multi-page output keeps the narrower test it has always used, so its
 * output does not move.
 */
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

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
 * Whether a mode claims a destination an author wrote — whether the export
 * rewrites it, rather than leaving it as it stands.
 *
 * A `.md` destination is a page of the vault in either mode, and the export
 * owns it. Everything else belongs to single-file output alone: multi-page
 * output is a directory of files and leaves a destination it does not own
 * where the author put it, while single-file output cannot — a relative path
 * in a one-file document is a link out of that file, so it claims them all.
 *
 * Nobody's to rewrite, in either mode: a bare in-page anchor (it names a
 * heading of the page it is on), an absolute destination (`/…` or a URL), and
 * a URI with a scheme (`mailto:`, `data:`), which merely looks relative to a
 * test that only knows `://`.
 */
function claimsDest(dest: string, mode: LinkMode): boolean {
  if (dest === "" || dest.startsWith("/") || dest.includes("://")) return false;
  if (dest.endsWith(".md")) return true;
  return mode === "single-file" && !SCHEME_RE.test(dest);
}

/**
 * Rewrite/strip links in the body text before markdown-it rendering.
 *
 * A claimed destination naming a page of the export becomes that page's href
 * in this mode (`foo.html`, or the target's section in a one-file document);
 * a claimed destination naming anything else is stripped to its label, so a
 * link to a page the export does not carry is plain text rather than a dead
 * href.
 */
function rewriteBodyLinks(
  bodyText: string,
  pageRef: string,
  exported: Set<string>,
  mode: LinkMode,
): string {
  const pageDir = vaultPageDir(pageRef);
  const href = hrefFor(mode);
  const edits: Edit[] = [];

  for (const link of iterLinks(bodyText)) {
    // A picture cannot navigate anywhere, so single-file output has no reason
    // to touch one — and stripping it would replace the picture with its alt
    // text. Multi-page output goes on rewriting the export's own `.md` links
    // wherever they appear, images included, exactly as it always has.
    if (link.isImage && mode === "single-file") continue;
    const p = link.decodedPath;
    if (!claimsDest(p, mode)) continue;

    const target = resolveLinkDest(p, pageDir);

    edits.push(
      exported.has(target)
        ? {
            start: link.start,
            end: link.end,
            replacement: href(
              mdToHtml(pageRef),
              mdToHtml(target),
              link.decodedAnchor,
            ),
          }
        : // Strip link: replace full [label](dest) with label text
          {
            start: link.fullStart,
            end: link.fullEnd,
            replacement: link.label,
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
 * Render a frontmatter value that is a markdown link string as HTML — a typed
 * edge, a `supersedes`, or the `raw_source` pointer, which is the reason this
 * is not a `.md`-only path: a raw artifact keeps its own extension, so a
 * `raw_source` link names `.txt`, `.html`, `.pdf` or whatever the file was.
 *
 * The same two rules as the body, for the same reason: a `.md` destination is
 * the export's own link surface in either mode, and in single-file mode every
 * relative destination is claimed, so that none of them can leave the file.
 */
function renderFmLink(
  markdownLink: string,
  pageRef: string,
  exported: Set<string>,
  mode: LinkMode,
): string {
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
  return `<a href="${escHtml(href(mdToHtml(pageRef), mdToHtml(target), link.decodedAnchor))}">${escHtml(link.label)}</a>`;
}

/** Render a tag as a link to its tag page. */
function renderTagLink(
  tag: string,
  pageRef: string,
  tagSlugMap: Map<string, string>,
  mode: LinkMode,
): string {
  const slug = tagSlugMap.get(tag) ?? slugify(tag, 0);
  const href = hrefFor(mode)(mdToHtml(pageRef), `tags/${slug}.html`);
  return `<a href="${escHtml(href)}">${escHtml(tag)}</a>`;
}

/** Render a single frontmatter value as HTML. */
function renderFmValue(
  key: string,
  value: unknown,
  pageRef: string,
  exported: Set<string>,
  tagSlugMap: Map<string, string>,
  mode: LinkMode,
): string {
  if (value === null || value === undefined) return "";

  if (key === "tags") {
    if (!Array.isArray(value)) return escHtml(String(value));
    const items = value.map(
      (tag) =>
        `<li>${renderTagLink(typeof tag === "string" ? tag : String(tag), pageRef, tagSlugMap, mode)}</li>`,
    );
    return `<ul>${items.join("")}</ul>`;
  }

  if (FM_LINK_KEYS.has(key)) {
    if (Array.isArray(value)) {
      const items = value.map(
        (item) =>
          `<li>${renderFmLink(typeof item === "string" ? item : String(item), pageRef, exported, mode)}</li>`,
      );
      return `<ul>${items.join("")}</ul>`;
    }
    return renderFmLink(
      typeof value === "string" ? value : String(value),
      pageRef,
      exported,
      mode,
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
  exported: Set<string>,
  allPages: Map<string, { record?: PageRecord; text: string }>,
  mode: LinkMode,
): string {
  const entry = allPages.get(targetRef);
  const label = entry?.record?.title ?? targetRef;
  if (!exported.has(targetRef)) return escHtml(label);
  const href = hrefFor(mode)(mdToHtml(pageRef), mdToHtml(targetRef));
  return `<a href="${escHtml(href)}">${escHtml(label)}</a>`;
}

function renderFrontmatterTable(
  pageRef: string,
  record: PageRecord,
  text: string,
  exported: Set<string>,
  allPages: Map<string, { record?: PageRecord; text: string }>,
  tagSlugMap: Map<string, string>,
  mode: LinkMode,
): string {
  const { frontmatter, hasFrontmatter } = splitFrontmatter(text);
  if (!hasFrontmatter) return "";

  const fm = frontmatter.trim() ? (parseYaml(frontmatter) as unknown) : null;
  if (typeof fm !== "object" || fm === null) return "";

  const fmMap = fm as Record<string, unknown>;
  const rows: string[] = [];

  // Literal keys in original order
  for (const [key, value] of Object.entries(fmMap)) {
    rows.push(
      `<tr><td>${escHtml(key)}</td><td>${renderFmValue(key, value, pageRef, exported, tagSlugMap, mode)}</td></tr>`,
    );
  }

  // Divider
  rows.push(`<tr class="fm-divider"><td colspan="2"></td></tr>`);

  // Derived: kind
  rows.push(`<tr><td>kind</td><td>${escHtml(record.kind)}</td></tr>`);

  // Derived: superseded_by — list when multiple, bare link when one, empty when none
  const sb = record.supersededBy;
  let sbHtml: string;
  if (sb.length === 0) {
    sbHtml = "";
  } else if (sb.length === 1) {
    sbHtml = renderPageLink(sb[0], pageRef, exported, allPages, mode);
  } else {
    sbHtml = `<ul>${sb.map((ref) => `<li>${renderPageLink(ref, pageRef, exported, allPages, mode)}</li>`).join("")}</ul>`;
  }
  rows.push(`<tr><td>superseded_by</td><td>${sbHtml}</td></tr>`);

  return `<table class="frontmatter">\n${rows.join("\n")}\n</table>`;
}

// ---------------------------------------------------------------------------
// Page assembly
// ---------------------------------------------------------------------------

/**
 * The sticky navigation bar every page carries: the wiki title on the left,
 * the site's own links on the right. Styled in the shared stylesheet
 * (`nav.wiki-nav`), never inline.
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
 * Wrap a page's parts in a complete document.
 *
 * `assetsRoot` is the relative path to the shared `assets/` directory from
 * this page's own location (see [assetsRootFor]) — the multi-page shape, one
 * stylesheet file linked from every page. `null` means there is no assets
 * directory to link and the stylesheet is inlined instead: the single-file
 * shape, where the whole site is one document.
 */
export function buildHtmlShell(
  parts: PageParts,
  assetsRoot: string | null,
): string {
  const head =
    assetsRoot === null
      ? `<style>\n${EXPORT_STYLESHEET}</style>`
      : `<link rel="stylesheet" href="${escHtml(assetsRoot)}/${STYLESHEET_FILE}">`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(parts.title)}</title>
${head}
</head>
<body>
${parts.nav}
${parts.main}
</body>
</html>`;
}

function buildPageParts(
  pageRef: string,
  record: PageRecord,
  text: string,
  exported: Set<string>,
  allPages: Map<string, { record?: PageRecord; text: string }>,
  tagSlugMap: Map<string, string>,
  wikiTitle: string,
  mode: LinkMode,
): PageParts {
  const nav = buildNavBar(mdToHtml(pageRef), wikiTitle, mode);
  const fmTable = renderFrontmatterTable(
    pageRef,
    record,
    text,
    exported,
    allPages,
    tagSlugMap,
    mode,
  );
  const { body } = splitFrontmatter(text);
  const bodyHtml = mdRender.render(
    rewriteBodyLinks(body, pageRef, exported, mode),
  );
  const main = `${fmTable}\n<article>\n${bodyHtml}</article>`;
  return { title: record.title || pageRef, nav, main };
}

/** Minimal rendering for raw/ pages (no PageRecord). */
function buildRawPageParts(
  pageRef: string,
  text: string,
  exported: Set<string>,
  wikiTitle: string,
  mode: LinkMode,
): PageParts {
  const nav = buildNavBar(mdToHtml(pageRef), wikiTitle, mode);
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
  const bodyHtml = mdRender.render(
    rewriteBodyLinks(body, pageRef, exported, mode),
  );
  const main = `${fmSection}\n<article>\n${bodyHtml}</article>`;
  return { title: pageRef, nav, main };
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

/**
 * Lazy generator yielding one page's parts per exported page, with no
 * document shell wrapped around them.
 *
 * `pages` is the same Map<pageRef, {record?, text}> fed to buildExportMeta.
 * `meta` carries pre-computed aggregate metadata; used by callers that also
 * generate index/tag pages from the same pass. `opts` controls which subtrees
 * are exported, and supplies the wiki title the nav bar shows.
 *
 * `mode` decides how each link names its target and what becomes of a
 * relative destination the export does not carry — multi-page output (the
 * default, and what renderPages wraps) links a relative `.html` file, while a
 * single-file caller assembling its own document links sections by fragment
 * and claims every relative destination. See [LinkMode].
 */
export function* renderPageParts(
  pages: Map<string, { record?: PageRecord; text: string }>,
  meta: ExportMeta,
  opts: ExportOptions = {},
  mode: LinkMode = "multi-page",
): Generator<RenderedParts> {
  const includeRaw = opts.includeRaw ?? false;
  const wikiTitle = exportTitle(opts);

  const exported = new Set<string>();
  for (const ref of pages.keys()) {
    if (ref.startsWith("wiki/") || (includeRaw && ref.startsWith("raw/"))) {
      exported.add(ref);
    }
  }

  const tagSlugMap = buildTagSlugMap([...meta.tagMap.keys()]);

  for (const pageRef of exported) {
    const entry = pages.get(pageRef)!;
    const { record, text } = entry;
    const htmlPath = mdToHtml(pageRef);
    if (!record) {
      yield {
        path: htmlPath,
        parts: buildRawPageParts(pageRef, text, exported, wikiTitle, mode),
      };
      continue;
    }
    yield {
      path: htmlPath,
      parts: buildPageParts(
        pageRef,
        record,
        text,
        exported,
        pages,
        tagSlugMap,
        wikiTitle,
        mode,
      ),
    };
  }
}

/**
 * Wrap a stream of page parts in the multi-page shape: each page's parts in
 * the shared shell, pointed at the shared stylesheet at that page's own
 * depth. The one place the multi-page output shape is spelled, so the
 * per-page and aggregate passes cannot drift.
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
