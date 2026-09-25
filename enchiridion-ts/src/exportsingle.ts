/**
 * The single-file export: the whole site as one self-contained document, every
 * page a `<section>` and every internal link a `#fragment`.
 *
 * It fetches nothing — the CSS is inlined and the file's only script is the one
 * below. Navigation is hash-based rather than the History API because
 * `pushState` throws a SecurityError on `file://` in some browsers, and
 * `file://` is the entire point of this mode.
 */

import { PageRecord } from "./pagerecord.js";
import { ExportMeta, ExportOptions, exportTitle } from "./exportmeta.js";
import {
  PageParts,
  buildDocument,
  renderPageParts,
  sectionIdFor,
  escHtml,
} from "./exportrender.js";
import { renderAggregateParts } from "./exportaggregate.js";
import { EXPORT_STYLESHEET } from "./exportstyle.js";

/** The filename a single-file export defaults to, when `--out` is not given. */
export const SINGLE_FILE_DEFAULT_NAME = "wiki.html";

/** Not a cap: an oversized export is still written, with a pointer to the mode
 *  that suits it better. */
export const SINGLE_FILE_WARN_BYTES = 5 * 1024 * 1024;

export function singleFileSizeWarning(
  bytes: number,
  file: string,
): string | null {
  if (bytes <= SINGLE_FILE_WARN_BYTES) return null;
  const mb = (n: number) => (n / (1024 * 1024)).toFixed(1);
  return `Warning: ${file} is ${mb(bytes)} MB — over the ${mb(SINGLE_FILE_WARN_BYTES)} MB that is comfortable to email. The file has been written; multi-page export (without --single-file) may suit a vault this size better.`;
}

// ---------------------------------------------------------------------------
// The single-file-only CSS and script
// ---------------------------------------------------------------------------

/**
 * Hiding the sections in CSS rather than in the script is deliberate: the file
 * is megabytes of markup, and script-side hiding would flash the whole wiki
 * between first paint and the script running.
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
 * The whole of this mode's behaviour, and the file's only script. ES5 in a
 * plain IIFE: it runs on whatever browser opens an email attachment. Reading
 * the hash on load and on every change is what gives Back its history and makes
 * a `#slug` deep link land.
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
    var id = location.hash.slice(1);
    // No hash means the front page — on a cold open, and on a Back that
    // returned to the document root, which are the same destination.
    var target = find(id) || (id === "" ? find(FRONT) : null);
    if (!target) {
      // A hash naming something that is not a section: an in-page heading
      // anchor, or a dead link. A cold open with nothing to show lands on
      // the front page; afterwards the section already on screen stays, so
      // the browser can scroll to the heading itself.
      if (isInitialLoad) show(find(FRONT));
      return;
    }
    show(target);
    // Sections have no scroll position of their own, so a swap inherits
    // whatever offset the previous page was read at. A navigation starts at
    // the top; a heading anchor is left to the browser.
    if (!isInitialLoad) window.scrollTo(0, 0);
  }

  window.addEventListener("hashchange", function () {
    go(false);
  });
  go(true);
})();`;

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/** One page's parts as a section; the id comes from [sectionIdFor], the same
 *  function every link to the page was rewritten through. */
function buildSection(htmlPath: string, parts: PageParts): string {
  return `<section id="${escHtml(sectionIdFor(htmlPath))}" class="wiki-page">
${parts.nav}
${parts.main}
</section>`;
}

/** The one document: shared skeleton, this mode's styling inlined (there is no
 *  second file to link), script after the sections it switches between. */
function buildSingleFileDocument(title: string, sections: string[]): string {
  const style = `<style>
${EXPORT_STYLESHEET}
${SINGLE_FILE_CSS}
</style>`;
  const body = `${sections.join("\n")}
<script>
${SINGLE_FILE_SCRIPT}
</script>`;
  return buildDocument(title, style, body);
}

/** Render the whole exported set as one HTML document: every page and aggregate
 *  a `<section>`, the stylesheet inlined, links rewritten to `#fragment`s.
 *  Same inputs, options and parts as the multi-page generators. */
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
  return buildSingleFileDocument(exportTitle(opts), sections);
}
