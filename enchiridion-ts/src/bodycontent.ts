/**
 * bodycontent — the Consolidation losslessness boundary. Two bodies are
 * compared as sequences of canonical top-level markdown blocks, so the gate
 * asks whether an absorbed page's *content* is present in the survivor, not
 * whether the bytes match (ADR-0030).
 *
 * A block runs from a level-0 markdown-it token to its matching level-0 close,
 * or is one self-closing level-0 token. Each block is rendered to HTML and
 * normalised, and the absorbed body's canonical block sequence must appear as
 * one contiguous sub-sequence of the survivor's.
 *
 * Normalised away — a difference here still passes:
 * - line endings: CRLF and lone CR read as LF, inside code as well as outside
 * - whitespace outside `<pre>`/`<code>`: newlines, indentation, trailing spaces
 *   and blank lines between blocks, so a hard break reads as a plain space
 * - heading level, and setext vs atx spelling
 * - bullet glyph, ordered-list numbering and start
 * - emphasis marker spelling, and thematic-break spelling (presence still
 *   counts)
 * - table padding and its alignment row
 * - link-destination spelling, when both resolve to the same page: the caller
 *   canonicalises links before this comparison
 *
 * Significant — a difference here fails:
 * - every word, digit, identifier and punctuation mark
 * - block kind and order, and list nesting depth or bullet-vs-ordered kind
 * - strong vs emphasis
 * - inline-code content, and fenced-code content and fence language
 * - link labels, image alt text, and image vs link
 * - raw HTML blocks, verbatim
 * - external (non-vault) destinations, literally
 */

import MarkdownIt from "markdown-it";
import { normalizeNewlines } from "./fingerprint.js";

const md = new MarkdownIt();

type Token = ReturnType<InstanceType<typeof MarkdownIt>["parse"]>[number];

/** One top-level markdown block, canonicalised for comparison. */
export interface BodyBlock {
  /** The block rendered to HTML and normalised; equality is content, not source spelling. */
  canonical: string;
  /** The block's first source line, for naming it in a refusal. */
  opening: string;
}

/** The canonical top-level blocks of a markdown body, in order. */
export function bodyBlocks(body: string): BodyBlock[] {
  const src = normalizeNewlines(body);
  const lines = src.split("\n");
  const blocks: BodyBlock[] = [];
  for (const run of blockRuns(md.parse(src, {}))) {
    const canonical = canonicalHtml(md.renderer.render(run, md.options, {}));
    if (canonical === "") continue;
    blocks.push({ canonical, opening: openingLine(lines, run) });
  }
  return blocks;
}

/** The index into `want` of the first block with no contiguous match in
 * `have`, or -1 when all of `want` sits inside `have` as one unbroken run. */
export function firstUnmatchedBlock(
  want: BodyBlock[],
  have: BodyBlock[],
): number {
  let best = 0;
  for (let start = 0; start < have.length; start++) {
    let k = 0;
    while (
      k < want.length &&
      start + k < have.length &&
      have[start + k].canonical === want[k].canonical
    ) {
      k++;
    }
    if (k > best) best = k;
    if (best === want.length) return -1;
  }
  return best === want.length ? -1 : best;
}

/** Split a token stream into runs, one per top-level block: an opening token
 * through its matching close, or a lone self-closing token. */
function blockRuns(tokens: Token[]): Token[][] {
  const runs: Token[][] = [];
  let i = 0;
  while (i < tokens.length) {
    let j = i + 1;
    if (tokens[i].nesting === 1) {
      let depth = 1;
      while (j < tokens.length && depth > 0) {
        if (tokens[j].nesting === 1) depth++;
        else if (tokens[j].nesting === -1) depth--;
        j++;
      }
    }
    runs.push(tokens.slice(i, j));
    i = j;
  }
  return runs;
}

function openingLine(lines: string[], run: Token[]): string {
  for (const token of run) {
    if (token.map) return lines[token.map[0]] ?? "";
  }
  return "";
}

const Tag = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)/;
const Break = /^<br\s*\/?>$/i;
const Heading = /^<(\/?)h[1-6]([\s/>]|$)/;

/** Strip the presentation-only parts of one HTML tag: a hard break, an ordered
 * list's start number, a table cell's alignment style, and a heading's level. */
function canonicalTag(tag: string): string {
  if (Break.test(tag)) return "";
  let out = tag.replace(/\s+style="[^"]*"/g, "");
  if (Tag.exec(tag)?.[2]?.toLowerCase() === "ol") {
    out = out.replace(/\s+start="[^"]*"/, "");
  }
  return out.replace(Heading, "<$1h1$2");
}

/** Canonicalise a block's HTML: strip its presentation-only tags and
 * attributes, then collapse whitespace outside `<pre>`/`<code>`, leaving fenced
 * and inline code content verbatim. */
function canonicalHtml(html: string): string {
  let out = "";
  let i = 0;
  let literal = 0;
  while (i < html.length) {
    if (html[i] === "<") {
      const end = html.indexOf(">", i);
      if (end === -1) break;
      const raw = html.slice(i, end + 1);
      const name = Tag.exec(raw)?.[2]?.toLowerCase();
      if (name === "pre" || name === "code") {
        if (raw.startsWith("</")) literal = Math.max(0, literal - 1);
        else if (!raw.endsWith("/>")) literal++;
      }
      out += canonicalTag(raw);
      i = end + 1;
    } else {
      const next = html.indexOf("<", i);
      const text = next === -1 ? html.slice(i) : html.slice(i, next);
      out += literal > 0 ? text : text.replace(/\s+/g, " ");
      i = next === -1 ? html.length : next;
    }
  }
  return out.trim();
}
