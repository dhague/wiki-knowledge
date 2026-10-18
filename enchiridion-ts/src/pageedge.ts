/**
 * Turning CLI-supplied frontmatter edge values into canonical markdown links.
 *
 * A value is one of exactly two things: exactly one markdown link (kept
 * byte-for-byte), or a vault-relative page ref composed here via
 * [composeEdgeLink] — shared with `ingest`, so both write paths name an edge
 * target the same way. Anything else is refused rather than written.
 */

import path from "node:path";
import { EdgeKeys, isSingleLinkEdgeKey } from "./pagerecord.js";
import { isVaultRelativeDest } from "./linkencoding.js";
import { composeLink, iterLinks } from "./wikipage.js";
import { fail, failBadInvocation } from "./output.js";

/** The [EdgeKeys] that hold a list of links, not a single one. */
const listEdgeKeys: string[] = EdgeKeys.filter(
  (key) => !isSingleLinkEdgeKey(key),
);

/** Whether key is a frontmatter edge key. */
export function isEdgeKey(key: string): boolean {
  return EdgeKeys.includes(key);
}

/** Whether key is an edge whose value is a list of links. */
export function isListEdgeKey(key: string): boolean {
  return listEdgeKeys.includes(key);
}

/** Whether value is exactly one markdown link and nothing else. Deliberately
 * stricter than the reader's [linkDest]: prose embedding a link, and an image,
 * are refused. */
function isWholeLink(value: string): boolean {
  const links = iterLinks(value);
  return (
    links.length === 1 &&
    links[0].fullStart === 0 &&
    links[0].fullEnd === value.length &&
    !links[0].isImage
  );
}

/** Resolve a vault-relative ref to existence and the title its link should
 * carry. Injected to keep this module pure and testable. */
export type RefLookup = (ref: string) => { exists: boolean; title: string };

/** Whether ref is shaped like a vault-relative ref, before any disk read:
 * rejects an absolute path, a URL, and a vault-climbing `..`. */
function isVaultRef(ref: string): boolean {
  if (!isVaultRelativeDest(ref)) return false;
  const normalized = path.posix.normalize(ref);
  return normalized !== ".." && !normalized.startsWith("../");
}

/** The refusal for a value that is not an edge value at all: naming key and
 * value, and the two shapes the schema accepts. Returns a string, not an
 * Error, so the CLI can route it through `fail`; [edgeLink] throws it. */
export function edgeRefusal(key: string, value: unknown): string {
  return `${key}: ${JSON.stringify(value)} is neither a markdown link nor a vault-relative page ref — write a link like [Title](path/to/page.md), or a ref under wiki/`;
}

/** The refusal for a value shaped like a ref whose target is absent: the two
 * are different faults, so a resolvable-looking typo is not told to fix its
 * spelling. Returns a string, per [edgeRefusal]. */
export function edgeTargetMissing(key: string, value: unknown): string {
  return `${key}: no page at ${JSON.stringify(value)} — refs are vault-relative (wiki/<kind-folder>/<file>.md); create the page first, or fix the ref`;
}

/** An edge link's label: the target's title, its basename when it has none,
 * and always the filename for `raw_source`. The one owner of the rule. */
export function edgeLabel(key: string, ref: string, title: string): string {
  return isSingleLinkEdgeKey(key) || title === ""
    ? path.posix.basename(ref)
    : title;
}

/** The canonical `[label](rel)` link for one edge target; relativisation and
 * percent-encoding are [composeLink]'s. Shared with `ingest`. */
export function composeEdgeLink(
  key: string,
  ref: string,
  pageDir: string,
  title: string,
): string {
  return composeLink(edgeLabel(key, ref, title), ref, pageDir);
}

/** The frontmatter link scalar for one CLI-supplied edge value: a whole link
 * returned unchanged, or a ref composed through [composeEdgeLink]. A value
 * that is neither shape is the caller's invocation at fault; a ref that names
 * no page is bad environment (ADR-0034). */
export function edgeLink(
  key: string,
  value: string,
  pageDir: string,
  lookup: RefLookup,
): string {
  if (isWholeLink(value)) return value;
  const ref = path.posix.normalize(value);
  if (!isVaultRef(value)) failBadInvocation(edgeRefusal(key, value));
  const found = lookup(ref);
  if (!found.exists) fail(edgeTargetMissing(key, value));
  return composeEdgeLink(key, ref, pageDir, found.title);
}
