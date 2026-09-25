/**
 * The stylesheet every exported site ships: Sakura v1.5.1 vendored verbatim
 * (MIT — https://github.com/oxalorg/sakura/), then a supplement for what a
 * classless framework cannot know.
 *
 * A string constant because the export must stay offline and the script layer
 * ships as one bundle (ADR-0017).
 */

/** Sakura v1.5.1, verbatim (MIT). Updating the vendor drop replaces the whole
 *  constant; the upstream licence header is part of the text — do not strip it. */
export const SAKURA_CSS = `/* Sakura.css v1.5.1
 * ================
 * Minimal css theme.
 * Project: https://github.com/oxalorg/sakura/
 */
/* Body */
html {
  font-size: 62.5%;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif;
}

body {
  font-size: 1.8rem;
  line-height: 1.618;
  max-width: 38em;
  margin: auto;
  color: #4a4a4a;
  background-color: #f9f9f9;
  padding: 13px;
}

@media (max-width: 684px) {
  body {
    font-size: 1.53rem;
  }
}
@media (max-width: 382px) {
  body {
    font-size: 1.35rem;
  }
}
h1, h2, h3, h4, h5, h6 {
  line-height: 1.1;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif;
  font-weight: 700;
  margin-top: 3rem;
  margin-bottom: 1.5rem;
  overflow-wrap: break-word;
  word-wrap: break-word;
  -ms-word-break: break-all;
  word-break: break-word;
}

h1 {
  font-size: 2.35em;
}

h2 {
  font-size: 2em;
}

h3 {
  font-size: 1.75em;
}

h4 {
  font-size: 1.5em;
}

h5 {
  font-size: 1.25em;
}

h6 {
  font-size: 1em;
}

p {
  margin-top: 0px;
  margin-bottom: 2.5rem;
}

small, sub, sup {
  font-size: 75%;
}

hr {
  border-color: #1d7484;
}

a {
  text-decoration: none;
  color: #1d7484;
}
a:visited {
  color: #144f5a;
}
a:hover {
  color: #982c61;
  border-bottom: 2px solid #4a4a4a;
}

ul {
  padding-left: 1.4em;
  margin-top: 0px;
  margin-bottom: 2.5rem;
}

li {
  margin-bottom: 0.4em;
}

blockquote {
  margin-left: 0px;
  margin-right: 0px;
  padding-left: 1em;
  padding-top: 0.8em;
  padding-bottom: 0.8em;
  padding-right: 0.8em;
  border-left: 5px solid #1d7484;
  margin-bottom: 2.5rem;
  background-color: #f1f1f1;
}

blockquote p {
  margin-bottom: 0;
}

img, video {
  height: auto;
  max-width: 100%;
  margin-top: 0px;
  margin-bottom: 2.5rem;
}

/* Pre and Code */
pre {
  background-color: #f1f1f1;
  display: block;
  padding: 1em;
  overflow-x: auto;
  margin-top: 0px;
  margin-bottom: 2.5rem;
  font-size: 0.9em;
}

code, kbd, samp {
  font-size: 0.9em;
  padding: 0 0.5em;
  background-color: #f1f1f1;
  white-space: pre-wrap;
}

pre > code {
  padding: 0;
  background-color: transparent;
  white-space: pre;
  font-size: 1em;
}

/* Tables */
table {
  text-align: justify;
  width: 100%;
  border-collapse: collapse;
  margin-bottom: 2rem;
}

td, th {
  padding: 0.5em;
  border-bottom: 1px solid #f1f1f1;
}

/* Buttons, forms and input */
input, textarea {
  border: 1px solid #4a4a4a;
}
input:focus, textarea:focus {
  border: 1px solid #1d7484;
}

textarea {
  width: 100%;
}

.button, button,
input[type=submit],
input[type=reset],
input[type=button],
input[type=file]::file-selector-button {
  display: inline-block;
  padding: 5px 10px;
  text-align: center;
  text-decoration: none;
  white-space: nowrap;
  background-color: #1d7484;
  color: #f9f9f9;
  border-radius: 1px;
  border: 1px solid #1d7484;
  cursor: pointer;
  box-sizing: border-box;
}
.button:hover, button:hover,
input[type=submit]:hover,
input[type=reset]:hover,
input[type=button]:hover,
input[type=file]::file-selector-button:hover {
  background-color: #982c61;
  color: #f9f9f9;
  outline: 0;
}

.button[disabled], button[disabled],
input[type=submit][disabled],
input[type=reset][disabled],
input[type=button][disabled],
input[type=file][disabled] {
  cursor: default;
  opacity: 0.5;
}
.button:focus-visible, button:focus-visible,
input[type=submit]:focus-visible,
input[type=reset]:focus-visible,
input[type=button]:focus-visible,
input[type=file]:focus-visible {
  outline-style: solid;
  outline-width: 2px;
}

textarea, select, input {
  color: #4a4a4a;
  padding: 6px 10px; /* The 6px vertically centers text on FF, ignored by Webkit */
  margin-bottom: 10px;
  background-color: #f1f1f1;
  border: 1px solid #f1f1f1;
  border-radius: 4px;
  box-shadow: none;
  box-sizing: border-box;
}
textarea:focus, select:focus, input:focus {
  border: 1px solid #1d7484;
  outline: 0;
}

input[type=checkbox]:focus {
  outline: 1px dotted #1d7484;
}

label, legend, fieldset {
  display: block;
  margin-bottom: 0.5rem;
  font-weight: 600;
}`;

/** The stylesheet's directory and file name in the exported site. */
export const STYLESHEET_DIR = "assets";
export const STYLESHEET_FILE = "style.css";

const EXPORT_SUPPLEMENT_CSS = `/* enchiridion export supplement
 * =============================
 * What a classless framework cannot know: the sticky navigation bar every
 * page carries, the title-and-summary page header above the article, and the
 * two-column frontmatter table's leading column.
 * Kept deliberately small — everything else is Sakura's job.
 */

nav.wiki-nav {
  position: sticky;
  top: 0;
  z-index: 10;
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: baseline;
  gap: 0.25em 1em;
  padding: 0.6em 0;
  margin-bottom: 1.5rem;
  background-color: #f9f9f9;
  border-bottom: 1px solid #e6e6e6;
}

nav.wiki-nav .wiki-nav-title {
  font-weight: 700;
}

nav.wiki-nav .wiki-nav-links {
  white-space: nowrap;
}

/* Sakura underlines links with a bottom border on hover, which would grow the
 * bar by 2px and nudge the page under it. Use real underlines instead. */
nav.wiki-nav a:hover {
  border-bottom: none;
  text-decoration: underline;
}

/* The page header: the frontmatter's title and summary, lifted above the
 * article. The title is the page's own h1, so it needs no new rule; the
 * summary is set apart from the article's first paragraph as a subtitle
 * rather than left to read as content. */
.page-header h1 {
  margin-bottom: 0.5rem;
}

.page-summary {
  font-size: 0.95em;
  color: #6a6a6a;
}

table.frontmatter {
  font-size: 0.9em;
  text-align: left;
  /* As a footer the table butts against whatever the article ends with. The
   * margin collapses with the preceding block's own bottom margin, so it only
   * supplies the separation when that block has none. */
  margin-top: 2rem;
}

table.frontmatter td {
  border-bottom: 1px solid #e6e6e6;
}

table.frontmatter td:first-child {
  font-weight: 600;
  white-space: nowrap;
  width: 1%;
}

table.frontmatter ul {
  margin-bottom: 0;
}

/* The rule marking where the page's own frontmatter ends and the derived
 * rows (kind, superseded_by) begin. Kept even under a framework whose tables
 * already rule every row: it separates two different kinds of fact.
 *
 * 2px, not 1px: Sakura rules every td at 1px and borders collapse, and for
 * an equal-width conflict the row above wins the colour — so a 1px divider
 * would silently inherit the row rule above it and vanish. */
tr.fm-divider td {
  border-bottom: none;
  border-top: 2px solid #4a4a4a;
  padding: 0;
  height: 0;
}`;

/** What `assets/style.css` contains, and what single-file mode inlines. */
export const EXPORT_STYLESHEET = `${SAKURA_CSS}

${EXPORT_SUPPLEMENT_CSS}
`;
