import path from "node:path";
import { ExportMeta, ExportOptions } from "./exportmeta.js";
import { PageRecord } from "./pagerecord.js";
import { slugify, KindFolders } from "./place.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RenderedAggregatePage {
  /** Vault-relative path of the output HTML file, e.g. tags/alpha.html */
  path: string;
  content: string;
}

/**
 * One starter entry — either from --starters or from the fallback ranking.
 * annotation is optional free-text shown next to the link on the front page.
 */
export interface StarterEntry {
  pageRef: string;
  annotation?: string;
}

// ---------------------------------------------------------------------------
// HTML helpers (kept local to avoid coupling to exportrender)
// ---------------------------------------------------------------------------

function escHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function mdToHtml(ref: string): string {
  return ref.endsWith(".md") ? ref.slice(0, -3) + ".html" : ref;
}

function relPath(fromPath: string, toPath: string): string {
  return path.posix.relative(path.posix.dirname(fromPath), toPath);
}

function rootPrefix(filePath: string): string {
  const depth = filePath.split("/").length - 1;
  if (depth === 0) return "./";
  return "../".repeat(depth);
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

const CSS = `
body { font-family: system-ui, sans-serif; max-width: 52rem; margin: 0 auto; padding: 1rem 1.5rem; line-height: 1.6; }
nav { margin-bottom: 1.5rem; font-size: 0.875rem; }
nav a { color: inherit; }
h1, h2 { line-height: 1.2; }
ul.page-list { list-style: none; padding: 0; }
ul.page-list li { margin: 0.4rem 0; }
ul.page-list li .summary { color: #666; font-size: 0.875rem; margin-left: 0.5rem; }
ul.tag-list { list-style: none; padding: 0; display: flex; flex-wrap: wrap; gap: 0.5rem; }
ul.tag-list li a { text-decoration: none; padding: 0.15rem 0.5rem; border: 1px solid #ccc; border-radius: 3px; font-size: 0.875rem; }
.kind-section { margin-bottom: 2rem; }
.kind-blurb { color: #555; margin-bottom: 0.5rem; }
.get-started-item { margin: 0.5rem 0; }
.get-started-item .annotation { color: #555; font-size: 0.875rem; }
@media (prefers-color-scheme: dark) {
  body { background: #1a1a1a; color: #e0e0e0; }
  ul.page-list li .summary { color: #aaa; }
  ul.tag-list li a { border-color: #555; }
  .kind-blurb { color: #aaa; }
  .get-started-item .annotation { color: #aaa; }
}
`.trim();

function buildNavBar(filePath: string): string {
  const prefix = rootPrefix(filePath);
  return `<nav><a href="${prefix}index.html">Home</a> · <a href="${prefix}tags/index.html">Tags</a></nav>`;
}

function buildHtmlShell(title: string, nav: string, main: string): string {
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

// ---------------------------------------------------------------------------
// Tag pages
// ---------------------------------------------------------------------------

/**
 * Disambiguate tag slugs: when two tags collide after slugify, append "-2",
 * "-3", etc. to the later one. Stable sort: tags that collide are sorted
 * lexically so the winner is deterministic.
 */
function disambiguateTagSlugs(tags: string[]): Map<string, string> {
  const sorted = [...tags].sort();
  const seen = new Map<string, number>();
  const result = new Map<string, string>();
  for (const tag of sorted) {
    const base = slugify(tag, 0) || "tag";
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    result.set(tag, count === 0 ? base : `${base}-${count + 1}`);
  }
  return result;
}

function renderPageListItem(
  ref: string,
  fromPath: string,
  pages: Map<string, { record?: PageRecord; text: string }>,
): string {
  const entry = pages.get(ref);
  const title = entry?.record?.title ?? ref;
  const summary = entry?.record?.summary ?? "";
  const href = relPath(fromPath, mdToHtml(ref));
  return `<li><a href="${escHtml(href)}">${escHtml(title)}</a>${summary ? `<span class="summary">— ${escHtml(summary)}</span>` : ""}</li>`;
}

function buildTagPage(
  tag: string,
  slug: string,
  pageRefs: string[],
  pages: Map<string, { record?: PageRecord; text: string }>,
): string {
  const filePath = `tags/${slug}.html`;
  const nav = buildNavBar(filePath);
  const items = pageRefs
    .map((ref) => renderPageListItem(ref, filePath, pages))
    .join("\n");
  const main = `<h1>Tag: ${escHtml(tag)}</h1>\n<ul class="page-list">\n${items}\n</ul>`;
  return buildHtmlShell(`Tag: ${escHtml(tag)}`, nav, main);
}

function buildTagIndex(
  tagMap: Map<string, string[]>,
  tagSlugs: Map<string, string>,
): string {
  const filePath = "tags/index.html";
  const nav = buildNavBar(filePath);
  const sorted = [...tagMap.keys()].sort();
  const items = sorted
    .map((tag) => {
      const slug = tagSlugs.get(tag)!;
      const count = tagMap.get(tag)!.length;
      return `<li><a href="${escHtml(slug)}.html">${escHtml(tag)}</a> <span>(${count})</span></li>`;
    })
    .join("\n");
  const main = `<h1>All Tags</h1>\n<ul class="tag-list">\n${items}\n</ul>`;
  return buildHtmlShell("All Tags", nav, main);
}

// ---------------------------------------------------------------------------
// Kind index pages
// ---------------------------------------------------------------------------

function buildKindIndex(
  kind: string,
  folder: string,
  pageRefs: string[],
  pages: Map<string, { record?: PageRecord; text: string }>,
): string {
  const filePath = `wiki/${folder}/index.html`;
  const nav = buildNavBar(filePath);
  const items = pageRefs
    .map((ref) => renderPageListItem(ref, filePath, pages))
    .join("\n");
  const kindTitle = kind.charAt(0).toUpperCase() + kind.slice(1) + "s";
  const main = `<h1>${escHtml(kindTitle)}</h1>\n<ul class="page-list">\n${items}\n</ul>`;
  return buildHtmlShell(kindTitle, nav, main);
}

// ---------------------------------------------------------------------------
// Front page
// ---------------------------------------------------------------------------

function buildFrontPage(
  meta: ExportMeta,
  pages: Map<string, { record?: PageRecord; text: string }>,
  starters: StarterEntry[],
  kindBlurbs: Map<string, string>,
): string {
  const filePath = "index.html";
  const nav = buildNavBar(filePath);
  const totalCount = [...pages.keys()].filter((r) =>
    r.startsWith("wiki/"),
  ).length;

  const kindItems: string[] = [];
  for (const [kind, refs] of [...meta.kindMap.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const folder = KindFolders[kind] ?? kind;
    const blurb = kindBlurbs.get(kind) ?? "";
    const blurbHtml = blurb
      ? `<p class="kind-blurb">${escHtml(blurb)}</p>`
      : "";
    kindItems.push(
      `<div class="kind-section"><h2><a href="wiki/${escHtml(folder)}/index.html">${escHtml(kind)}</a> (${refs.length})</h2>${blurbHtml}</div>`,
    );
  }

  const getStartedEntries: StarterEntry[] =
    starters.length > 0
      ? starters
      : meta.getStarted.map((e) => ({ pageRef: e.pageRef }));

  const getStartedItems = getStartedEntries
    .map(({ pageRef, annotation }) => {
      const entry = pages.get(pageRef);
      const title = entry?.record?.title ?? pageRef;
      const href = mdToHtml(pageRef);
      const annotationHtml = annotation
        ? `<span class="annotation"> — ${escHtml(annotation)}</span>`
        : "";
      return `<li class="get-started-item"><a href="${escHtml(href)}">${escHtml(title)}</a>${annotationHtml}</li>`;
    })
    .join("\n");

  const main = [
    `<h1>Wiki</h1>`,
    `<p>${totalCount} pages</p>`,
    kindItems.length > 0
      ? `<section>\n${kindItems.join("\n")}\n</section>`
      : "",
    getStartedItems
      ? `<section><h2>Get started</h2>\n<ul class="page-list">\n${getStartedItems}\n</ul></section>`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  return buildHtmlShell("Wiki", nav, main);
}

// ---------------------------------------------------------------------------
// Main generator
// ---------------------------------------------------------------------------

/**
 * Lazy generator yielding one { path, content } entry per aggregate page.
 *
 * Emits in order: tag pages, tags/index.html (always, even when empty),
 * kind index pages, front page.
 *
 * `kindBlurbs` maps kind value → KIND.md summary string. Pass an empty map
 * when not available.
 *
 * `starters` overrides the fallback get-started ranking. Pass an empty array
 * to use the fallback from meta.getStarted.
 */
export function* renderAggregatePages(
  pages: Map<string, { record?: PageRecord; text: string }>,
  meta: ExportMeta,
  _opts: ExportOptions = {},
  starters: StarterEntry[] = [],
  kindBlurbs: Map<string, string> = new Map(),
): Generator<RenderedAggregatePage> {
  const tagSlugs = disambiguateTagSlugs([...meta.tagMap.keys()]);

  for (const [tag, refs] of meta.tagMap.entries()) {
    const slug = tagSlugs.get(tag)!;
    yield {
      path: `tags/${slug}.html`,
      content: buildTagPage(tag, slug, refs, pages),
    };
  }

  // Always emit tags/index.html so nav links never dangle in a tag-less vault.
  yield {
    path: "tags/index.html",
    content: buildTagIndex(meta.tagMap, tagSlugs),
  };

  for (const [kind, refs] of meta.kindMap.entries()) {
    const folder = KindFolders[kind] ?? kind;
    yield {
      path: `wiki/${folder}/index.html`,
      content: buildKindIndex(kind, folder, refs, pages),
    };
  }

  yield {
    path: "index.html",
    content: buildFrontPage(meta, pages, starters, kindBlurbs),
  };
}
