/**
 * The single-file export: the whole site as one self-contained document.
 *
 * The third consumer of the parts generators, alongside the two shell
 * wrappers in exportrender/exportaggregate. Multi-page output wraps each
 * page's parts in its own document and links the next one by file path; this
 * one nests every page's parts in a `<section>` of a single document and
 * links the next one by fragment. That is the whole difference — the parts
 * themselves are the same, rendered once, by the same code.
 *
 * A recipient opens the file straight from an email attachment on a phone:
 * no unzip, no server, no network. The CSS is inlined and the only script is
 * the one below, so the document fetches nothing at all.
 *
 * Navigation is hash-based rather than the History API: `pushState` is
 * unreliable on `file://` (it throws a SecurityError in some browsers), and
 * `file://` is the entire point of this mode.
 */

import { PageRecord } from "./pagerecord.js";
import { ExportMeta, ExportOptions, exportTitle } from "./exportmeta.js";
import {
  PageParts,
  renderPageParts,
  sectionIdFor,
  escHtml,
} from "./exportrender.js";
import { renderAggregateParts } from "./exportaggregate.js";
import { EXPORT_STYLESHEET } from "./exportstyle.js";

/**
 * The filename a single-file export defaults to, at the vault root. `--out`
 * names the file in this mode; this is what it names when nothing was given.
 */
export const SINGLE_FILE_DEFAULT_NAME = "wiki.html";

/**
 * What is too large to be worth emailing. Not a cap — an oversized export is
 * written all the same, with a pointer to the mode that suits it better.
 */
export const SINGLE_FILE_WARN_BYTES = 5 * 1024 * 1024;

/**
 * The warning for a single-file export too large to send, or null when the
 * file is a comfortable size. The caller writes the file either way; this
 * only decides what to say about it.
 */
export function singleFileSizeWarning(
  bytes: number,
  label: string,
): string | null {
  if (bytes <= SINGLE_FILE_WARN_BYTES) return null;
  const mb = (bytes / (1024 * 1024)).toFixed(1);
  return `Warning: ${label} is ${mb} MB — over the 5 MB that is comfortable to email. The file has been written; multi-page export (without --single-file) may suit a vault this size better.`;
}

// ---------------------------------------------------------------------------
// The single-file-only CSS and script
// ---------------------------------------------------------------------------

/**
 * Rules that belong to this document shape and to no other. Hiding the
 * sections in CSS rather than in the script is deliberate: the file is up to
 * several megabytes of markup, and hiding it in the script would flash the
 * whole wiki on screen between the first paint and the script running.
 */
const SINGLE_FILE_CSS = `/* enchiridion single-file supplement
 * ===================================
 * Every page of the export is a <section> of this one document and exactly
 * one is shown, chosen by the script at the end of the body from
 * location.hash. Hidden in CSS, not in the script, so nothing flashes.
 */
section.wiki-page {
  display: none;
}

section.wiki-page.active {
  display: block;
}
`;

/**
 * The whole of this mode's behaviour, and the only script in the file.
 *
 * Written as ES5 in a plain IIFE: it runs on whatever browser opens an email
 * attachment, with no build step and no polyfill to fetch. It reads the hash
 * on load and on every hash change, which is what gives the back button its
 * history (each hash change is its own entry) and what makes a `#slug` deep
 * link land on its section.
 */
const SINGLE_FILE_SCRIPT = `(function () {
  var FRONT = "__front";
  var ACTIVE = "wiki-page active";
  var IDLE = "wiki-page";
  var sections = document.querySelectorAll("section.wiki-page");

  function find(id) {
    for (var i = 0; i < sections.length; i++) {
      if (sections[i].id === id) return sections[i];
    }
    return null;
  }

  function show(section) {
    for (var i = 0; i < sections.length; i++) {
      sections[i].className = sections[i] === section ? ACTIVE : IDLE;
    }
  }

  function go(isInitialLoad) {
    var target = find(location.hash.slice(1));
    if (target) {
      show(target);
      // Sections have no scroll position of their own, so a swap inherits
      // whatever offset the previous page was read at. A navigation starts
      // at the top; a heading anchor is left to the browser.
      if (!isInitialLoad) window.scrollTo(0, 0);
      return;
    }
    // The hash names no section: either there is none, or it is an in-page
    // heading anchor (or a dead link). A cold open with nothing to show
    // lands on the front page; afterwards the section already on screen
    // stays there, so the browser can scroll to the heading itself.
    if (isInitialLoad) show(find(FRONT));
  }

  window.addEventListener("hashchange", function () {
    go(false);
  });
  go(true);
})();`;

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/**
 * One page's parts as a section of the document. The id comes from
 * [sectionIdFor] — the same function every link to this page was rewritten
 * through, which is why a rewritten link cannot miss.
 */
function buildSection(htmlPath: string, parts: PageParts): string {
  return `<section id="${escHtml(sectionIdFor(htmlPath))}" class="wiki-page">
${parts.nav}
${parts.main}
</section>`;
}

function buildDocument(title: string, sections: string[]): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escHtml(title)}</title>
<style>
${EXPORT_STYLESHEET}
${SINGLE_FILE_CSS}
</style>
</head>
<body>
${sections.join("\n")}
<script>
${SINGLE_FILE_SCRIPT}
</script>
</body>
</html>
`;
}

/**
 * Render the whole export as one HTML document: every page and aggregate of
 * the exported set as a `<section>`, the stylesheet inlined, and a link
 * strategy of `#section` fragments so no link leaves the file.
 *
 * Same inputs and same options as the multi-page generators, and the same
 * parts underneath — this is a shape, not a second renderer.
 */
export function renderSingleFile(
  pages: Map<string, { record?: PageRecord; text: string }>,
  meta: ExportMeta,
  opts: ExportOptions = {},
): string {
  const sections: string[] = [];
  const parts = [
    ...renderPageParts(pages, meta, opts, "single-file"),
    ...renderAggregateParts(pages, meta, opts, "single-file"),
  ];
  for (const { path, parts: pageParts } of parts) {
    sections.push(buildSection(path, pageParts));
  }
  return buildDocument(exportTitle(opts), sections);
}
