/**
 * The markdown link seam — scanning text for links and splicing destinations by
 * source offset, so untouched bytes survive and a fold the scanner sees is
 * spliced whole (ADR-0024). No I/O.
 */

import path from "node:path";
import MarkdownIt from "markdown-it";
import { encodeDest, isVaultRelativeDest, splitDest } from "./linkencoding.js";

/** A YAML escaped line break: a trailing `\` joining the next line, with the
 * break and next line's indent dropped. The match spans the raw fold, so a
 * destination splice replaces it wholesale; whitespace *before* the `\` is
 * content, not fold. Readers still resolve one because pages written before
 * ADR-0024 carry them. A plain line break is deliberately not a fold. */
const ESCAPED_LINE_BREAK_RE = /\\\r?\n[ \t]*/g;

/** The destination a conforming YAML reader sees. */
function joinEscapedLineBreaks(dest: string): string {
  return dest.replace(ESCAPED_LINE_BREAK_RE, "");
}

/** One destination character, or an escaped line break standing in for it. */
const DEST_ATOM = `(?:[^()\\s]|${ESCAPED_LINE_BREAK_RE.source})`;

/** An unbracketed destination: per CommonMark it ends at the first *unbalanced*
 * `)`. JS regexes have no recursion, so nesting is bounded at `depth`. */
function nestedParenDest(depth: number): string {
  let frag = `${DEST_ATOM}*`;
  for (let i = 0; i < depth; i++) {
    frag = `(?:${DEST_ATOM}|\\(${frag}\\))*`;
  }
  return frag;
}

/** An angle-bracketed destination, folded across lines the same way. */
const ANGLE_DEST = `<[^<>\\n]*(?:${ESCAPED_LINE_BREAK_RE.source}[^<>\\n]*)*>`;

/**
 * A markdown inline link or image: `[label](dest …)` / `![label](dest …)`.
 * Label tolerates one bracket level; dest is `<…>` or a whitespace-free run
 * with balanced parens; an optional title is matched but excluded.
 *
 * One scanner covers frontmatter and body. An escaped line break may fall
 * inside the destination or at the label/destination boundary, the latter
 * captured separately (group 3) so the split check can splice it. The `d` flag
 * exposes source offsets.
 */
const LINK_RE = new RegExp(
  `(!?)\\[((?:[^\\[\\]]|\\[[^\\[\\]]*\\])*)\\]` +
    `((?:${ESCAPED_LINE_BREAK_RE.source})*)` +
    `\\([ \\t]*` +
    `(${ANGLE_DEST}|${nestedParenDest(4)})` +
    `(?:[ \\t]+(?:"[^"]*"|'[^']*'|\\([^)]*\\)))?` +
    `[ \\t]*\\)`,
  "gd",
);

/** One link/image occurrence, positioned in the source text. */
export interface LinkMatch {
  /** Raw source offsets bracketing the destination; for a folded destination
   * these span the whole raw fold, not [dest]. */
  start: number;
  end: number;
  /** the encoded destination (angle brackets, any title and any fold excluded) */
  dest: string;
  /** splitDest(dest).path — decoded, anchor-free */
  decodedPath: string;
  /** splitDest(dest).anchor — decoded, "" if no anchor */
  decodedAnchor: string;
  isImage: boolean;
  /** 0-based line the link's opening `[` (or `!`) falls on */
  line: number;
  /** start of the full `[label](dest)` / `![label](dest)` expression */
  fullStart: number;
  /** end of the full `[label](dest)` / `![label](dest)` expression */
  fullEnd: number;
  /** the link label text (the content between `[` and `]`) */
  label: string;
  /** Raw source offsets of the YAML escaped line break run between the label's
   * `]` and the destination's `(`, or null when they are adjacent. A reader
   * joins the run with nothing, so a splice replaces the span with "". */
  labelDestFold: { start: number; end: number } | null;
}

const md = new MarkdownIt();

/**
 * The 0-based line indices inside fenced and indented code blocks, counted
 * from the start of src — not from the page: [iterLinks] hands this the whole
 * document, while `check split-links` hands it the body and rebases the line it
 * reports.
 *
 * Exported for the readers' sake rather than this module's: `check split-links`
 * has to skip exactly what [iterLinks] skips.
 */
export function codeLineRanges(src: string): Set<number> {
  const lines = new Set<number>();
  const tokens = md.parse(src, {});
  for (const token of tokens) {
    if (token.type !== "fence" && token.type !== "code_block") continue;
    const map = token.map;
    if (!map) continue;
    for (let line = map[0]; line < map[1]; line++) lines.add(line);
  }
  return lines;
}

function lineOf(src: string, offset: number): number {
  if (offset > src.length) offset = src.length;
  let count = 0;
  for (let i = 0; i < offset; i++) {
    if (src[i] === "\n") count++;
  }
  return count;
}

/**
 * Return a [LinkMatch] for every link/image in src, in order, with absolute
 * offsets. Occurrences inside fenced/indented code blocks are skipped.
 *
 * Scans the *whole* document, frontmatter included, so typed edges,
 * `supersedes` and `raw_source` are found by the same rule as body links.
 */
export function iterLinks(src: string): LinkMatch[] {
  const codeLines = codeLineRanges(src);
  const out: LinkMatch[] = [];
  for (const m of src.matchAll(LINK_RE)) {
    const idx = m.indices![4];
    let start = idx[0];
    let end = idx[1];
    let dest = joinEscapedLineBreaks(m[4]!);
    // Unwrap an angle-bracketed destination: `<path>` -> `path`.
    if (dest.startsWith("<") && dest.endsWith(">")) {
      start += 1;
      end -= 1;
      dest = dest.slice(1, -1);
    }
    // Anchored on the opening bracket, not the destination: a boundary fold
    // puts the destination a line later, and the line-keyed readers mean the
    // line the link begins on.
    const fullStart = m.index!;
    const line = lineOf(src, fullStart);
    if (codeLines.has(line)) continue;
    const { path: decodedPath, anchor: decodedAnchor } = splitDest(dest);
    const foldIdx = m.indices![3];
    out.push({
      start,
      end,
      dest,
      decodedPath,
      decodedAnchor,
      isImage: m[1] === "!",
      line,
      fullStart,
      fullEnd: fullStart + m[0]!.length,
      label: m[2]!,
      labelDestFold:
        foldIdx[0] === foldIdx[1]
          ? null
          : { start: foldIdx[0], end: foldIdx[1] },
    });
  }
  return out;
}

/** Resolve an already-decoded destination against pageDir, the vault-relative
 * directory the link lives in, so the result is vault-relative (ADR-0009). */
export function resolveLinkDest(dest: string, pageDir: string): string {
  const base = pageDir === "" ? "." : pageDir;
  return path.posix.normalize(path.posix.join(base, dest));
}

/** The decoded destination of a whole markdown-link scalar (not a bare
 * destination); ok is false when link isn't a markdown link at all. */
export function linkDest(link: string): { dest: string; ok: boolean } {
  const matches = iterLinks(link);
  if (matches.length === 0) return { dest: "", ok: false };
  return { dest: matches[0].decodedPath, ok: true };
}

/**
 * Compose a markdown link to targetRel from a page in pageDir; both are
 * vault-relative and pageDir may be "". Relativises the target and
 * percent-encodes the destination, never the label. YAML quoting is not done
 * here: the page model's [Page.set]/[Page.merge] already double-quote a fresh
 * `[…]` scalar.
 */
export function composeLink(
  title: string,
  targetRel: string,
  pageDir: string,
): string {
  const dest = relPath(path.posix.normalize(targetRel), pageDir);
  return `[${title}](${encodeDest(dest, "")})`;
}

/**
 * Re-encode every relative link/image destination in src, via the same
 * offset-based splice the page model's [Page.retarget] uses so untouched bytes
 * survive. Idempotent. Absolute paths, scheme-qualified URLs, and bare anchors
 * are left alone.
 */
export function normalizeBodyLinks(src: string): string {
  const edits: Edit[] = [];
  for (const link of iterLinks(src)) {
    if (!isVaultRelativeDest(link.decodedPath)) continue;
    const dest = encodeDest(link.decodedPath, link.decodedAnchor);
    if (dest !== link.dest)
      edits.push({ start: link.start, end: link.end, dest });
  }
  return applyEdits(src, edits);
}

/** One destination splice: replace src[start:end] with dest. */
export interface Edit {
  start: number;
  end: number;
  dest: string;
}

/** Splice edits into src back-to-front by source offset, so every untouched
 * byte survives and earlier offsets stay valid. */
export function applyEdits(src: string, edits: Edit[]): string {
  edits.sort((a, b) => b.start - a.start);
  for (const e of edits) {
    src = src.slice(0, e.start) + e.dest + src.slice(e.end);
  }
  return src;
}

/** Return text with its links fixed for the move oldRel -> newRel. */
export function rewriteText(
  text: string,
  fileRel: string,
  oldRel: string,
  newRel: string,
): string {
  const isMovedFile = fileRel === oldRel;
  const oldDir = path.posix.dirname(fileRel);
  let newDir = path.posix.dirname(fileRel);
  if (isMovedFile) newDir = path.posix.dirname(newRel);

  const edits: Edit[] = [];
  for (const link of iterLinks(text)) {
    if (!isVaultRelativeDest(link.decodedPath)) continue;
    // Where this link pointed, resolved from the file's original location.
    const target = resolveLinkDest(link.decodedPath, oldDir);
    // For pages other than the moved one, only links at the moved page change.
    if (!isMovedFile && target !== oldRel) continue;
    // The moved page relocates the target of a self-link.
    const movedTarget = target === oldRel ? newRel : target;
    const dest = encodeDest(relPath(movedTarget, newDir), link.decodedAnchor);
    if (dest !== link.dest)
      edits.push({ start: link.start, end: link.end, dest });
  }
  return applyEdits(text, edits);
}

/**
 * relPath is posixpath.relpath over two vault-relative slash paths: the route
 * from base to target, spelled with `../` segments.
 */
function relPath(target: string, base: string): string {
  const targetParts = pathParts(target);
  const baseParts = pathParts(base);

  let common = 0;
  while (
    common < targetParts.length &&
    common < baseParts.length &&
    targetParts[common] === baseParts[common]
  ) {
    common++;
  }

  const parts: string[] = [];
  for (let i = common; i < baseParts.length; i++) parts.push("..");
  parts.push(...targetParts.slice(common));
  if (parts.length === 0) return ".";
  return parts.join("/");
}

function pathParts(p: string): string[] {
  const cleaned = path.posix.normalize(p);
  if (cleaned === "." || cleaned === "") return [];
  return cleaned.split("/");
}
