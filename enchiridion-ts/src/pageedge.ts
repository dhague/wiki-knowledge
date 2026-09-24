/**
 * Turning CLI-supplied frontmatter edge values into canonical markdown links.
 *
 * `page set`/`page merge` take a **file path** and a value, and they used to
 * write that value verbatim. `ingest` does not: an `IngestPlan` names edge
 * targets by vault-relative page ref and composes the `[Title](../dest.md)`
 * link itself (see `ingest.ts`'s module comment). An agent that reused the
 * plan's documented ref shape on `page merge` therefore wrote malformed
 * frontmatter with no warning (#548), which then broke the page's
 * indexability and aborted `check`.
 *
 * This module owns the **value-shape** rule that closes the asymmetry (a
 * link or a ref, nothing else), and shares the **composition** rule with
 * `ingest` through [composeEdgeLink], so a page's edges read the same
 * whichever path wrote them. A value is one of exactly two things:
 *
 *   - exactly one markdown link — kept byte-for-byte, so a caller that *did*
 *     compose the link (or a retype carrying an anchor) is untouched; or
 *   - a vault-relative page ref — composed here, exactly as `ingest` does:
 *     the target's title as the label, `../` relativisation from the page's
 *     own directory, percent-encoded destination.
 *
 * Anything else is refused rather than written: a value that is neither is the
 * silent corruption this ticket is about, and a ref that names no file is the
 * same corruption one step later. The message names the offending key and
 * value, because the caller is usually a person reading stderr.
 */

import path from "node:path";
import { EdgeKeys, isSingleLinkEdgeKey } from "./pagerecord.js";
import { composeLink, isVaultRelativeDest, iterLinks } from "./wikipage.js";

/** The [EdgeKeys] whose frontmatter value is a list of links — every edge key
 * but the single-link ones [isSingleLinkEdgeKey] names. */
const listEdgeKeys: string[] = EdgeKeys.filter(
  (key) => !isSingleLinkEdgeKey(key),
);

/** Report whether key names a frontmatter edge — a key whose value is a
 * markdown link rather than free text. */
export function isEdgeKey(key: string): boolean {
  return EdgeKeys.includes(key);
}

/** Report whether key names an edge whose value is a *list* of links. */
export function isListEdgeKey(key: string): boolean {
  return listEdgeKeys.includes(key);
}

/** Report whether value is exactly one markdown link, with nothing around it.
 *
 * Deliberately stricter than [linkDest], which finds a destination *anywhere*
 * in a scalar (the reader's job — it must still resolve a value a lenient
 * writer once produced). A writer must not accept `see [Foo](foo.md) here` as
 * an edge: it is prose, and writing it verbatim is the silent corruption
 * #548 is about. An image is not a link either, so `![…](…)` is refused. */
function isWholeLink(value: string): boolean {
  const links = iterLinks(value);
  return (
    links.length === 1 &&
    links[0].fullStart === 0 &&
    links[0].fullEnd === value.length &&
    !links[0].isImage
  );
}

/** Resolve a vault-relative ref to whether a file sits there and the title a
 * link to it should carry. Injected so this module stays pure and testable. */
export type RefLookup = (ref: string) => { exists: boolean; title: string };

/** Report whether ref is shaped like a vault-relative reference at all —
 * before anything is read from disk. Rejects an absolute path, a URL, and a
 * `..` that would climb out of the vault. */
function isVaultRef(ref: string): boolean {
  if (!isVaultRelativeDest(ref)) return false;
  const normalized = path.posix.normalize(ref);
  return normalized !== ".." && !normalized.startsWith("../");
}

/** The one refusal message, naming key and value: a caller reads stderr, and
 * an agent that misused the plan's ref shape needs both to correct itself.
 * A message rather than an Error so the CLI can route it through `fail`, the
 * documented failure funnel, while [edgeLink] throws it as an [Error]. */
export function edgeRefusal(key: string, value: unknown): string {
  return `${key}: ${JSON.stringify(value)} is neither a markdown link nor a resolvable vault-relative page ref`;
}

/** The label an edge's link carries: the target's title, the basename when
 * the target has none, and always the artifact's filename for `raw_source`,
 * whose label is never a title. The one owner of the label rule — `ingest`
 * composes plan edges through [composeEdgeLink] too. */
export function edgeLabel(key: string, ref: string, title: string): string {
  return key === "raw_source" || title === ""
    ? path.posix.basename(ref)
    : title;
}

/** Compose the canonical `[label](rel)` link for one edge target from its
 * already-resolved title (see [edgeLabel]); relativisation and
 * percent-encoding are [composeLink]'s. Shared with `ingest`, so a plan edge
 * and a `page` edge name the same target the same way. */
export function composeEdgeLink(
  key: string,
  ref: string,
  pageDir: string,
  title: string,
): string {
  return composeLink(edgeLabel(key, ref, title), ref, pageDir);
}

/**
 * Return the frontmatter link scalar for one CLI-supplied edge value.
 *
 * value is either exactly one markdown link (returned unchanged) or a
 * vault-relative page ref, which is composed through [composeEdgeLink] from
 * lookup's title. pageDir is the vault-relative directory of the page being
 * edited.
 *
 * Throws when value is neither, naming key and value. The caller has already
 * read the page, so a failure here leaves it unedited.
 */
export function edgeLink(
  key: string,
  value: string,
  pageDir: string,
  lookup: RefLookup,
): string {
  if (isWholeLink(value)) return value;
  const ref = path.posix.normalize(value);
  if (!isVaultRef(value)) throw new Error(edgeRefusal(key, value));
  const found = lookup(ref);
  if (!found.exists) throw new Error(edgeRefusal(key, value));
  return composeEdgeLink(key, ref, pageDir, found.title);
}
