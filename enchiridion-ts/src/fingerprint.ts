/**
 * The semantic fingerprint a Consolidation exclusion caches: a page's decoded
 * identity plus its body, hashed. Tags, `source_date`, `volatility`, YAML
 * formatting and field order are deliberately outside it, so an edit that
 * changes none of the meaning leaves a recorded exclusion valid.
 */

import { createHash } from "node:crypto";
import type { PageRecord } from "./pagerecord.js";

/** CRLF and lone CR both read as LF, so a checkout's line endings cannot
 * invalidate an exclusion. */
function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** The canonical text the digest is taken over: edges sorted by key, each
 * key's targets sorted and deduplicated, so neither field order nor list order
 * can change the fingerprint. */
export function fingerprintInput(record: PageRecord, body: string): string {
  const edges = record.edges
    .map((edge) => [edge.key, [...new Set(edge.targets)].sort()] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return JSON.stringify({
    title: record.title,
    summary: record.summary,
    edges,
    body: normalizeNewlines(body),
  });
}

/** `sha256:<hex>` over [fingerprintInput]. */
export function semanticFingerprint(record: PageRecord, body: string): string {
  const digest = createHash("sha256")
    .update(fingerprintInput(record, body), "utf8")
    .digest("hex");
  return `sha256:${digest}`;
}
