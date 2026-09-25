/**
 * The pure half of the vault library — frontmatter splitting, markdown-link
 * machinery, and the mutating page model. No I/O.
 *
 * Byte-preservation: link rewriting splices raw text by source offset and never
 * stringifies, so every untouched byte survives. A no-op [Page.set] is not
 * byte-identical (ADR-0012), but key order is preserved.
 *
 * Encoding decodes at a single boundary: [splitDest] splits on the literal `#`
 * before decoding, so an encoded `#` in a filename is never read as an anchor.
 */

import {
  parseDocument,
  stringify,
  Scalar,
  YAMLSeq,
  YAMLMap,
  isMap,
} from "yaml";
import { isDeepStrictEqual } from "node:util";
import path from "node:path";
import MarkdownIt from "markdown-it";
import { truncateSourceDate } from "./sourcedate.js";

// ---------------------------------------------------------------------------
// Link machinery
// ---------------------------------------------------------------------------

/** The minimal charset that makes a raw/ filename linkable. */
const ENCODE_CHARS = " #%()<>";

/** A `---` fence on the very first line, closed by the next `---` line; `\r?`
 * accepts both LF and CRLF. */
const FRONTMATTER_RE = /^---[ \t]*\r?\n(.*?\n)?---[ \t]*(?:\r?\n|$)/s;

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

/** Percent-encode [ENCODE_CHARS] in path; all else stays literal. */
export function percentEncode(p: string): string {
  let out = "";
  for (const ch of p) {
    if (ch < "\x80" && ENCODE_CHARS.includes(ch)) {
      out += "%" + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0");
      continue;
    }
    out += ch;
  }
  return out;
}

/** Reverse [percentEncode]. An invalid or truncated escape is left verbatim. */
export function percentDecode(p: string): string {
  let out = "";
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === "%" && i + 2 < p.length) {
      const hex = p.slice(i + 1, i + 3);
      if (/^[0-9a-fA-F]{2}$/.test(hex)) {
        out += String.fromCharCode(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

/**
 * Split an encoded link destination into its decoded path and decoded anchor.
 *
 * Split on the literal `#` first, decode each half after: decoding up front
 * would turn an encoded `#` in a filename (`%23`) into a false anchor separator.
 */
export function splitDest(dest: string): { path: string; anchor: string } {
  const hash = dest.indexOf("#");
  const encodedPath = hash === -1 ? dest : dest.slice(0, hash);
  const encodedAnchor = hash === -1 ? "" : dest.slice(hash + 1);
  return {
    path: percentDecode(encodedPath),
    anchor: hash === -1 ? "" : percentDecode(encodedAnchor),
  };
}

/**
 * Split a leading YAML frontmatter block off text.
 *
 * `text.slice(bodyOffset) == body` always holds; with no block, body is text
 * unchanged and bodyOffset is 0.
 */
export function splitFrontmatter(src: string): {
  frontmatter: string;
  body: string;
  bodyOffset: number;
  hasFrontmatter: boolean;
} {
  const m = FRONTMATTER_RE.exec(src);
  if (!m) {
    return { frontmatter: "", body: src, bodyOffset: 0, hasFrontmatter: false };
  }
  const frontmatter = m[1] !== undefined ? m[1] : "";
  const bodyOffset = m[0].length;
  return {
    frontmatter,
    body: src.slice(bodyOffset),
    bodyOffset,
    hasFrontmatter: true,
  };
}

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
 * Return the set of 0-based line indices that fall inside code blocks.
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

// ---------------------------------------------------------------------------
// Page model
// ---------------------------------------------------------------------------

const YAML_INDENT = 2;

/** Frontmatter keys whose value is a list of strings — `tags` is the schema's
 * one such non-edge key. A *scalar* for one is a shape the record reader reads
 * as no value at all, so [canonicalForWrite] wraps it in a one-element list. */
const StringListKeys: readonly string[] = ["tags"];

/** Report whether key's frontmatter value is a list of strings rather than a
 * scalar, so a caller need not respell `tags`. */
export function isStringListKey(key: string): boolean {
  return StringListKeys.includes(key);
}

/**
 * One page's frontmatter plus body. Pure-functional — no I/O, no mutation:
 * [Page.set], [Page.merge] and [Page.retarget] each return a *new* Page.
 */
export class Page {
  constructor(readonly text: string) {}

  /**
   * Return p's frontmatter as a YAML mapping node, minting an empty one when
   * the page has no frontmatter block. A node rather than a map because a
   * mapping node preserves key order.
   */
  private frontmatterNode(): YAMLMap {
    const { frontmatter, hasFrontmatter } = splitFrontmatter(this.text);
    if (!hasFrontmatter || frontmatter.trim() === "") return new YAMLMap();
    const doc = parseDocument(frontmatter);
    if (doc.errors.length > 0) {
      throw new Error(`invalid frontmatter YAML: ${doc.errors[0].message}`);
    }
    if (doc.contents === null || !isMap(doc.contents)) {
      if (doc.contents === null) return new YAMLMap();
      throw new Error("frontmatter is not a YAML mapping");
    }
    return doc.contents;
  }

  /** Return the full frontmatter mapping, decoded to plain values, or null
   * when this page has no frontmatter block. */
  frontmatter(): Record<string, unknown> | null {
    const { hasFrontmatter } = splitFrontmatter(this.text);
    if (!hasFrontmatter) return null;
    return this.frontmatterNode().toJSON() as Record<string, unknown>;
  }

  /** Return the value of key in this page's frontmatter; ok is false when the
   * page has no frontmatter or the key is absent. */
  get(key: string): { value: unknown; ok: boolean } {
    const data = this.frontmatter();
    if (data === null) return { value: undefined, ok: false };
    if (!(key in data)) return { value: undefined, ok: false };
    return { value: data[key], ok: true };
  }

  /** Return a string-valued frontmatter key, or "" when it is absent, null,
   * or not a string. */
  getString(key: string): string {
    const { value } = this.get(key);
    return typeof value === "string" ? value : "";
  }

  /** Return a list-valued frontmatter key's string entries; absent, null, or
   * not a list yields [], and non-string entries are skipped. */
  getStringList(key: string): string[] {
    const { value } = this.get(key);
    if (!Array.isArray(value)) return [];
    return value.filter((v): v is string => typeof v === "string");
  }

  /**
   * Return a new page with frontmatter key set to value, canonicalised first
   * — see [canonicalForWrite]. Mints a frontmatter block when the page has
   * none; only the block is re-serialised, and the body is spliced back
   * verbatim.
   */
  set(key: string, value: unknown): Page {
    const node = this.frontmatterNode();
    const valueNode = newValueNode(canonicalForWrite(key, value));
    setKey(node, key, valueNode);
    const rendered = renderFrontmatter(node);
    const { body } = splitFrontmatter(this.text);
    return new Page("---\n" + rendered + "---\n" + body);
  }

  /**
   * Return a new page with values unioned into key's existing list. Existing
   * entries hold their position, new ones append, duplicates drop; equivalent
   * to [Page.set] when key is absent.
   */
  merge(key: string, values: unknown[]): Page {
    const existing = this.get(key).value;
    const merged: unknown[] = [];
    if (Array.isArray(existing)) merged.push(...existing);
    for (const value of values) {
      if (!containsValue(merged, value)) merged.push(value);
    }
    return this.set(key, merged);
  }

  /** [Page.merge] over a string list. */
  mergeStrings(key: string, values: string[]): Page {
    return this.merge(key, values);
  }

  /** Return the document body — everything after the frontmatter block. */
  body(): string {
    return splitFrontmatter(this.text).body;
  }

  /** Return every link/image in this page, body and frontmatter alike. */
  links(): LinkMatch[] {
    return iterLinks(this.text);
  }

  /**
   * Return a new page with links fixed for the vault-wide move oldRel ->
   * newRel. fileRel is where *this* page sits before the move; pass
   * fileRel == oldRel for the page being moved, so its own outbound links
   * rebase too.
   */
  retarget(fileRel: string, oldRel: string, newRel: string): Page {
    return new Page(rewriteText(this.text, fileRel, oldRel, newRel));
  }
}

/**
 * Compute the post-move vault from pages (a {pageRef: text} map). Pure: the
 * moved page appears under newRel, every other page keeps its key, and inbound
 * and outbound links are both fixed.
 *
 * oldRel need not be a key of pages: a caller retargeting links at a non-page
 * file (a `raw/` artifact) passes only the pages whose *inbound* links should
 * follow the rename.
 */
export function planMove(
  pages: Record<string, string>,
  oldRel: string,
  newRel: string,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [rel, text] of Object.entries(pages)) {
    const key = rel === oldRel ? newRel : rel;
    out[key] = new Page(text).retarget(rel, oldRel, newRel).text;
  }
  return out;
}

/**
 * [planMove]'s sibling for consolidation: every link to a consolidated page is
 * repointed at `survivor`, and the consolidated pages are dropped. The
 * survivor's text is whatever the caller placed at `survivor` in `pages` —
 * including a freshly authored one. Moves links and nothing else, the link half
 * of a Consolidation being lossless (ADR-0021).
 */
export function planConsolidate(
  pages: Record<string, string>,
  losers: string[],
  survivor: string,
): Record<string, string> {
  const dropped = new Set(losers);
  const out: Record<string, string> = {};
  for (const [rel, text] of Object.entries(pages)) {
    if (dropped.has(rel)) continue;
    // One pass per consolidated page, so the mapping composes as repeated
    // [rewriteText] calls do.
    let next = text;
    for (const loser of losers) {
      next = new Page(next).retarget(rel, loser, survivor).text;
    }
    out[rel] = next;
  }
  return out;
}

/**
 * Return text with every vault-relative link/image destination replaced by the
 * vault-relative page it resolves to from pageDir (ADR-0009) — the document
 * read as *where it points* rather than how each destination is spelled.
 *
 * A comparison helper, not a writer: nothing here percent-encodes and the
 * result never reaches disk. Two spellings of the same link come out identical,
 * which is what lets a Consolidation's losslessness check (ADR-0021) compare an
 * absorbed body against that same body inside the survivor.
 *
 * `target` maps a resolved vault-relative ref to the ref a reader should treat
 * it as. Destinations that aren't vault-relative — URLs, absolute paths, bare
 * anchors — are left byte-identical.
 */
export function canonicalizeLinkTargets(
  text: string,
  pageDir: string,
  target: (ref: string) => string = (ref) => ref,
): string {
  const edits: Edit[] = [];
  for (const link of iterLinks(text)) {
    if (!isVaultRelativeDest(link.decodedPath)) continue;
    const resolved = target(resolveLinkDest(link.decodedPath, pageDir));
    const dest =
      link.decodedAnchor === ""
        ? resolved
        : `${resolved}#${link.decodedAnchor}`;
    if (dest !== link.dest)
      edits.push({ start: link.start, end: link.end, dest });
  }
  return applyEdits(text, edits);
}

/**
 * Compose a markdown link to targetRel from a page in pageDir; both are
 * vault-relative and pageDir may be "". Relativises the target and
 * percent-encodes the destination, never the label. YAML quoting is not done
 * here: [Page.set]/[Page.merge] already double-quote a fresh `[…]` scalar.
 */
export function composeLink(
  title: string,
  targetRel: string,
  pageDir: string,
): string {
  const dest = relPath(path.posix.normalize(targetRel), pageDir);
  return `[${title}](${percentEncode(dest)})`;
}

/**
 * Re-encode every relative link/image destination in src, via the same
 * offset-based splice [Page.retarget] uses so untouched bytes survive.
 * Idempotent. Absolute paths, scheme-qualified URLs, and bare anchors are left
 * alone.
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
interface Edit {
  start: number;
  end: number;
  dest: string;
}

/** Splice edits into src back-to-front by source offset, so every untouched
 * byte survives and earlier offsets stay valid. */
function applyEdits(src: string, edits: Edit[]): string {
  edits.sort((a, b) => b.start - a.start);
  for (const e of edits) {
    src = src.slice(0, e.start) + e.dest + src.slice(e.end);
  }
  return src;
}

/**
 * Re-encode a decoded path and anchor back into a link destination — the
 * inverse of [splitDest]. The `#` introducing an anchor stays literal; only a
 * `#` in the *path* — a filename's own hash, decoded from `%23` — becomes
 * `%23`. Encoding the recombined string instead would turn `#ttl` into
 * `%23ttl`, a heading link into a dangling filename.
 */
export function encodeDest(p: string, anchor: string): string {
  let dest = percentEncode(p);
  if (anchor !== "") dest += "#" + percentEncode(anchor);
  return dest;
}

/**
 * A URI scheme at the start of a destination (`https:`, `mailto:`, `data:`).
 *
 * What makes such a destination absolute is the scheme, not the `//` — a scheme
 * with no authority to name carries none: `mailto:x@y.z` is as absolute as
 * `https://example.com`.
 */
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** Report whether dest begins with a URI scheme. */
function hasScheme(dest: string): boolean {
  return SCHEME_RE.test(dest);
}

/**
 * Report whether path (the pre-anchor part of a decoded destination) is a
 * vault-relative reference — the only destinations [Page.retarget] rewrites
 * and [normalizeBodyLinks] re-encodes.
 *
 * Not one: the empty destination, an absolute path (`/…`), anything carrying
 * `://` (this test must come *before* the `.md` one, or `https://…/x.md` would
 * read as a page link), and a URI with a scheme. The `.md` test comes before
 * the scheme test, so a page whose filename carries a colon (`C:notes.md`) is
 * still a page link.
 *
 * A bare anchor needs no test: [splitDest] already stripped it, so
 * `#a-section` arrives here as "". A path can still *begin* with `#` — a file
 * whose own name starts with one — and that is a page link, so a `#` test here
 * would be wrong rather than redundant.
 */
export function isVaultRelativeDest(p: string): boolean {
  if (p === "" || p.startsWith("/") || p.includes("://")) return false;
  if (p.endsWith(".md")) return true;
  return !hasScheme(p);
}

/** Return text with its links fixed for the move oldRel -> newRel. */
function rewriteText(
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

// ---------------------------------------------------------------------------
// Frontmatter YAML (eemeli/yaml AST model — preserves key order)
// ---------------------------------------------------------------------------

/** Return whether values already holds value, via structural comparison. */
function containsValue(values: unknown[], value: unknown): boolean {
  return values.some((existing) => isDeepStrictEqual(existing, value));
}

/** Replace key's value in the mapping, or append the pair when key is absent —
 * so existing keys keep their position and new keys land at the end. */
function setKey(mapping: YAMLMap, key: string, value: Scalar | YAMLSeq): void {
  for (const pair of mapping.items) {
    if ((pair.key as Scalar).value === key) {
      pair.value = value;
      return;
    }
  }
  mapping.add({ key, value });
}

/**
 * Canonicalise a frontmatter value on its way to disk — the writer's half of
 * the source-date and of the list-valued-key rules.
 *
 * [Page.set] is the one place frontmatter bytes are produced, so applying the
 * rules here is what makes them unskippable: whatever spelling a `source_date`
 * arrives in, the page that reaches disk carries the canonical one, and a
 * scalar handed to a list-valued key ([isStringListKey]) reaches disk as the
 * one-element list the conventions document.
 *
 * Tolerant, never refusing: a recognised non-canonical spelling truncates to
 * its date; anything that isn't a date at all, such as a hand-written "summer
 * 2026", passes through byte-unchanged. Refusing content is validation's
 * business — already had by the time a page reaches here.
 */
function canonicalForWrite(key: string, value: unknown): unknown {
  if (key === "source_date") return truncateSourceDate(value);
  if (isStringListKey(key) && !Array.isArray(value)) return [value];
  return value;
}

/**
 * Encode a plain value to a YAML node, double-quoting any fresh markdown-link
 * scalar — only strings starting `[`. Image embeds (`![…]`) never appear in
 * frontmatter.
 */
function newValueNode(value: unknown): Scalar | YAMLSeq {
  const node = toYamlNode(value);
  quoteLinks(node);
  return node;
}

function toYamlNode(value: unknown): Scalar | YAMLSeq {
  if (Array.isArray(value)) {
    const seq = new YAMLSeq();
    for (const item of value) seq.add(toYamlNode(item));
    return seq;
  }
  return new Scalar(value);
}

function quoteLinks(node: Scalar | YAMLSeq): void {
  if (node instanceof YAMLSeq) {
    for (const item of node.items) {
      if (item instanceof Scalar || item instanceof YAMLSeq) quoteLinks(item);
    }
  } else if (node instanceof Scalar) {
    if (typeof node.value === "string" && node.value.startsWith("[")) {
      node.type = "QUOTE_DOUBLE";
    }
  }
}

/**
 * Render the frontmatter mapping back to YAML, folding nothing.
 *
 * `lineWidth: 0` disables the emitter's folding outright, so a link scalar
 * stays on one line however long its destination is
 * (`docs/adr/0024-emitted-lines-are-not-folded.md`).
 *
 * A destination broken mid-token is a link no longer on one line, and every
 * raw-text reader has to be taught the shape. Readers keep that tolerance —
 * pages written before this change carry folds — but nothing new writes one.
 */
function renderFrontmatter(node: YAMLMap): string {
  return stringify(node, { indent: YAML_INDENT, lineWidth: 0 });
}
