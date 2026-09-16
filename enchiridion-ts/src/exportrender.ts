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
 * Link rewriting uses the iterLinks/offset-splice path from wikipage.ts:
 * .md destinations are rewritten to .html (anchors preserved); a link whose
 * target is outside the exported set is stripped to plain label text.
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
 * Rewrite/strip links in the body text before markdown-it rendering.
 * - Relative .md links to exported targets: destination rewritten to .html
 * - Relative .md links to non-exported targets: full [label](dest) → label
 * - Bare anchors, absolute URLs, non-.md relative links: left alone
 */
function rewriteBodyLinks(
  bodyText: string,
  pageRef: string,
  exported: Set<string>,
): string {
  const pageDir = vaultPageDir(pageRef);
  const edits: Edit[] = [];

  for (const link of iterLinks(bodyText)) {
    const p = link.decodedPath;
    if (p === "" || p.startsWith("/") || p.includes("://")) continue;
    if (!p.endsWith(".md")) continue;

    const target = resolveLinkDest(p, pageDir);

    if (exported.has(target)) {
      edits.push({
        start: link.start,
        end: link.end,
        replacement: relHtmlPath(pageRef, target, link.decodedAnchor),
      });
    } else {
      // Strip link: replace full [label](dest) with label text
      edits.push({
        start: link.fullStart,
        end: link.fullEnd,
        replacement: link.label,
      });
    }
  }

  return applyEdits(bodyText, edits);
}

// ---------------------------------------------------------------------------
// Frontmatter table rendering
// ---------------------------------------------------------------------------

const FM_LINK_KEYS = new Set(EdgeKeys);

/** Render a frontmatter value that is a markdown link string as HTML. */
function renderFmLink(
  markdownLink: string,
  pageRef: string,
  exported: Set<string>,
): string {
  const links = iterLinks(markdownLink);
  if (links.length === 0) return escHtml(markdownLink);
  const link = links[0];
  if (link.decodedPath === "" || !link.decodedPath.endsWith(".md")) {
    return `<a href="${escHtml(link.dest)}">${escHtml(link.label)}</a>`;
  }
  const target = resolveLinkDest(link.decodedPath, vaultPageDir(pageRef));
  if (!exported.has(target)) return escHtml(link.label);
  return `<a href="${escHtml(relHtmlPath(pageRef, target, link.decodedAnchor))}">${escHtml(link.label)}</a>`;
}

/** Render a tag as a link to its tag page. */
function renderTagLink(
  tag: string,
  pageRef: string,
  tagSlugMap: Map<string, string>,
): string {
  const slug = tagSlugMap.get(tag) ?? slugify(tag, 0);
  const prefix = rootPrefix(mdToHtml(pageRef));
  return `<a href="${escHtml(`${prefix}tags/${slug}.html`)}">${escHtml(tag)}</a>`;
}

/** Render a single frontmatter value as HTML. */
function renderFmValue(
  key: string,
  value: unknown,
  pageRef: string,
  exported: Set<string>,
  tagSlugMap: Map<string, string>,
): string {
  if (value === null || value === undefined) return "";

  if (key === "tags") {
    if (!Array.isArray(value)) return escHtml(String(value));
    const items = value.map(
      (tag) =>
        `<li>${renderTagLink(typeof tag === "string" ? tag : String(tag), pageRef, tagSlugMap)}</li>`,
    );
    return `<ul>${items.join("")}</ul>`;
  }

  if (FM_LINK_KEYS.has(key)) {
    if (Array.isArray(value)) {
      const items = value.map(
        (item) =>
          `<li>${renderFmLink(typeof item === "string" ? item : String(item), pageRef, exported)}</li>`,
      );
      return `<ul>${items.join("")}</ul>`;
    }
    return renderFmLink(
      typeof value === "string" ? value : String(value),
      pageRef,
      exported,
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
): string {
  const entry = allPages.get(targetRef);
  const label = entry?.record?.title ?? targetRef;
  if (!exported.has(targetRef)) return escHtml(label);
  return `<a href="${escHtml(relHtmlPath(pageRef, targetRef))}">${escHtml(label)}</a>`;
}

function renderFrontmatterTable(
  pageRef: string,
  record: PageRecord,
  text: string,
  exported: Set<string>,
  allPages: Map<string, { record?: PageRecord; text: string }>,
  tagSlugMap: Map<string, string>,
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
      `<tr><td>${escHtml(key)}</td><td>${renderFmValue(key, value, pageRef, exported, tagSlugMap)}</td></tr>`,
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
    sbHtml = renderPageLink(sb[0], pageRef, exported, allPages);
  } else {
    sbHtml = `<ul>${sb.map((ref) => `<li>${renderPageLink(ref, pageRef, exported, allPages)}</li>`).join("")}</ul>`;
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
export function buildNavBar(htmlPath: string, wikiTitle: string): string {
  const prefix = rootPrefix(htmlPath);
  return `<nav class="wiki-nav">
<span class="wiki-nav-title">${escHtml(wikiTitle)}</span>
<span class="wiki-nav-links"><a href="${prefix}index.html">Home</a> · <a href="${prefix}tags/index.html">Tags</a></span>
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
): PageParts {
  const nav = buildNavBar(mdToHtml(pageRef), wikiTitle);
  const fmTable = renderFrontmatterTable(
    pageRef,
    record,
    text,
    exported,
    allPages,
    tagSlugMap,
  );
  const { body } = splitFrontmatter(text);
  const bodyHtml = mdRender.render(rewriteBodyLinks(body, pageRef, exported));
  const main = `${fmTable}\n<article>\n${bodyHtml}</article>`;
  return { title: record.title || pageRef, nav, main };
}

/** Minimal rendering for raw/ pages (no PageRecord). */
function buildRawPageParts(
  pageRef: string,
  text: string,
  exported: Set<string>,
  wikiTitle: string,
): PageParts {
  const nav = buildNavBar(mdToHtml(pageRef), wikiTitle);
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
  const bodyHtml = mdRender.render(rewriteBodyLinks(body, pageRef, exported));
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
 */
export function* renderPageParts(
  pages: Map<string, { record?: PageRecord; text: string }>,
  meta: ExportMeta,
  opts: ExportOptions = {},
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
        parts: buildRawPageParts(pageRef, text, exported, wikiTitle),
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
