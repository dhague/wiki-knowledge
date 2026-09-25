// Vault health checks for `enchiridion check <name>` and auto-fixes for `enchiridion fix <name>`.

import fs from "node:fs";
import path from "node:path";
import { isMap, isScalar, isSeq, parseDocument } from "yaml";
import { Vault } from "./vault.js";
import { VaultGit } from "./vaultgit.js";
import { Index } from "./searchindex.js";
import {
  splitFrontmatter,
  iterLinks,
  percentEncode,
  resolveLinkDest,
  encodeDest,
  codeLineRanges,
} from "./wikipage.js";
import { isPageRef } from "./pagepredicate.js";
import { malformedEdges, malformedTags } from "./pagerecord.js";

export interface CheckOptions {
  /** The Consolidation-vs-link cutoff, in [0, 1]. */
  minSimilarity?: number;
}

export interface Finding {
  pageRef: string;
  detail: string;
  /** Set only by `concept-fragmentation`; the JSONL consumer reads it, the text
   * renderer ignores it. */
  cluster?: FragmentationCluster;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** All .md refs under wiki/, including ones that fail isPageRef and that enumeratePageRefs skips. */
function walkAllMd(root: string): string[] {
  const wikiDir = path.join(root, "wiki");
  const refs: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (entry.name.endsWith(".md")) {
        const rel = path.relative(root, abs).split(path.sep).join("/");
        refs.push(rel);
      }
    }
  };
  try {
    walk(wikiDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  return refs.sort();
}

/** A YAML list item whose value begins with a bare `[`: YAML reads it as a flow
 * sequence, not the link string the schema wants. */
const UNQUOTED_LIST_LINK_RE = /^\s*-\s+\[/;

/** The sources kind-folder and the relative route from it into `raw/` (both
 * fixed by the plugin, ADR-0008). */
const SOURCES_DIR = "wiki/sources";
const RAW_HREF_PREFIX = path.posix.relative(SOURCES_DIR, "raw");

function regexEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// The mechanical checks
// ---------------------------------------------------------------------------

// kindFolderConformance — any folder under wiki/ is a valid kind-folder (ADR-0020); only a page at the wiki root or nested below a kind-folder is flagged.
export async function kindFolderConformance(root: string): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const ref of walkAllMd(root)) {
    const filename = ref.split("/").at(-1)!;
    if (filename === "KIND.md") continue;
    if (ref === "wiki/_index.md") continue;
    if (!isPageRef(ref)) {
      const segmentCount = ref.split("/").length;
      const nestingDepth = segmentCount - 3; // levels below the kind-folder (0 = direct child)
      const detail =
        segmentCount === 2
          ? "at wiki/ root — not under any kind-folder"
          : `nested ${nestingDepth} level(s) below a kind-folder — must be a direct child`;
      findings.push({ pageRef: ref, detail });
    }
  }
  return findings;
}

/** ingestionSourceIntegrity — every source page must carry raw_source pointing into raw/. */
export async function ingestionSourceIntegrity(
  root: string,
): Promise<Finding[]> {
  const pages = new Vault(root).pages({ skipMalformedEdges: true });
  const findings: Finding[] = [];
  for (const [ref, record] of Object.entries(pages)) {
    if (record.kind !== "source") continue;
    const hasRawSource = record.edges.some(
      (e) => e.key === "raw_source" && e.targets.length > 0,
    );
    if (!hasRawSource)
      findings.push({
        pageRef: ref,
        detail: "source page missing raw_source frontmatter field",
      });
  }
  return findings;
}

// frontmatterLinkFormat — works on raw text, not parsed records, so it can surface frontmatter the record parser refuses.
export async function frontmatterLinkFormat(root: string): Promise<Finding[]> {
  const pages = new Vault(root).loadWikiPages();
  const findings: Finding[] = [];
  for (const [ref, text] of Object.entries(pages)) {
    const { frontmatter, hasFrontmatter } = splitFrontmatter(text);
    if (!hasFrontmatter || frontmatter === "") continue;

    const unquotedLines = new Set<number>();
    const fmLines = frontmatter.split("\n");
    for (let i = 0; i < fmLines.length; i++) {
      if (UNQUOTED_LIST_LINK_RE.test(fmLines[i])) {
        unquotedLines.add(i); // 0-based to match link.line from iterLinks
        findings.push({
          pageRef: ref,
          detail: `unquoted markdown link in frontmatter: ${fmLines[i].trim()}`,
        });
      }
    }

    // Unencoded destinations (skipping lines already flagged as unquoted).
    // Frontmatter links are body-link form, anchors included (`wiki-conventions`,
    // "Links"), so path and anchor are re-encoded separately through `encodeDest`:
    // a literal `#` separates an anchor, and only a filename's own `#` is `%23`.
    for (const link of iterLinks(frontmatter)) {
      if (unquotedLines.has(link.line)) continue;
      const reencoded = encodeDest(link.decodedPath, link.decodedAnchor);
      if (link.dest !== reencoded)
        findings.push({
          pageRef: ref,
          detail: `unencoded destination in frontmatter link: "${link.dest}" (should be "${reencoded}")`,
        });
    }

    // Edge values the schema refuses (a bare path, a non-string entry): valid
    // YAML, so the scans above go blind to it, but the record parser raises.
    for (const detail of malformedEdges(text))
      findings.push({ pageRef: ref, detail });
  }
  return findings;
}

/** tagsShape — `tags` must be a YAML list of plain tags, or the page drops out
 * of every tag filter without a symptom (`pagerecord.malformedTags`). */
export async function tagsShape(root: string): Promise<Finding[]> {
  const pages = new Vault(root).loadWikiPages();
  const findings: Finding[] = [];
  for (const [ref, text] of Object.entries(pages)) {
    for (const detail of malformedTags(text))
      findings.push({ pageRef: ref, detail });
  }
  return findings;
}

/** staleSynthesis — synthesis pages whose last git commit is more than 30 days ago. */
export async function staleSynthesis(root: string): Promise<Finding[]> {
  const pages = new Vault(root).pages({ skipMalformedEdges: true });
  const vaultGit = new VaultGit(root);
  const findings: Finding[] = [];
  const cutoffMs = Date.now() - 30 * 24 * 60 * 60 * 1000;
  for (const [ref, record] of Object.entries(pages)) {
    if (record.kind !== "synthesis") continue;
    const dateStr = await vaultGit.lastCommitDate(ref);
    if (!dateStr) continue;
    const ts = new Date(dateStr).getTime();
    if (ts < cutoffMs) {
      const daysAgo = Math.floor((Date.now() - ts) / 86400000);
      findings.push({
        pageRef: ref,
        detail: `last committed ${daysAgo} days ago`,
      });
    }
  }
  return findings;
}

/** missingVolatilitySourceDate — pages missing volatility or source_date, both of which degrade ranking and temporal filtering. */
export async function missingVolatilitySourceDate(
  root: string,
): Promise<Finding[]> {
  const pages = new Vault(root).pages({ skipMalformedEdges: true });
  const findings: Finding[] = [];
  for (const [ref, record] of Object.entries(pages)) {
    if (!record.volatility)
      findings.push({ pageRef: ref, detail: "missing volatility field" });
    if (!record.sourceDate)
      findings.push({ pageRef: ref, detail: "missing source_date field" });
  }
  return findings;
}

// unresolvedSupersession — contradicts with no supersedes and no active callout: a resolved contradiction missing its supersedes record.
// A page with an active callout is a live contradiction and belongs to contradiction-callouts.
export async function unresolvedSupersession(root: string): Promise<Finding[]> {
  const pagesWithText = new Vault(root).pagesWithText({
    skipMalformedEdges: true,
  });
  const findings: Finding[] = [];
  for (const [ref, { record, text }] of Object.entries(pagesWithText)) {
    const hasContradicts = record.edges.some(
      (e) => e.key === "contradicts" && e.targets.length > 0,
    );
    if (!hasContradicts) continue;
    const hasSupersedes = record.edges.some(
      (e) => e.key === "supersedes" && e.targets.length > 0,
    );
    if (hasSupersedes) continue;
    const { body } = splitFrontmatter(text);
    if (/>\s*\[!warning\]\s*Contradiction/i.test(body)) continue;
    findings.push({
      pageRef: ref,
      detail:
        "contradicts edge without supersedes and no active callout — resolved contradiction missing supersedes record",
    });
  }
  return findings;
}

/** contradictionCallouts — pages with an active `> [!warning] Contradiction` callout in the body. */
export async function contradictionCallouts(root: string): Promise<Finding[]> {
  const pagesWithText = new Vault(root).pagesWithText({
    skipMalformedEdges: true,
  });
  const findings: Finding[] = [];
  for (const [ref, { text }] of Object.entries(pagesWithText)) {
    const { body } = splitFrontmatter(text);
    if (/>\s*\[!warning\]\s*Contradiction/i.test(body))
      findings.push({ pageRef: ref, detail: "active contradiction callout" });
  }
  return findings;
}

/** orphans — pages with zero inbound links from other wiki pages (body or frontmatter). */
export async function orphans(root: string): Promise<Finding[]> {
  const pagesWithText = new Vault(root).pagesWithText({
    skipMalformedEdges: true,
  });
  const allRefs = new Set(Object.keys(pagesWithText));
  const inbound = new Map<string, number>();
  for (const ref of allRefs) inbound.set(ref, 0);

  for (const [ref, { text }] of Object.entries(pagesWithText)) {
    const dir = ref.split("/").slice(0, -1).join("/");
    for (const link of iterLinks(text)) {
      const target = resolveLinkDest(link.decodedPath, dir);
      if (target !== ref && allRefs.has(target))
        inbound.set(target, (inbound.get(target) ?? 0) + 1);
    }
  }

  return [...inbound.entries()]
    .filter(([, count]) => count === 0)
    .map(([ref]) => ({
      pageRef: ref,
      detail: "no inbound links from other wiki pages",
    }))
    .sort((a, b) => a.pageRef.localeCompare(b.pageRef));
}

// ---------------------------------------------------------------------------
// splitLinks
// ---------------------------------------------------------------------------

/** One raw region a line break splits, and what a YAML reader makes of it. */
interface FrontmatterSplit {
  /** source offsets into the frontmatter block */
  start: number;
  end: number;
  /** the value a YAML reader reads for that region */
  joined: string;
  kind: "destination" | "label" | "boundary";
  /** the link's first line, 1-based in the file */
  line: number;
}

/** The source spans of every double-quoted scalar in a frontmatter block. Raw
 * text cannot tell a fold from a `\` that is content (block scalar) or from a
 * single-quoted scalar, so the parser decides; a block that does not parse
 * yields no spans. */
function doubleQuotedSpans(frontmatter: string): Array<[number, number]> {
  let doc;
  try {
    doc = parseDocument(frontmatter);
  } catch {
    return [];
  }
  if (doc.errors.length > 0) return [];

  const spans: Array<[number, number]> = [];
  const walk = (node: unknown): void => {
    if (isScalar(node)) {
      if (node.type === "QUOTE_DOUBLE" && node.range)
        spans.push([node.range[0], node.range[2]]);
    } else if (isSeq(node)) {
      for (const item of node.items) walk(item);
    } else if (isMap(node)) {
      for (const pair of node.items) walk(pair.value);
    }
  };
  walk(doc.contents);
  return spans;
}

function insideAny(
  spans: Array<[number, number]>,
  start: number,
  end: number,
): boolean {
  return spans.some(([s, e]) => s <= start && end <= e);
}

/** YAML's fold of a label: a space per line break, with indentation and any
 * space before the break dropped. */
function joinLabel(raw: string): string {
  return raw.replace(/[ \t]*\r?\n[ \t]*/g, " ");
}

/** Every line-break split in a frontmatter block's double-quoted link scalars,
 * in source order. One enumeration decides both what [splitLinks] reports and
 * what [fixSplitLinks] splices. */
function frontmatterSplits(frontmatter: string): FrontmatterSplit[] {
  const spans = doubleQuotedSpans(frontmatter);
  const splits: FrontmatterSplit[] = [];
  for (const link of iterLinks(frontmatter)) {
    // The block's line 0 is the file's line 2, since `---` opens on line 1.
    const line = link.line + 2;

    const labelStart = link.fullStart + (link.isImage ? 2 : 1);
    const labelEnd = labelStart + link.label.length;
    const rawLabel = frontmatter.slice(labelStart, labelEnd);
    if (rawLabel.includes("\n") && insideAny(spans, labelStart, labelEnd)) {
      splits.push({
        start: labelStart,
        end: labelEnd,
        joined: joinLabel(rawLabel),
        kind: "label",
        line,
      });
    }

    if (
      link.labelDestFold &&
      insideAny(spans, link.labelDestFold.start, link.labelDestFold.end)
    ) {
      splits.push({
        start: link.labelDestFold.start,
        end: link.labelDestFold.end,
        joined: "",
        kind: "boundary",
        line,
      });
    }

    const rawDest = frontmatter.slice(link.start, link.end);
    if (rawDest.includes("\n") && insideAny(spans, link.start, link.end)) {
      splits.push({
        start: link.start,
        end: link.end,
        // iterLinks already joins escaped breaks, so `dest` is the joined value.
        joined: link.dest,
        kind: "destination",
        line,
      });
    }
  }
  return splits;
}

/** A `](` plus a destination run with no whitespace and no closing paren, at end
 * of line. */
const OPEN_DEST_RE = /\]\(([^\s)]+)$/;

/** The line that finishes a split destination: the run picks up at column zero
 * and closes with `)`. A line opening with `"`, `(` or `)` is not one —
 * `[T](path.md` / `"title")` is a legal link and must not read as a split. */
const DEST_CONTINUATION_RE = /^[^\s"'()][^\s)]*\)/;

/** Body destinations split across a line break — the fourth shape, and the one
 * no fix may touch. The same bytes mean different things per half: in a body a
 * `\`-continuation is a CommonMark hard break, leaving literal text that is no
 * link, so [iterLinks] never sees it and `vault move` never rewrites it. Lines
 * inside code blocks are skipped, as [iterLinks] skips them. */
function bodySplits(
  pageRef: string,
  text: string,
  body: string,
  bodyOffset: number,
): Finding[] {
  const lines = body.split("\n");
  const code = codeLineRanges(body);
  const firstLine = text.slice(0, bodyOffset).split("\n").length;
  const findings: Finding[] = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    if (code.has(i) || code.has(i + 1)) continue;
    const open = OPEN_DEST_RE.exec(lines[i]);
    if (!open) continue;
    const cont = DEST_CONTINUATION_RE.exec(lines[i + 1]);
    if (!cont) continue;
    findings.push({
      pageRef,
      detail:
        `body destination split across lines (line ${firstLine + i}): ` +
        `"${open[1]}" + "${cont[0].slice(0, -1)}" — CommonMark reads no link ` +
        `here, so vault move never rewrites it`,
    });
  }
  return findings;
}

/**
 * splitLinks — no link is split across lines. Four shapes (`wiki-conventions`,
 * "Links"; ADR-0024):
 *
 *   1. a destination fold — an escaped break inside a frontmatter link scalar;
 *   2. a label fold — a plain newline in a quoted frontmatter scalar, folded
 *      by YAML to a space;
 *   3. a boundary fold — an escaped break between the label's `]` and the
 *      destination's `(`, resolved by YAML with nothing;
 *   4. a body almost-link — a destination broken across a line break in a
 *      body, which CommonMark does not read as a link at all.
 *
 * [fixSplitLinks] joins 1–3, each semantics-preserving; 4 is reported only,
 * because a break after a destination is legal markdown and joining on sight
 * can silently repoint the link. Nothing is reported outside a double-quoted
 * scalar, where raw text cannot tell a fold from content.
 */
export async function splitLinks(root: string): Promise<Finding[]> {
  const pages = new Vault(root).loadWikiPages();
  const findings: Finding[] = [];
  for (const [ref, text] of Object.entries(pages)) {
    const { frontmatter, hasFrontmatter, body, bodyOffset } =
      splitFrontmatter(text);
    if (hasFrontmatter && frontmatter !== "") {
      for (const split of frontmatterSplits(frontmatter)) {
        findings.push({
          pageRef: ref,
          detail:
            `frontmatter link ${split.kind} split across lines ` +
            `(line ${split.line}): joins to "${split.joined}"`,
        });
      }
    }
    findings.push(...bodySplits(ref, text, body, bodyOffset));
  }
  return findings;
}

// ---------------------------------------------------------------------------
// conceptFragmentation
// ---------------------------------------------------------------------------

/** Default `--min-similarity`: at or above, two pages are one concept (a
 * Consolidation); below, merely related (a link, for Missing cross-references). */
export const DefaultMinSimilarity = 0.5;

/** Kinds fragmentation never considers: one-per-thing or one-per-artifact
 * identity forbids consolidation (ADR-0021). */
const NonConsolidatableKinds = ["entity", "source", "synthesis"];

/** Cap on the FTS5 title hits one page may contribute as candidates. */
const TitleMatchLimit = 200;

/** One member of a candidate cluster. */
export interface ClusterMember {
  pageRef: string;
  /** UTF-8 byte length of the page's committed text at HEAD. */
  bytes: number;
  /** Inbound links from other committed pages. */
  inbound: number;
}

/** A `concept-fragmentation` finding's whole proposal. */
export interface FragmentationCluster {
  members: ClusterMember[];
  /** The signals the members share — why they were clustered. */
  basis: { tags: string[]; titleTokens: string[] };
  /** Weakest pairwise similarity holding the cluster together, in [0, 1] — the
   * transitive closure can join pairs individually below the bar. */
  similarity: number;
  /** The member with the most inbound links, largest body on a tie, then
   * pageRef. A hint only: the Consolidation step may override it. */
  suggestedSurvivor: string;
}

/** Title words that carry no identity signal on their own. */
const TitleStopwords = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "been",
  "but",
  "by",
  "for",
  "from",
  "has",
  "have",
  "how",
  "in",
  "into",
  "is",
  "it",
  "its",
  "not",
  "of",
  "on",
  "or",
  "per",
  "that",
  "the",
  "their",
  "these",
  "they",
  "this",
  "those",
  "to",
  "via",
  "vs",
  "was",
  "were",
  "what",
  "when",
  "where",
  "which",
  "why",
  "with",
  "you",
  "your",
]);

/** Significant title words: lowercased `[a-z0-9]+`, stopwords and
 * one-character tokens dropped. */
export function titleTokens(title: string): Set<string> {
  const tokens = new Set<string>();
  for (const word of title.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (word.length > 1 && !TitleStopwords.has(word)) tokens.add(word);
  }
  return tokens;
}

interface Signals {
  tags: Set<string>;
  titleTokens: Set<string>;
}

function intersection(a: Set<string>, b: Set<string>): string[] {
  const shared: string[] = [];
  for (const value of a) if (b.has(value)) shared.push(value);
  return shared.sort();
}

/** Combined Jaccard over both signals: shared tags plus shared title words,
 * over the union of the two pages' tags and title words. 0 when the two share
 * no vocabulary at all. */
export function similarity(a: Signals, b: Signals): number {
  const sharedTags = intersection(a.tags, b.tags).length;
  const sharedTitle = intersection(a.titleTokens, b.titleTokens).length;
  const unionTags = a.tags.size + b.tags.size - sharedTags;
  const unionTitle = a.titleTokens.size + b.titleTokens.size - sharedTitle;
  const union = unionTags + unionTitle;
  return union === 0 ? 0 : (sharedTags + sharedTitle) / union;
}

/** An FTS5 MATCH scoped to the indexed `title` column, OR-joined from the
 * page's own title words: an AND of a whole title demands every word and finds
 * nothing. */
function titleMatch(title: string): string {
  const words = [...titleTokens(title)];
  if (words.length === 0) return "";
  return `{title} : (${words.map((w) => `"${w}"`).join(" OR ")})`;
}

/** Inbound link count per page ref across one HEAD snapshot, counting only
 * links from other pages to pages the snapshot holds (orphans' rule). */
function inboundCounts(text: Map<string, string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const [ref, content] of text) {
    const dir = ref.split("/").slice(0, -1).join("/");
    for (const link of iterLinks(content)) {
      const target = resolveLinkDest(link.decodedPath, dir);
      if (target === ref || !text.has(target)) continue;
      counts.set(target, (counts.get(target) ?? 0) + 1);
    }
  }
  return counts;
}

/** The one-line human-readable form of a cluster; structured detail rides in
 * `cluster`. */
function fragmentationDetail(cluster: FragmentationCluster): string {
  const basis: string[] = [];
  if (cluster.basis.tags.length > 0)
    basis.push(`shared tags: ${cluster.basis.tags.join(", ")}`);
  if (cluster.basis.titleTokens.length > 0)
    basis.push(`shared title terms: ${cluster.basis.titleTokens.join(", ")}`);
  const why = basis.length > 0 ? basis.join("; ") : "similar titles";
  return (
    `${cluster.members.length} closely-related pages (${why}) — ` +
    `consider consolidating into ${cluster.suggestedSurvivor}`
  );
}

/**
 * conceptFragmentation — ADR-0021.
 *
 * Finds clusters of small, closely-related concept (and custom-kind) pages and
 * proposes a Consolidation per cluster: a confirm-first, lossless merge. It
 * only surfaces candidates — the judgment that a cluster truly consolidates,
 * and the merged body, belong to the `/wiki-ingest` flow.
 *
 * Candidates are ADR-0021's pair: a shared-tag self-join unioned with an FTS5
 * title match. Both read the index, a view of HEAD (ADR-0015), so an
 * uncommitted fragmented draft is invisible. Each surviving pair is scored by
 * [similarity] against `minSimilarity`; pairs below the bar are left to Missing
 * cross-references. `entity`, `source` and `synthesis` pages are excluded
 * ([NonConsolidatableKinds]).
 */
export async function conceptFragmentation(
  root: string,
  opts: CheckOptions = {},
): Promise<Finding[]> {
  const minSimilarity = opts.minSimilarity ?? DefaultMinSimilarity;
  const index = await Index.open(root);
  try {
    const pages = await index.indexedPages(NonConsolidatableKinds);
    const signals = new Map<string, Signals>();
    for (const page of pages) {
      signals.set(page.pageRef, {
        tags: new Set(page.tags),
        titleTokens: titleTokens(page.title),
      });
    }

    // Union of the two generators, keyed unordered so a pair found twice is
    // scored once.
    const candidates = new Set<string>();
    const addPair = (a: string, b: string): void => {
      if (a === b || !signals.has(a) || !signals.has(b)) return;
      candidates.add(a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);
    };

    for (const pair of await index.sharedTagPairs(NonConsolidatableKinds)) {
      addPair(pair.a, pair.b);
    }

    const scopeKinds = [...new Set(pages.map((p) => p.kind))];
    if (scopeKinds.length > 0) {
      for (const page of pages) {
        const match = titleMatch(page.title);
        if (match === "") continue;
        const hits = await index.search({
          text: match,
          raw: true,
          kinds: scopeKinds,
          // The tag self-join does not skip superseded pages either, so the
          // two generators see the same scope.
          includeSuperseded: true,
          limit: TitleMatchLimit,
        });
        for (const hit of hits) addPair(page.pageRef, hit.pageRef);
      }
    }

    const scored: Array<{ a: string; b: string; sim: number }> = [];
    for (const key of [...candidates].sort()) {
      const [a, b] = key.split("\u0000");
      const sim = similarity(signals.get(a)!, signals.get(b)!);
      if (sim >= minSimilarity) scored.push({ a, b, sim });
    }
    if (scored.length === 0) return [];

    const parent = new Map<string, string>();
    const find = (x: string): string => {
      const path: string[] = [];
      let cur = x;
      while (parent.get(cur) !== cur) {
        path.push(cur);
        cur = parent.get(cur)!;
      }
      for (const node of path) parent.set(node, cur);
      return cur;
    };
    const union = (a: string, b: string): void => {
      for (const ref of [a, b]) if (!parent.has(ref)) parent.set(ref, ref);
      const rootA = find(a);
      const rootB = find(b);
      if (rootA === rootB) return;
      // Smaller ref wins, so cluster order does not depend on pair visit order.
      if (rootA < rootB) parent.set(rootB, rootA);
      else parent.set(rootA, rootB);
    };
    for (const { a, b } of scored) union(a, b);

    const clusters = new Map<string, string[]>();
    for (const ref of parent.keys()) {
      const root = find(ref);
      const members = clusters.get(root);
      if (members) members.push(ref);
      else clusters.set(root, [ref]);
    }
    const basisByRoot = new Map<
      string,
      { tags: Set<string>; titleTokens: Set<string> }
    >();
    const minSimByRoot = new Map<string, number>();
    for (const { a, b, sim } of scored) {
      const root = find(a);
      let basis = basisByRoot.get(root);
      if (!basis) {
        basis = { tags: new Set(), titleTokens: new Set() };
        basisByRoot.set(root, basis);
      }
      const sharedTags = intersection(
        signals.get(a)!.tags,
        signals.get(b)!.tags,
      );
      const sharedTitle = intersection(
        signals.get(a)!.titleTokens,
        signals.get(b)!.titleTokens,
      );
      for (const tag of sharedTags) basis.tags.add(tag);
      for (const word of sharedTitle) basis.titleTokens.add(word);
      const previous = minSimByRoot.get(root);
      if (previous === undefined || sim < previous) minSimByRoot.set(root, sim);
    }

    // From HEAD too, so the proposal describes the same committed pages the
    // index scored (ADR-0015).
    const head = await new VaultGit(root).committedPages("");
    const text = new Map<string, string>();
    for (const change of head.pages) {
      if (!change.deleted) text.set(change.pageRef, change.content);
    }
    const inbound = inboundCounts(text);

    const findings: Finding[] = [];
    for (const [root, refs] of clusters) {
      if (refs.length < 2) continue;
      const members: ClusterMember[] = refs.sort().map((ref) => ({
        pageRef: ref,
        bytes: Buffer.byteLength(text.get(ref) ?? "", "utf8"),
        inbound: inbound.get(ref) ?? 0,
      }));
      const suggestedSurvivor = [...members].sort(
        (x, y) =>
          y.inbound - x.inbound ||
          y.bytes - x.bytes ||
          x.pageRef.localeCompare(y.pageRef),
      )[0].pageRef;
      const basis = basisByRoot.get(root);
      const cluster: FragmentationCluster = {
        members,
        basis: {
          tags: [...(basis?.tags ?? [])].sort(),
          titleTokens: [...(basis?.titleTokens ?? [])].sort(),
        },
        similarity: minSimByRoot.get(root) ?? minSimilarity,
        suggestedSurvivor,
      };
      findings.push({
        pageRef: suggestedSurvivor,
        detail: fragmentationDetail(cluster),
        cluster,
      });
    }
    return findings.sort((a, b) => a.pageRef.localeCompare(b.pageRef));
  } finally {
    index.close();
  }
}

// ---------------------------------------------------------------------------
// Check registry
// ---------------------------------------------------------------------------

export type CheckFn = (root: string, opts?: CheckOptions) => Promise<Finding[]>;

export const CHECKS: Record<string, CheckFn> = {
  "kind-folder-conformance": kindFolderConformance,
  "ingestion-source-integrity": ingestionSourceIntegrity,
  "frontmatter-link-format": frontmatterLinkFormat,
  "tags-shape": tagsShape,
  "stale-synthesis": staleSynthesis,
  "missing-volatility-source-date": missingVolatilitySourceDate,
  "unresolved-supersession": unresolvedSupersession,
  "contradiction-callouts": contradictionCallouts,
  orphans,
  "split-links": splitLinks,
  "concept-fragmentation": conceptFragmentation,
};

// ---------------------------------------------------------------------------
// Auto-fix implementations  (`enchiridion fix <name>`)
// All return the list of page refs that were modified.
// ---------------------------------------------------------------------------

// fixFrontmatterLinkFormat — quote unquoted list links and re-encode destinations in place.
export async function fixFrontmatterLinkFormat(
  root: string,
): Promise<string[]> {
  const pages = new Vault(root).loadWikiPages();
  const changed: string[] = [];
  for (const [ref, text] of Object.entries(pages)) {
    const { frontmatter, hasFrontmatter, body } = splitFrontmatter(text);
    if (!hasFrontmatter || frontmatter === "") continue;

    // Pass 1: quote unquoted markdown links in YAML list items.
    let fm = frontmatter
      .split("\n")
      .map((line) => {
        if (!UNQUOTED_LIST_LINK_RE.test(line)) return line;
        const open = line.indexOf("[");
        if (open < 0) return line;
        const closeParenIdx = line.lastIndexOf(")");
        if (closeParenIdx < 0) return line;
        return (
          line.slice(0, open) +
          `"${line.slice(open, closeParenIdx + 1)}"` +
          line.slice(closeParenIdx + 1)
        );
      })
      .join("\n");

    // Pass 2: re-encode destinations in the now-quoted frontmatter. Path and
    // anchor are re-encoded separately: recombining them first turns a working
    // `#ttl` anchor into a dangling `%23ttl`.
    const edits: Array<{ start: number; end: number; dest: string }> = [];
    for (const link of iterLinks(fm)) {
      const reencoded = encodeDest(link.decodedPath, link.decodedAnchor);
      if (link.dest !== reencoded)
        edits.push({ start: link.start, end: link.end, dest: reencoded });
    }
    edits.sort((a, b) => b.start - a.start);
    for (const e of edits) fm = fm.slice(0, e.start) + e.dest + fm.slice(e.end);

    if (fm === frontmatter) continue;
    fs.writeFileSync(path.join(root, ref), `---\n${fm}---\n${body}`, "utf8");
    changed.push(ref);
  }
  return changed;
}

// fixIngestionSourceIntegrity — move the one unambiguous raw/ body link to raw_source: frontmatter.
export async function fixIngestionSourceIntegrity(
  root: string,
): Promise<string[]> {
  const pages = new Vault(root).loadWikiPages();
  const changed: string[] = [];
  for (const [ref, text] of Object.entries(pages)) {
    if (!ref.startsWith(SOURCES_DIR + "/")) continue;
    const { frontmatter, hasFrontmatter, body } = splitFrontmatter(text);
    if (!hasFrontmatter) continue;
    if (/^raw_source\s*:/m.test(frontmatter)) continue;

    // Only when exactly one raw/ link exists in the body ([RAW_HREF_PREFIX] is
    // the route from this folder into `raw/`).
    const rawLinkRe = new RegExp(
      `\\[[^\\]]+\\]\\(${regexEscape(RAW_HREF_PREFIX)}/[^)]+\\)`,
      "g",
    );
    const rawLinks = [...body.matchAll(rawLinkRe)];
    if (rawLinks.length !== 1) continue;

    const [m] = rawLinks;
    const newFm = frontmatter.trimEnd() + `\nraw_source: "${m[0]}"\n`;
    const newBody =
      body.slice(0, m.index!) + body.slice(m.index! + m[0].length);
    fs.writeFileSync(
      path.join(root, ref),
      `---\n${newFm}---\n${newBody}`,
      "utf8",
    );
    changed.push(ref);
  }
  return changed;
}

// fixMissingCrossReferences — insert relative markdown links for exact title
// matches in body text that have no existing link to that page.
export async function fixMissingCrossReferences(
  root: string,
): Promise<string[]> {
  const pagesWithText = new Vault(root).pagesWithText({
    skipMalformedEdges: true,
  });

  const titleToRef = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const [ref, { record }] of Object.entries(pagesWithText)) {
    if (!record.title) continue;
    if (ambiguous.has(record.title)) continue;
    if (titleToRef.has(record.title)) {
      titleToRef.delete(record.title);
      ambiguous.add(record.title);
    } else {
      titleToRef.set(record.title, ref);
    }
  }

  const changed: string[] = [];
  for (const [ref, { text }] of Object.entries(pagesWithText)) {
    const { frontmatter, hasFrontmatter, body } = splitFrontmatter(text);
    const pageDir = ref.split("/").slice(0, -1).join("/");

    const linkedRefs = new Set<string>();
    // Body link spans, to detect "already inside a link".
    const linkSpans: Array<[number, number]> = [];
    for (const link of iterLinks(body)) {
      linkedRefs.add(resolveLinkDest(link.decodedPath, pageDir));
      // Scan back from the destination to the opening `[`.
      let spanStart = link.start - 1;
      while (spanStart > 0 && body[spanStart] !== "[") spanStart--;
      linkSpans.push([spanStart, link.end + 1]);
    }

    let newBody = body;
    let anyEdit = false;

    for (const [title, targetRef] of titleToRef) {
      if (targetRef === ref) continue;
      if (linkedRefs.has(targetRef)) continue;

      const idx = newBody.indexOf(title);
      if (idx < 0) continue;

      // Skip if the mention falls inside an existing link span (linkSpans stays in sync with newBody)
      if (linkSpans.some(([s, e]) => idx >= s && idx + title.length <= e))
        continue;

      // Skip if preceded by [ (already a link label) or backtick (code span)
      const ch = idx > 0 ? newBody[idx - 1] : "";
      if (ch === "[" || ch === "`") continue;

      const relPath = path
        .relative(pageDir, targetRef)
        .split(path.sep)
        .join("/");
      const insertion = `[${title}](${percentEncode(relPath)})`;
      const diff = insertion.length - title.length;
      newBody =
        newBody.slice(0, idx) + insertion + newBody.slice(idx + title.length);

      for (let i = 0; i < linkSpans.length; i++) {
        if (linkSpans[i][0] > idx) {
          linkSpans[i] = [linkSpans[i][0] + diff, linkSpans[i][1] + diff];
        }
      }
      linkSpans.push([idx, idx + insertion.length]);

      linkedRefs.add(targetRef);
      anyEdit = true;
    }

    if (!anyEdit) continue;
    const newText = hasFrontmatter
      ? `---\n${frontmatter}---\n${newBody}`
      : newBody;
    fs.writeFileSync(path.join(root, ref), newText, "utf8");
    changed.push(ref);
  }
  return changed;
}

// fixSplitLinks — join the three frontmatter shapes in place; body splits stay
// a report-only finding (joining one on sight can silently repoint the link).
export async function fixSplitLinks(root: string): Promise<string[]> {
  const pages = new Vault(root).loadWikiPages();
  const changed: string[] = [];
  for (const [ref, text] of Object.entries(pages)) {
    const { frontmatter, hasFrontmatter, body } = splitFrontmatter(text);
    if (!hasFrontmatter || frontmatter === "") continue;

    const splits = frontmatterSplits(frontmatter);
    if (splits.length === 0) continue;

    // Splice back-to-front by source offset so every untouched byte survives —
    // key order, quote styles and spacing alike; only the join may differ
    // (ADR-0012). Joining the reader's own value keeps the edit
    // semantics-preserving.
    let fm = frontmatter;
    for (const s of splits.sort((a, b) => b.start - a.start)) {
      fm = fm.slice(0, s.start) + s.joined + fm.slice(s.end);
    }

    fs.writeFileSync(path.join(root, ref), `---\n${fm}---\n${body}`, "utf8");
    changed.push(ref);
  }
  return changed;
}

export const FIXES: Record<string, (root: string) => Promise<string[]>> = {
  "frontmatter-link-format": fixFrontmatterLinkFormat,
  "ingestion-source-integrity": fixIngestionSourceIntegrity,
  "missing-cross-references": fixMissingCrossReferences,
  "split-links": fixSplitLinks,
};
