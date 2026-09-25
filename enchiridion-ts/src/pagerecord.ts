/**
 * The one reader of the frontmatter schema: frontmatter text in, one typed
 * record out, so the schema changes in exactly one place. Canonicalising a
 * value on the way to disk is `wikipage.ts`'s job, not this module's.
 *
 * Paths are vault-relative (ADR-0009); kind is derived from the page's folder
 * (ADR-0008); SupersededBy is inverted from every other page's `supersedes`
 * edge, never read from frontmatter.
 */

import path from "node:path";
import { parse as parseYaml } from "yaml";
import { linkDest, resolveLinkDest, splitFrontmatter } from "./wikipage.js";
import { FolderKinds, folderToKind } from "./place.js";
import { parseSourceDate } from "./sourcedate.js";

/** Frontmatter keys holding markdown links to other pages, in conventions-spec
 * order. `raw_source` is a single link; every other key is a list. */
export const EdgeKeys: string[] = [
  "raw_source",
  "supersedes",
  "refines",
  "contradicts",
  "example-of",
  "source",
  "related",
];

/** The [EdgeKeys] whose YAML value is one scalar link rather than a list. */
const singleLinkKeys: Record<string, boolean> = { raw_source: true };

/** The `volatility` values the schema allows, in conventions-spec order. */
export const Volatilities = ["stable", "evolving", "volatile"] as const;

/** Whether key's YAML value is one link rather than a list — `raw_source`. */
export function isSingleLinkEdgeKey(key: string): boolean {
  return singleLinkKeys[key] === true;
}

/** One frontmatter edge key with its resolved, vault-relative targets. */
export interface Edge {
  key: string;
  targets: string[];
}

/** One page's frontmatter, decoded to plain values. */
export interface PageRecord {
  pageRef: string;
  kind: string;
  title: string;
  summary: string;
  tags: string[];
  sourceDate: string;
  volatility: string;
  edges: Edge[];
  supersededBy: string[];
}

/** Returns the targets of this record's `supersedes` edge, or null. */
export function supersedes(r: PageRecord): string[] | null {
  for (const e of r.edges) {
    if (e.key === "supersedes") return e.targets;
  }
  return null;
}

/** Decode one edge key's value into vault-relative targets, collecting every
 * refusal rather than raising on the first. Absence is not malformation: a
 * missing, null or empty value is simply no edge. */
function decodeEdge(
  key: string,
  raw: unknown,
  pageDir: string,
): { targets: string[]; errors: string[] } {
  const errors: string[] = [];
  let values: unknown[];
  if (isSingleLinkEdgeKey(key)) {
    if (typeof raw !== "string" || raw === "") return { targets: [], errors };
    values = [raw];
  } else {
    if (!Array.isArray(raw) || raw.length === 0) return { targets: [], errors };
    values = raw;
  }

  const targets: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") {
      errors.push(`${key} entry is not a markdown link: ${String(value)}`);
      continue;
    }
    const { dest, ok } = linkDest(value);
    if (!ok) {
      errors.push(`${key}: not a markdown link: "${value}"`);
      continue;
    }
    targets.push(resolveLinkDest(dest, pageDir));
  }
  return { targets, errors };
}

/** Decode every [EdgeKeys] value: the vault-relative targets, plus a refusal
 * message per value the schema rejects. One enumeration feeds both
 * [newPageRecord]'s strict raise and [malformedEdges]'s report. */
function decodeEdges(
  data: Record<string, unknown>,
  pageDir: string,
): { edges: Edge[]; malformed: string[] } {
  const edges: Edge[] = [];
  const malformed: string[] = [];
  for (const key of EdgeKeys) {
    const raw = data[key];
    if (raw === undefined || raw === null) continue;
    const { targets, errors } = decodeEdge(key, raw, pageDir);
    malformed.push(...errors);
    if (targets.length > 0) edges.push({ key, targets });
  }
  return { edges, malformed };
}

/** The record-decoding core. Malformed edges are collected, never raised here;
 * a frontmatter block the YAML parser refuses still raises. */
function decodeRecord(
  pageRef: string,
  text: string,
  kindByFolder: Record<string, string> | undefined,
): { record: PageRecord; malformed: string[] } {
  // A page not at exactly `wiki/<kind-folder>/<file>.md` is a structural error.
  let pageDir = path.posix.dirname(pageRef);
  if (pageDir === ".") pageDir = "";
  const folder = path.posix.basename(pageDir);
  if (path.posix.dirname(pageDir) !== "wiki") {
    throw new Error(`"${pageRef}": not directly under a wiki kind-folder`);
  }
  const kind =
    FolderKinds[folder] ?? kindByFolder?.[folder] ?? folderToKind(folder);

  const data = frontmatterMap(text);
  const { edges, malformed } = decodeEdges(data, pageDir);

  return {
    record: {
      pageRef,
      kind,
      title: scalar(data["title"]),
      summary: scalar(data["summary"]),
      // A scalar here means a page written by something else; read it as no tags.
      tags: stringList(data["tags"]),
      sourceDate: sourceDate(data["source_date"]),
      volatility: scalar(data["volatility"]),
      edges,
      supersededBy: [],
    },
    malformed,
  };
}

/** Decode one page's frontmatter, raising on the first refused edge value.
 * SupersededBy stays empty here — only [loadRecords] can fill it in.
 * `kindByFolder` overrides [folderToKind] but never [FolderKinds]. */
export function newPageRecord(
  pageRef: string,
  text: string,
  kindByFolder?: Record<string, string>,
): PageRecord {
  const { record, malformed } = decodeRecord(pageRef, text, kindByFolder);
  if (malformed.length > 0) throw new Error(`${pageRef}: ${malformed[0]}`);
  return record;
}

/** Every edge value the parser refuses, as its own refusal messages; never
 * raises — this is what `check frontmatter-link-format` reports. */
export function malformedEdges(text: string): string[] {
  const data = frontmatterMapOrUndefined(text);
  return data === undefined ? [] : decodeEdges(data, "").malformed;
}

/** A plain tag: a non-empty string with no whitespace, comma or quote. The
 * shape a delimited list collapses into when a writer forgets the sequence —
 * `windsor", "campaign-tactics`, which indexes as one junk tag no filter
 * matches. */
const PLAIN_TAG_RE = /^[^\s,"']+$/;

/** Every `tags` value the parser refuses, as its own refusal messages; never
 * raises — this is what `check tags-shape` reports. A missing or null `tags` is
 * no tags, not a malformed one. Entries are read exactly as the index reads
 * them, so a numeric or boolean scalar (indexed as `42`/`true`) is no finding
 * while null (indexed as an empty tag) is. */
export function malformedTags(text: string): string[] {
  const data = frontmatterMapOrUndefined(text);
  if (data === undefined) return [];
  const raw = data["tags"];
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) return [`tags is not a list: ${renderValue(raw)}`];
  const errors: string[] = [];
  for (const tag of stringList(raw)) {
    if (!PLAIN_TAG_RE.test(tag))
      errors.push(`tags entry is not a plain tag: ${renderValue(tag)}`);
  }
  return errors;
}

/** A frontmatter value as it reads in a refusal message — quoted when it is a
 * string, so a comma or quote inside it cannot blur where the value ends. */
function renderValue(v: unknown): string {
  return JSON.stringify(v) ?? String(v);
}

/** [frontmatterMap] for the `malformed*` readers: a block the YAML parser
 * refuses yields undefined, which they report as nothing rather than raise. */
function frontmatterMapOrUndefined(
  text: string,
): Record<string, unknown> | undefined {
  try {
    return frontmatterMap(text);
  } catch {
    return undefined;
  }
}

/** Parse a page's YAML frontmatter into a plain map. No frontmatter, or an
 * empty block, decodes to an empty map — a body-only file is indexable. */
function frontmatterMap(text: string): Record<string, unknown> {
  const { frontmatter, hasFrontmatter } = splitFrontmatter(text);
  if (!hasFrontmatter || frontmatter === "") return {};
  const data = parseYaml(frontmatter) as unknown;
  if (data === null || typeof data !== "object") return {};
  return data as Record<string, unknown>;
}

/** The canonical YYYY-MM-DD `source_date`, truncating any clock. A value that
 * isn't a valid date passes through verbatim — the read path tolerates legacy
 * values while the write paths reject them. The rule lives in
 * [sourcedate.parseSourceDate]. */
function sourceDate(v: unknown): string {
  const date = parseSourceDate(v);
  if (date !== null) return date;
  return scalar(v);
}

/** Render a frontmatter value as a string; a missing key and an explicit null
 * both give "". A Date is rendered date-only when it has no clock, RFC3339
 * otherwise. ([sourceDate] canonicalises `source_date` before this.) */
function scalar(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (v instanceof Date) {
    const dateOnly = `${v.getUTCFullYear()}-${String(v.getUTCMonth() + 1).padStart(2, "0")}-${String(v.getUTCDate()).padStart(2, "0")}`;
    const midnight = Date.UTC(
      v.getUTCFullYear(),
      v.getUTCMonth(),
      v.getUTCDate(),
    );
    return v.getTime() === midnight ? dateOnly : v.toISOString();
  }
  return String(v);
}

function stringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((item) => scalar(item));
}

/** How [loadRecords] treats what the schema refuses. */
export interface LoadRecordsOptions {
  /** Tolerant read for a check run: a malformed edge is left out and the page
   * survives, so its other findings still report. Off by default — a caller
   * that acts on a record must not silently read one with edges missing. */
  skipMalformedEdges?: boolean;
}

/** Decode every page ({pageRef: text}, keys vault-relative), filling in
 * SupersededBy by inverting the `supersedes` edges. Custom kind-folders are
 * supported via [folderToKind]; a page not directly under one is an error. */
export function loadRecords(
  pages: Record<string, string>,
  kindByFolder?: Record<string, string>,
  opts: LoadRecordsOptions = {},
): Record<string, PageRecord> {
  const records: Record<string, PageRecord> = {};
  for (const [pageRef, text] of Object.entries(pages)) {
    records[pageRef] = opts.skipMalformedEdges
      ? decodeRecord(pageRef, text, kindByFolder).record
      : newPageRecord(pageRef, text, kindByFolder);
  }

  const supersededBy: Record<string, string[]> = {};
  for (const [pageRef, rec] of Object.entries(records)) {
    for (const target of supersedes(rec) ?? []) {
      (supersededBy[target] ??= []).push(pageRef);
    }
  }
  for (const [pageRef, targets] of Object.entries(supersededBy)) {
    const rec = records[pageRef];
    if (rec) {
      rec.supersededBy = targets;
      records[pageRef] = rec;
    }
  }
  return records;
}
