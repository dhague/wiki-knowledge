/**
 * Per-page HTML render pass for `enchiridion export`.
 *
 * A lazy generator that, given page records + export metadata + options,
 * yields { path, content } entries for each exported page HTML file. Pure —
 * no filesystem access, no model. The path is vault-relative with .html
 * extension; the content is a self-contained HTML page.
 *
 * Link rewriting uses the iterLinks/offset-splice path from wikipage.ts:
 * .md destinations are rewritten to .html (anchors preserved); a link whose
 * target is outside the exported set is stripped to plain label text.
 *
 * Aggregate pages (tag pages, tag index, per-kind index pages, front page)
 * are a separate pass in exportaggregate.ts — concatenate the two generators
 * to get the full output set.
 */

import path from "node:path";
import MarkdownIt from "markdown-it";
import { parse as parseYaml } from "yaml";
import { PageRecord, EdgeKeys } from "./pagerecord.js";
import { ExportMeta, ExportOptions, buildTagSlugMap } from "./exportmeta.js";
import { iterLinks, resolveLinkDest, splitFrontmatter } from "./wikipage.js";
import { slugify } from "./place.js";

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface RenderedPage {
  /** Vault-relative path of the output HTML file, e.g. wiki/concepts/foo.html */
  path: string;
  content: string;
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

/** Relative path from a page's HTML file to the output root (e.g. "../../"). */
function rootPrefix(pageRef: string): string {
  const depth = mdToHtml(pageRef).split("/").length - 1;
  if (depth === 0) return "./";
  return "../".repeat(depth);
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
  const prefix = rootPrefix(pageRef);
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
// CSS
// ---------------------------------------------------------------------------

export const CSS = `
body { font-family: system-ui, sans-serif; max-width: 52rem; margin: 0 auto; padding: 1rem 1.5rem; line-height: 1.6; }
nav { margin-bottom: 1.5rem; font-size: 0.875rem; }
nav a { color: inherit; }
table.frontmatter { border-collapse: collapse; margin-bottom: 1.5rem; font-size: 0.875rem; width: 100%; }
table.frontmatter td { border: 1px solid #ccc; padding: 0.25rem 0.5rem; vertical-align: top; }
table.frontmatter td:first-child { font-weight: 600; white-space: nowrap; }
tr.fm-divider td { border: none; border-top: 2px solid #888; padding: 0; height: 0; }
ul { margin: 0; padding-left: 1.25rem; }
@media (prefers-color-scheme: dark) {
  body { background: #1a1a1a; color: #e0e0e0; }
  table.frontmatter td { border-color: #555; }
  tr.fm-divider td { border-top-color: #888; }
}
`.trim();

// ---------------------------------------------------------------------------
// Page assembly
// ---------------------------------------------------------------------------

function buildNavBar(pageRef: string): string {
  const prefix = rootPrefix(pageRef);
  return `<nav><a href="${prefix}index.html">Home</a> · <a href="${prefix}tags/index.html">Tags</a></nav>`;
}

export function buildHtmlShell(
  title: string,
  nav: string,
  main: string,
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${title}</title>
<style>${CSS}</style>
</head>
<body>
${nav}
${main}
</body>
</html>`;
}

function buildPage(
  pageRef: string,
  record: PageRecord,
  text: string,
  exported: Set<string>,
  allPages: Map<string, { record?: PageRecord; text: string }>,
  tagSlugMap: Map<string, string>,
): string {
  const nav = buildNavBar(pageRef);
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
  return buildHtmlShell(escHtml(record.title || pageRef), nav, main);
}

/** Minimal rendering for raw/ pages (no PageRecord). */
function buildRawPage(
  pageRef: string,
  text: string,
  exported: Set<string>,
): string {
  const nav = buildNavBar(pageRef);
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
  return buildHtmlShell(escHtml(pageRef), nav, main);
}

// ---------------------------------------------------------------------------
// Generator
// ---------------------------------------------------------------------------

/**
 * Lazy generator yielding one { path, content } entry per exported page.
 *
 * `pages` is the same Map<pageRef, {record?, text}> fed to buildExportMeta.
 * `meta` carries pre-computed aggregate metadata; used by callers that also
 * generate index/tag pages from the same pass. `opts` controls which subtrees
 * are exported.
 */
export function* renderPages(
  pages: Map<string, { record?: PageRecord; text: string }>,
  meta: ExportMeta,
  opts: ExportOptions = {},
): Generator<RenderedPage> {
  const includeRaw = opts.includeRaw ?? false;

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
      yield { path: htmlPath, content: buildRawPage(pageRef, text, exported) };
      continue;
    }
    yield {
      path: htmlPath,
      content: buildPage(pageRef, record, text, exported, pages, tagSlugMap),
    };
  }
}
