/**
 * The one package that reads the frontmatter schema.
 *
 * Frontmatter text in, one typed record out. Every caller that needs a page's
 * frontmatter goes through here rather than re-parsing keys, so the schema
 * changes in exactly one place.
 *
 * Every path this module touches is vault-relative — a page reference
 * (`wiki/concepts/a.md`), ADR-0009. Kind is derived from the page's folder via
 * [folderToKind] (ADR-0008 singularization rule): canonical folders resolve
 * from [FolderKinds]; custom folders are singularized and used verbatim.
 * Edges recovers each of [EdgeKeys]' targets, resolved from the page's own
 * directory to true vault-relative by construction; SupersededBy is derived by
 * inverting every other page's `supersedes` edge, never read from frontmatter.
 */

import path from "node:path";
import { parse as parseYaml } from "yaml";
import { linkDest, resolveLinkDest, splitFrontmatter } from "./wikipage.js";
import { FolderKinds, folderToKind } from "./place.js";
import { parseSourceDate } from "./sourcedate.js";

/** Lists the frontmatter keys that hold markdown links to other pages. Order
 * mirrors the frontmatter schema block in the conventions spec. `raw_source`
 * holds a single link; every other key holds a list. */
export const EdgeKeys: string[] = [
  "raw_source",
  "supersedes",
  "refines",
  "contradicts",
  "example-of",
  "source",
  "related",
];

/** The [EdgeKeys] whose YAML value is one scalar link rather than a list of
 * them. */
const singleLinkKeys: Record<string, boolean> = { raw_source: true };

/** The values the frontmatter schema allows for `volatility`, in the order the
 * conventions spec lists them. Exported so a module that must judge the field
 * reads its domain from the schema's one owner rather than respelling it — the
 * same reason [isSingleLinkEdgeKey] exports `raw_source`'s shape (#548). */
export const Volatilities = ["stable", "evolving", "volatile"] as const;

/** Report whether key's YAML value is one link rather than a list of them —
 * `raw_source` alone. Exported so a module that must treat this key
 * differently reads the fact from the schema's one owner rather than
 * respelling `raw_source` (#548). */
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

/**
 * Decode one edge key's YAML value into vault-relative targets, collecting
 * every value the schema refuses rather than raising on the first.
 *
 * Absence is not malformation: a missing, null or empty value is simply no
 * edge.
 */
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

/**
 * Decode every [EdgeKeys] value in a parsed frontmatter map: the vault-relative
 * targets, and the refusal message for each value the schema refuses. One
 * enumeration feeds both [newPageRecord]'s strict raise and [malformedEdges]'s
 * report, so what one refuses the other names (#549). A key with no usable
 * links contributes no edge and no message.
 *
 * Each message spells its own key, which is what lets [malformedEdges] hand a
 * page's refusals back as plain strings.
 */
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

/**
 * The record-decoding core. Malformed edges are *collected*, never raised
 * here: [newPageRecord] turns the first into the strict error, and a tolerant
 * read drops them (#549). A frontmatter block the YAML parser refuses still
 * raises — that is a page-level malformation, not an edge one.
 */
function decodeRecord(
  pageRef: string,
  text: string,
  kindByFolder: Record<string, string> | undefined,
): { record: PageRecord; malformed: string[] } {
  // The kind-folder is the directory directly under `wiki/` that holds this
  // page (`wiki/concepts/a.md` → folder `concepts`). A page not at that exact
  // depth (e.g. `wiki/foo.md` or `wiki/concepts/nested/deep.md`) is a
  // structural error.
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
      // The writer's list-valued-key rule (wikipage.ts's `isStringListKey`)
      // guarantees this is a list on disk; a scalar here is a page written by
      // something else, and reads as no tags rather than as a malformation.
      tags: stringList(data["tags"]),
      sourceDate: sourceDate(data["source_date"]),
      volatility: scalar(data["volatility"]),
      edges,
      supersededBy: [],
    },
    malformed,
  };
}

/**
 * Decodes one page's frontmatter, raising on the first edge value the schema
 * refuses. SupersededBy is always empty here — it needs every other page, so
 * only [loadRecords] fills it in.
 *
 * `kindByFolder` is an optional folder→kind override map (e.g. populated by
 * [Vault.discoveredKinds]), checked before [FolderKinds] and the
 * [folderToKind] heuristic. Canonical four folders are always resolved via
 * [FolderKinds], which is checked first and takes precedence.
 */
export function newPageRecord(
  pageRef: string,
  text: string,
  kindByFolder?: Record<string, string>,
): PageRecord {
  const { record, malformed } = decodeRecord(pageRef, text, kindByFolder);
  if (malformed.length > 0) throw new Error(`${pageRef}: ${malformed[0]}`);
  return record;
}

/**
 * Every frontmatter edge value in a page's text that the record parser
 * refuses, as the parser's own refusal messages. Never raises — this is what
 * `check frontmatter-link-format` reports, and a scan that raised on the
 * defect it exists to name would abort the run instead (#549). A block the
 * YAML parser refuses yields nothing: that shape is not an edge's.
 */
export function malformedEdges(text: string): string[] {
  let data: Record<string, unknown>;
  try {
    data = frontmatterMap(text);
  } catch {
    return [];
  }
  return decodeEdges(data, "").malformed;
}

/**
 * Parses a page's YAML frontmatter into a plain map. A page with no
 * frontmatter, or with an empty block, decodes to an empty map rather than an
 * error — a body-only file is indexable, just featureless.
 */
function frontmatterMap(text: string): Record<string, unknown> {
  const { frontmatter, hasFrontmatter } = splitFrontmatter(text);
  if (!hasFrontmatter || frontmatter === "") return {};
  const data = parseYaml(frontmatter) as unknown;
  if (data === null || typeof data !== "object") return {};
  return data as Record<string, unknown>;
}

/**
 * Renders the frontmatter `source_date` scalar in its canonical YYYY-MM-DD
 * spelling, truncating any clock (the minimal wikitime analogue — #192). A
 * value that isn't a valid date at all is stored verbatim: the read path
 * tolerates legacy and hand-written values, while the write paths (ingest,
 * `page set`) reject them. The parse/validate/canonicalise rule itself lives
 * in [sourcedate.parseSourceDate], the one owner (#309).
 */
function sourceDate(v: unknown): string {
  const date = parseSourceDate(v);
  if (date !== null) return date;
  return scalar(v);
}

/**
 * Renders a frontmatter value as a string — a missing key and an explicit
 * null both give "".
 *
 * `source_date` never reaches here — [sourceDate] canonicalises it first. A
 * date landing in any other field is rendered date-only when it has no clock,
 * RFC3339 otherwise.
 */
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
  /** Decode the tolerant way a **check run** reads (#549): a malformed edge is
   * left out of its page's record — the page itself survives, so its other
   * findings are still reported. Off by default: a caller that acts on a
   * record must not silently read one with edges missing. */
  skipMalformedEdges?: boolean;
}

/**
 * Decodes every page in pages ({pageRef: text}, keys vault-relative), filling
 * in SupersededBy by inverting the `supersedes` edges.
 *
 * Pages in any `wiki/<folder>/` are decoded and included; custom kind-folders
 * are fully supported via [folderToKind]. Pages at the wrong depth (not
 * directly under a kind-folder) are an error.
 *
 * `kindByFolder` is an optional folder→kind override map, passed through to
 * [newPageRecord] so that KIND.md declarations take precedence over
 * [folderToKind] for custom folders. `opts` selects the tolerant read a check
 * run needs; see [LoadRecordsOptions].
 */
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
