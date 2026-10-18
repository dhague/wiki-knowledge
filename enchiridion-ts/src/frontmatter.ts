/**
 * The page model and the one seam its frontmatter bytes are written through.
 * No I/O.
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
import { truncateSourceDate } from "./sourcedate.js";
import { iterLinks, rewriteText } from "./wikipage.js";
import type { LinkMatch } from "./wikipage.js";

/** A `---` fence on the very first line, closed by the next `---` line; `\r?`
 * accepts both LF and CRLF. */
const FRONTMATTER_RE = /^---[ \t]*\r?\n(.*?\n)?---[ \t]*(?:\r?\n|$)/s;

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

/** A YAML list item whose value begins with a bare `[`: YAML reads it as a flow
 * sequence, not the link string the schema wants. */
const UNQUOTED_LIST_LINK_RE = /^\s*-\s+\[/;

/** Report whether a frontmatter line is a bare markdown link in a YAML list
 * item — the shape [quoteUnquotedListLinks] repairs. */
export function isUnquotedListLinkLine(line: string): boolean {
  return UNQUOTED_LIST_LINK_RE.test(line);
}

/** Double-quote every bare markdown link in a YAML list item, so the block
 * parses and the link survives as the string the schema wants. Idempotent. */
function quoteUnquotedListLinks(frontmatter: string): string {
  return frontmatter
    .split("\n")
    .map((line) => {
      if (!UNQUOTED_LIST_LINK_RE.test(line)) return line;
      const open = line.indexOf("[");
      const close = line.lastIndexOf(")");
      if (open < 0 || close < 0) return line;
      return (
        line.slice(0, open) +
        `"${line.slice(open, close + 1)}"` +
        line.slice(close + 1)
      );
    })
    .join("\n");
}

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
    return frontmatterNodeFrom(frontmatter, hasFrontmatter);
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
   * — see [rewriteFrontmatter]. Mints a frontmatter block when the page has
   * none; only the block is re-serialised, and the body is spliced back
   * verbatim. A no-op set is not byte-identical (ADR-0012), but key order is
   * preserved.
   */
  set(key: string, value: unknown): Page {
    return new Page(
      rewriteFrontmatter(this.text, (frontmatter) => {
        frontmatter.set(key, value);
      }),
    );
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
 * [rewriteFrontmatter] is the one place frontmatter bytes are produced, so
 * applying the rules there is what makes them unskippable: whatever spelling a
 * `source_date` arrives in, the page that reaches disk carries the canonical
 * one, and a scalar handed to a list-valued key ([isStringListKey]) reaches
 * disk as the one-element list the conventions document.
 *
 * Tolerant, never refusing: a recognised non-canonical spelling truncates to
 * its date; anything that isn't a date at all, such as a hand-written "summer
 * 2026", passes through byte-unchanged. Refusing content is validation's
 * business — already had by the time a page reaches here.
 */
function canonicalForWrite(key: string, value: unknown): unknown {
  if (key === "source_date") return truncateSourceDate(value);
  // An absent value is not a scalar: `tags:` is the clean "no tags" spelling,
  // and wrapping its null would write the null entry `tags-shape` flags.
  if (isStringListKey(key) && value != null && !Array.isArray(value)) {
    return [value];
  }
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

function quoteLinks(node: Scalar | YAMLSeq | YAMLMap): void {
  if (node instanceof YAMLSeq) {
    for (const item of node.items) {
      if (
        item instanceof Scalar ||
        item instanceof YAMLSeq ||
        item instanceof YAMLMap
      ) {
        quoteLinks(item);
      }
    }
  } else if (node instanceof YAMLMap) {
    for (const pair of node.items) {
      const value = pair.value;
      if (
        value instanceof Scalar ||
        value instanceof YAMLSeq ||
        value instanceof YAMLMap
      ) {
        quoteLinks(value);
      }
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
 * `flowCollectionPadding: false` keeps `[a, b]` as written: the fixes rewrite a
 * whole block through here, and padding a flow collection they did not touch
 * would be churn (ADR-0012).
 *
 * A destination broken mid-token is a link no longer on one line, and every
 * raw-text reader has to be taught the shape. Readers keep that tolerance —
 * pages written before this change carry folds — but nothing new writes one.
 */
function renderFrontmatter(node: YAMLMap): string {
  return stringify(node, {
    indent: YAML_INDENT,
    lineWidth: 0,
    flowCollectionPadding: false,
  });
}

/** The block's mapping node, minted empty when the page has none. Throws on
 * YAML the parser refuses, or a block that is not a mapping. */
function frontmatterNodeFrom(
  frontmatter: string,
  hasFrontmatter: boolean,
): YAMLMap {
  if (!hasFrontmatter || frontmatter.trim() === "") return new YAMLMap();
  const doc = parseDocument(frontmatter);
  if (doc.errors.length > 0) {
    throw new Error(
      `invalid frontmatter YAML: ${doc.errors[0].message} — repair the block between the --- fences`,
    );
  }
  if (doc.contents === null) return new YAMLMap();
  if (!isMap(doc.contents))
    throw new Error(
      "frontmatter is not a YAML mapping — the block between the --- fences must be YAML key: value pairs",
    );
  return doc.contents;
}

/**
 * Run every value in the block through [canonicalForWrite], replacing only the
 * pairs a rule actually changes — a key the rules leave alone keeps its scalar
 * style. The write-side half of making the rules unskippable.
 */
function canonicaliseForWrite(node: YAMLMap): void {
  for (const pair of node.items) {
    const key = String((pair.key as Scalar).value);
    const value = pair.value as Scalar | YAMLSeq | null;
    const decoded = value === null ? null : value.toJSON();
    const canonical = canonicalForWrite(key, decoded);
    if (!isDeepStrictEqual(canonical, decoded)) {
      pair.value = newValueNode(canonical);
    }
  }
}

/**
 * The write view of one frontmatter block. [set] runs a value through the
 * writer's canonicalisation and link quoting, so an edit never encodes a YAML
 * node itself or hand-quotes a link; [get] and [keys] read the decoded block.
 */
export class FrontmatterWriter {
  constructor(private readonly node: YAMLMap) {}

  /** The block's keys, in source order. */
  keys(): string[] {
    return this.node.items.map((pair) => String((pair.key as Scalar).value));
  }

  /** The decoded value of key, or undefined when the key is absent. */
  get(key: string): unknown {
    for (const pair of this.node.items) {
      if ((pair.key as Scalar).value !== key) continue;
      const value = pair.value as Scalar | YAMLSeq | null;
      return value === null ? null : value.toJSON();
    }
    return undefined;
  }

  /** Set key to value, canonicalised ([canonicalForWrite]) and link-quoted. */
  set(key: string, value: unknown): void {
    setKey(this.node, key, newValueNode(canonicalForWrite(key, value)));
  }
}

/**
 * The one path a page's frontmatter bytes are written through — [Page.set] and
 * every `check` auto-fix. `edit` rewrites the parsed block through
 * [FrontmatterWriter]; every value is then run through [canonicalForWrite] and
 * [quoteLinks], the block is re-serialised unfolded (ADR-0024) and spliced back
 * onto the body verbatim. A string returned from `edit` replaces the body; a
 * page with no block mints one only when a value is written.
 */
export function rewriteFrontmatter(
  text: string,
  edit: (frontmatter: FrontmatterWriter) => string | void,
): string {
  const { frontmatter, hasFrontmatter, body } = splitFrontmatter(text);
  const node = frontmatterNodeFrom(
    quoteUnquotedListLinks(frontmatter),
    hasFrontmatter,
  );
  const rewrittenBody = edit(new FrontmatterWriter(node));
  const newBody = typeof rewrittenBody === "string" ? rewrittenBody : body;
  canonicaliseForWrite(node);
  quoteLinks(node);
  if (!hasFrontmatter && node.items.length === 0) return newBody;
  const rendered = node.items.length === 0 ? "" : renderFrontmatter(node);
  return "---\n" + rendered + "---\n" + newBody;
}
