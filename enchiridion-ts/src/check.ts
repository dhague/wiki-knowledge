// Vault health checks for `enchiridion check <name>` and auto-fixes for `enchiridion fix <name>`.

import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isMap, isScalar, isSeq, parseDocument } from "yaml";
import { Vault } from "./vault.js";
import { VaultRead } from "./vaultread.js";
import { VaultGit } from "./vaultgit.js";
import { Index } from "./searchindex.js";
import {
  splitFrontmatter,
  iterLinks,
  composeLink,
  resolveLinkDest,
  encodeDest,
  codeLineRanges,
  rewriteFrontmatter,
  isUnquotedListLinkLine,
  Page,
} from "./wikipage.js";
import { isPageRef } from "./pagepredicate.js";
import { loadRecords, malformedEdges, malformedTags } from "./pagerecord.js";
import type { PageRecord } from "./pagerecord.js";
import { KindFolders } from "./place.js";
import {
  memberSetKey,
  parseRegistry,
  refSetKey,
  refreshExclusions,
  renderRegistry,
  resolveExclusion,
  suppressedBy,
} from "./consolidationexclusions.js";
import type { Registry, ResolvedExclusion } from "./consolidationexclusions.js";
import type { PageFact } from "./searchindex.js";

export interface CheckOptions {
  /** The Consolidation-vs-link cutoff, in [0, 1]. */
  minSimilarity?: number;
}

/** What a fix run may be asked to do beyond the always-safe repairs. */
export interface FixOptions {
  /** `consolidation-exclusions`: also drop members that no longer match HEAD,
   * deleting a record left with fewer than two. Confirm-first — it discards a
   * decision a human made. */
  prune?: boolean;
}

/** One auto-fix: a root, and whatever a fix run was asked to do. */
export type FixFn = (root: string, opts?: FixOptions) => Promise<string[]>;

export interface Finding {
  pageRef: string;
  detail: string;
  /** Set only by `concept-fragmentation`; the JSONL consumer reads it, the text
   * renderer ignores it. */
  cluster?: FragmentationCluster;
}

/** A finding naming the check that raised it — `check --all`'s row shape, the
 * one run where the caller did not name the check itself. */
export type TaggedFinding = Finding & { check: string };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** The sources kind-folder and the relative route from it into `raw/` (both
 * fixed by the plugin, ADR-0008). */
const SOURCES_DIR = `wiki/${KindFolders["source"]}`;
const RAW_HREF_PREFIX = path.posix.relative(SOURCES_DIR, "raw");

function regexEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// The mechanical checks
// ---------------------------------------------------------------------------

// kindFolderConformance — any folder under wiki/ is a valid kind-folder (ADR-0020); only a page at the wiki root or nested below a kind-folder is flagged.
export async function kindFolderConformance(
  read: VaultRead,
): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const ref of read.allRefs()) {
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
  read: VaultRead,
): Promise<Finding[]> {
  const pages = read.records();
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
export async function frontmatterLinkFormat(
  read: VaultRead,
): Promise<Finding[]> {
  const pages = read.texts();
  const findings: Finding[] = [];
  for (const [ref, text] of Object.entries(pages)) {
    const { frontmatter, hasFrontmatter } = splitFrontmatter(text);
    if (!hasFrontmatter || frontmatter === "") continue;

    const unquotedLines = new Set<number>();
    const fmLines = frontmatter.split("\n");
    for (let i = 0; i < fmLines.length; i++) {
      if (isUnquotedListLinkLine(fmLines[i])) {
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
export async function tagsShape(read: VaultRead): Promise<Finding[]> {
  const pages = read.texts();
  const findings: Finding[] = [];
  for (const [ref, text] of Object.entries(pages)) {
    for (const detail of malformedTags(text))
      findings.push({ pageRef: ref, detail });
  }
  return findings;
}

/** Age at which a synthesis page reads as stale, in days. */
export const StaleSynthesisDays = 30;

/** staleSynthesis — synthesis pages whose last git commit is older than
 * [StaleSynthesisDays]. */
export async function staleSynthesis(read: VaultRead): Promise<Finding[]> {
  const pages = read.records();
  const vaultGit = new VaultGit(read.root);
  const findings: Finding[] = [];
  const cutoffMs = Date.now() - StaleSynthesisDays * 24 * 60 * 60 * 1000;
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
  read: VaultRead,
): Promise<Finding[]> {
  const pages = read.records();
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
export async function unresolvedSupersession(
  read: VaultRead,
): Promise<Finding[]> {
  const pagesWithText = read.pagesWithText();
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
export async function contradictionCallouts(
  read: VaultRead,
): Promise<Finding[]> {
  const pagesWithText = read.pagesWithText();
  const findings: Finding[] = [];
  for (const [ref, { text }] of Object.entries(pagesWithText)) {
    const { body } = splitFrontmatter(text);
    if (/>\s*\[!warning\]\s*Contradiction/i.test(body))
      findings.push({ pageRef: ref, detail: "active contradiction callout" });
  }
  return findings;
}

/** orphans — pages with zero inbound links from other wiki pages (body or frontmatter). */
export async function orphans(read: VaultRead): Promise<Finding[]> {
  const pagesWithText = read.pagesWithText();
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
 * in source order. [splitLinks] reports one finding each; [fixedSplitLinks]
 * uses a non-empty list as its signal to re-render the block unfolded. */
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
      splits.push({ joined: joinLabel(rawLabel), kind: "label", line });
    }

    if (
      link.labelDestFold &&
      insideAny(spans, link.labelDestFold.start, link.labelDestFold.end)
    ) {
      splits.push({ joined: "", kind: "boundary", line });
    }

    const rawDest = frontmatter.slice(link.start, link.end);
    if (rawDest.includes("\n") && insideAny(spans, link.start, link.end)) {
      // iterLinks already joins escaped breaks, so `dest` is the joined value.
      splits.push({ joined: link.dest, kind: "destination", line });
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
export async function splitLinks(read: VaultRead): Promise<Finding[]> {
  const pages = read.texts();
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

/** An unordered pair of page refs, in the shared set-key spelling. */
function pairKey(a: string, b: string): string {
  return refSetKey([a, b]);
}

/** Every pair joined by a `contradicts` or `supersedes` edge, in either
 * direction. Such a pair is already related the right way, so a Consolidation
 * proposal would be wrong (ADR-0028). */
function conflictingPairs(records: Record<string, PageRecord>): Set<string> {
  const pairs = new Set<string>();
  for (const [ref, record] of Object.entries(records)) {
    for (const edge of record.edges) {
      if (edge.key !== "contradicts" && edge.key !== "supersedes") continue;
      for (const target of edge.targets) {
        if (target !== ref) pairs.add(pairKey(ref, target));
      }
    }
  }
  return pairs;
}

/** Whether any two of a cluster's members are joined by a conflict edge — the
 * closure can still hold such a pair when a third page links them both. */
function clusterConflicts(refs: string[], conflicts: Set<string>): boolean {
  for (let i = 0; i < refs.length; i++) {
    for (let j = i + 1; j < refs.length; j++) {
      if (conflicts.has(pairKey(refs[i], refs[j]))) return true;
    }
  }
  return false;
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

/** One decoded registry file plus its records read against HEAD. */
interface RegistryState extends Registry {
  resolved: ResolvedExclusion[];
}

/** One run's registries and the facts they were read against — the fix reuses
 * both, so a registry is parsed once per run. */
interface RegistryRead {
  registries: RegistryState[];
  facts: Map<string, PageFact>;
}

/** Decode every registry and read its records against the open index's
 * snapshot. The index's `page` rows carry exactly the blob oid and fingerprint
 * the two-tier rule compares, so validating a registry reparses nothing
 * (ADR-0015). */
async function readRegistries(
  read: VaultRead,
  index: Index,
): Promise<RegistryRead> {
  const registries: RegistryState[] = [];
  const refs: string[] = [];
  for (const file of read.registryFiles()) {
    const { exclusions, error } = parseRegistry(file.text);
    for (const exclusion of exclusions) {
      for (const member of exclusion.members) refs.push(member.pageRef);
    }
    registries.push({ ref: file.ref, exclusions, error, resolved: [] });
  }
  const facts = await index.pageFacts(refs);
  for (const registry of registries) {
    registry.resolved = registry.exclusions.map((exclusion) =>
      resolveExclusion(exclusion, facts),
    );
  }
  return { registries, facts };
}

/**
 * conceptFragmentation — ADR-0021, ADR-0027, ADR-0028.
 *
 * Finds clusters of closely-related consolidatable pages and proposes a
 * Consolidation per cluster: a confirm-first, lossless merge, surfaced only —
 * the merged body and the content-based recommendation belong to the
 * `wiki-lint` / `/wiki-ingest` flow.
 *
 * Candidates are ADR-0021's pair — a shared-tag self-join unioned with an FTS5
 * title match, both read from the index, a view of HEAD (ADR-0015) — scored by
 * [similarity] against `minSimilarity`; pairs below the bar are left to Missing
 * cross-references. Scope is ADR-0027's. A `contradicts`/`supersedes` edge
 * between members, or an exclusion whose effective member set matches, drops
 * the cluster (ADR-0028).
 */
export async function conceptFragmentation(
  read: VaultRead,
  opts: CheckOptions = {},
): Promise<Finding[]> {
  const minSimilarity = opts.minSimilarity ?? DefaultMinSimilarity;
  const scope = read.consolidatableKinds();
  const index = await Index.open(read.root);
  try {
    const pages = await index.indexedPages(scope);
    const signals = new Map<string, Signals>();
    const kindOf = new Map<string, string>();
    for (const page of pages) {
      signals.set(page.pageRef, {
        tags: new Set(page.tags),
        titleTokens: titleTokens(page.title),
      });
      kindOf.set(page.pageRef, page.kind);
    }

    const { registries } = await readRegistries(read, index);
    const resolved = registries.flatMap((state) => state.resolved);

    // Union of the two generators, keyed unordered so a pair found twice is
    // scored once. Cross-kind pairs are dropped here, which is what keeps every
    // cluster kind-homogeneous.
    const candidates = new Set<string>();
    const addPair = (a: string, b: string): void => {
      if (a === b || !signals.has(a) || !signals.has(b)) return;
      if (kindOf.get(a) !== kindOf.get(b)) return;
      candidates.add(pairKey(a, b));
    };

    for (const pair of await index.sharedTagPairs(scope)) {
      addPair(pair.a, pair.b);
    }

    for (const page of pages) {
      const match = titleMatch(page.title);
      if (match === "") continue;
      const hits = await index.search({
        text: match,
        raw: true,
        kinds: scope,
        // The tag self-join does not skip superseded pages either, so the
        // two generators see the same scope.
        includeSuperseded: true,
        limit: TitleMatchLimit,
      });
      for (const hit of hits) addPair(page.pageRef, hit.pageRef);
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
    const head = await new VaultGit(read.root).committedPages("");
    const text = new Map<string, string>();
    for (const change of head.pages) {
      if (!change.deleted) text.set(change.pageRef, change.content);
    }
    const inbound = inboundCounts(text);
    // Parsed at most once, and only once a cluster survives suppression: the
    // conflict edges are the one thing the index does not carry.
    let conflicts: Set<string> | null = null;
    const conflictEdges = (): Set<string> =>
      (conflicts ??= conflictingPairs(
        loadRecords(Object.fromEntries(text), undefined, {
          skipMalformedEdges: true,
        }),
      ));

    const findings: Finding[] = [];
    for (const [root, refs] of clusters) {
      if (refs.length < 2) continue;
      if (suppressedBy(refs, resolved) !== null) continue;
      if (clusterConflicts(refs, conflictEdges())) continue;
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
// consolidationExclusions
// ---------------------------------------------------------------------------

/** consolidationExclusions — the registry's own integrity (ADR-0028): a
 * malformed file is reported rather than crashed on, and every other finding
 * names the repair `fix consolidation-exclusions` would apply. */
export async function consolidationExclusions(
  read: VaultRead,
): Promise<Finding[]> {
  const index = await Index.open(read.root);
  try {
    const { registries } = await readRegistries(read, index);
    const findings: Finding[] = [];
    for (const registry of registries) {
      if (registry.error !== null) {
        findings.push({
          pageRef: registry.ref,
          detail:
            `registry integrity: ${registry.error}; candidate reporting ignores ` +
            `this file until the YAML is repaired by hand`,
        });
        continue;
      }

      const byMemberSet = new Map<string, ResolvedExclusion[]>();
      for (const record of registry.resolved) {
        const key = memberSetKey(record.exclusion.members);
        const list = byMemberSet.get(key);
        if (list) list.push(record);
        else byMemberSet.set(key, [record]);
      }
      for (const duplicates of byMemberSet.values()) {
        if (duplicates.length < 2) continue;
        const members = duplicates[0].exclusion.members
          .map((m) => m.pageRef)
          .join(", ");
        const reasons = new Set(duplicates.map((d) => d.exclusion.reason));
        findings.push({
          pageRef: registry.ref,
          detail:
            reasons.size === 1
              ? `${duplicates.length} identical records for ${members}; fix consolidation-exclusions collapses them`
              : `${duplicates.length} records name ${members} with different reasons; resolve by hand`,
        });
      }

      for (const record of registry.resolved) {
        const dropped = [...record.staleMembers, ...record.missingMembers].map(
          (m) => m.pageRef,
        );
        const members = record.exclusion.members
          .map((m) => m.pageRef)
          .join(", ");
        if (dropped.length > 0) {
          const gone =
            record.validMembers.length < 2 ? " and deletes the record" : "";
          findings.push({
            pageRef: registry.ref,
            detail: `member(s) ${dropped.join(", ")} no longer match HEAD; fix consolidation-exclusions --prune drops them${gone}`,
          });
        } else if (record.validMembers.length < 2) {
          findings.push({
            pageRef: registry.ref,
            detail: `only ${record.validMembers.length} of ${record.exclusion.members.length} members (${members}) match HEAD; fix consolidation-exclusions --prune deletes the record`,
          });
        }
      }
    }
    return findings.sort((a, b) => a.pageRef.localeCompare(b.pageRef));
  } finally {
    index.close();
  }
}

// ---------------------------------------------------------------------------
// duplicateFrontmatter
// ---------------------------------------------------------------------------

/** A `---`-delimited block at the head of a page, with its byte span (fences
 * included) so a redundant one can be dropped verbatim. */
interface FrontmatterBlock {
  yaml: string;
  start: number;
  end: number;
}

/** A page's leading blocks, and the indices holding every other block's keys
 * when each block is a readable mapping. */
interface DuplicateAnalysis {
  blocks: FrontmatterBlock[];
  readable: boolean;
  dominant: number[];
}

/** Every `---` block at the head of a page, in order; a blank line between
 * blocks is skipped, since it is the same corruption with a stray newline. A
 * fence with no closing `---` is not a block. */
function leadingFrontmatterBlocks(text: string): FrontmatterBlock[] {
  const blocks: FrontmatterBlock[] = [];
  let offset = 0;
  while (offset < text.length) {
    if (blocks.length > 0) {
      const gap = /^(?:[ \t]*\r?\n)+/.exec(text.slice(offset));
      if (gap) offset += gap[0].length;
    }
    const { frontmatter, hasFrontmatter, bodyOffset } = splitFrontmatter(
      text.slice(offset),
    );
    if (!hasFrontmatter) break;
    blocks.push({ yaml: frontmatter, start: offset, end: offset + bodyOffset });
    offset += bodyOffset;
  }
  return blocks;
}

/** The block's decoded mapping. An empty block decodes to `{}`, a subset of
 * every mapping; null means the block holds no mapping — a comment-only block,
 * a sequence, a scalar, or YAML the parser refuses. */
function blockMapping(yaml: string): Record<string, unknown> | null {
  if (yaml.trim() === "") return {};
  let doc;
  try {
    doc = parseDocument(yaml);
  } catch {
    return null;
  }
  if (doc.errors.length > 0 || doc.contents === null) return null;
  if (!isMap(doc.contents)) return null;
  return doc.contents.toJSON() as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** a ⊆ b over decoded YAML: every key present, every list entry matched, order
 * irrelevant — a stale block that lost entries is a subset of the repaired one. */
function yamlSubset(a: unknown, b: unknown): boolean {
  if (Array.isArray(a))
    return (
      Array.isArray(b) && a.every((x) => b.some((y) => isDeepStrictEqual(x, y)))
    );
  if (isRecord(a) && isRecord(b))
    return Object.entries(a).every(([k, v]) => k in b && yamlSubset(v, b[k]));
  return a === b;
}

/** The indices of the blocks that hold every other block's keys — several only
 * when they carry the same information. */
function dominantIndices(mappings: Array<Record<string, unknown>>): number[] {
  return mappings
    .map((_, i) => i)
    .filter((i) => mappings.every((m) => yamlSubset(m, mappings[i])));
}

/** A page's leading blocks when it carries more than one, else null. */
function duplicateAnalysis(text: string): DuplicateAnalysis | null {
  const blocks = leadingFrontmatterBlocks(text);
  if (blocks.length < 2) return null;
  const mappings: Array<Record<string, unknown>> = [];
  let readable = true;
  for (const block of blocks) {
    const mapping = blockMapping(block.yaml);
    if (mapping === null) readable = false;
    else mappings.push(mapping);
  }
  return {
    blocks,
    readable,
    dominant: readable ? dominantIndices(mappings) : [],
  };
}

/** The finding's one-line detail, naming whether the fix will take the page. */
function duplicateDetail(analysis: DuplicateAnalysis): string {
  const reason = !analysis.readable
    ? "a block is not a readable mapping, so merge by hand"
    : analysis.dominant.length > 0
      ? "redundant, so fix collapses them"
      : "divergent, so merge by hand";
  return (
    `${analysis.blocks.length} frontmatter blocks before the body; the parser ` +
    `reads only the first, so later blocks' edges are invisible and their text ` +
    `renders as body — ${reason}`
  );
}

/** duplicateFrontmatter — a page's frontmatter is exactly one leading `---`
 * block; the parser reads the first and stops, so every later block's edges are
 * invisible and its text renders as body. */
export async function duplicateFrontmatter(
  read: VaultRead,
): Promise<Finding[]> {
  const pages = read.texts();
  const findings: Finding[] = [];
  for (const [ref, text] of Object.entries(pages)) {
    const analysis = duplicateAnalysis(text);
    if (analysis === null) continue;
    findings.push({ pageRef: ref, detail: duplicateDetail(analysis) });
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Check registry
// ---------------------------------------------------------------------------

export type CheckFn = (
  read: VaultRead,
  opts?: CheckOptions,
) => Promise<Finding[]>;

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
  "duplicate-frontmatter": duplicateFrontmatter,
  "concept-fragmentation": conceptFragmentation,
  "consolidation-exclusions": consolidationExclusions,
};

/** Run every check against one shared read, in registry order, each finding
 * tagged with the check that raised it. */
export async function runAllChecks(
  root: string,
  opts: CheckOptions = {},
): Promise<TaggedFinding[]> {
  const read = new VaultRead(root);
  const rows: TaggedFinding[] = [];
  for (const [check, fn] of Object.entries(CHECKS)) {
    const findings = await fn(read, opts);
    rows.push(...findings.map((f) => ({ ...f, check })));
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Auto-fix implementations  (`enchiridion fix <name>`)
//
// Each fix is a pure text-to-text function; the driver below is the only I/O.
// Page writes go through [Vault.write].
// ---------------------------------------------------------------------------

/** The one raw/ link a source stub may name from its body ([RAW_HREF_PREFIX] is
 * the route from the sources folder into `raw/`). */
const RawBodyLinkRe = new RegExp(
  `\\[[^\\]]+\\]\\(${regexEscape(RAW_HREF_PREFIX)}/[^)]+\\)`,
  "g",
);

/** Run rewrite, tolerating frontmatter the YAML parser refuses: a fix cannot
 * repair a block it cannot read, and one bad page must not abort the run. */
function rewritable(text: string, rewrite: () => string): string {
  try {
    return rewrite();
  } catch {
    return text;
  }
}

/** Write every page in plan and return its refs, sorted. */
function writePlan(vault: Vault, plan: Map<string, string>): string[] {
  const changed = [...plan.keys()];
  for (const [ref, text] of plan) vault.write(ref, new Page(text));
  return changed.sort();
}

/** Every markdown-link destination in text whose spelling differs from its
 * canonical encoding — the rule `frontmatter-link-format` reports and this fix
 * applies. One function so the guard and the rewrite cannot disagree. */
function reencodeLinkEdits(
  text: string,
): Array<{ start: number; end: number; dest: string }> {
  const edits: Array<{ start: number; end: number; dest: string }> = [];
  for (const link of iterLinks(text)) {
    const dest = encodeDest(link.decodedPath, link.decodedAnchor);
    if (link.dest !== dest)
      edits.push({ start: link.start, end: link.end, dest });
  }
  return edits;
}

/** Report whether a frontmatter block carries a link the writer would re-encode
 * or a bare list link it would quote — the two shapes this fix repairs. */
function frontmatterLinksNeedFix(frontmatter: string): boolean {
  if (frontmatter.split("\n").some(isUnquotedListLinkLine)) return true;
  return reencodeLinkEdits(frontmatter).length > 0;
}

/** Re-encode every markdown-link destination in a decoded frontmatter value,
 * list entries included. */
function reencodeLinks(value: unknown): unknown {
  if (typeof value === "string") {
    let out = value;
    for (const e of reencodeLinkEdits(value).sort(
      (a, b) => b.start - a.start,
    )) {
      out = out.slice(0, e.start) + e.dest + out.slice(e.end);
    }
    return out;
  }
  if (Array.isArray(value)) return value.map(reencodeLinks);
  return value;
}

/** fixFrontmatterLinkFormat — quote bare list links and re-encode destinations. */
export function fixedFrontmatterLinkFormat(text: string): string {
  const { frontmatter, hasFrontmatter } = splitFrontmatter(text);
  if (!hasFrontmatter || frontmatter === "") return text;
  if (!frontmatterLinksNeedFix(frontmatter)) return text;
  return rewritable(text, () =>
    rewriteFrontmatter(text, (fm) => {
      for (const key of fm.keys()) {
        const value = fm.get(key);
        const reencoded = reencodeLinks(value);
        if (!isDeepStrictEqual(reencoded, value)) fm.set(key, reencoded);
      }
    }),
  );
}

/** fixIngestionSourceIntegrity — move the one unambiguous raw/ body link to
 * raw_source: frontmatter. */
export function fixedIngestionSourceIntegrity(text: string): string {
  const { frontmatter, hasFrontmatter, body } = splitFrontmatter(text);
  if (!hasFrontmatter) return text;
  if (/^raw_source\s*:/m.test(frontmatter)) return text;

  const rawLinks = [...body.matchAll(RawBodyLinkRe)];
  if (rawLinks.length !== 1) return text;

  const [m] = rawLinks;
  const newBody = body.slice(0, m.index!) + body.slice(m.index! + m[0].length);
  return rewritable(text, () =>
    rewriteFrontmatter(text, (fm) => {
      fm.set("raw_source", m[0]);
      return newBody;
    }),
  );
}

/** One page as the cross-reference fix reads it. */
export interface CrossReferencePage {
  title: string;
  text: string;
}

/** fixMissingCrossReferences — insert relative markdown links for exact title
 * matches in body text that have no existing link to that page. Returns only
 * the pages it changed. */
export function fixedMissingCrossReferences(
  pages: Record<string, CrossReferencePage>,
): Map<string, string> {
  const titleToRef = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const [ref, { title }] of Object.entries(pages)) {
    if (!title) continue;
    if (ambiguous.has(title)) continue;
    if (titleToRef.has(title)) {
      titleToRef.delete(title);
      ambiguous.add(title);
    } else {
      titleToRef.set(title, ref);
    }
  }

  const plan = new Map<string, string>();
  for (const [ref, { text }] of Object.entries(pages)) {
    const { body } = splitFrontmatter(text);
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

      const insertion = composeLink(title, targetRef, pageDir);
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
    const next = rewritable(text, () =>
      rewriteFrontmatter(text, () => newBody),
    );
    if (next !== text) plan.set(ref, next);
  }
  return plan;
}

/** fixSplitLinks — join the three frontmatter shapes. Re-rendering through the
 * seam joins them because the writer folds nothing (ADR-0024); body splits stay
 * a report-only finding, since joining one on sight can silently repoint the
 * link. */
export function fixedSplitLinks(text: string): string {
  const { frontmatter, hasFrontmatter } = splitFrontmatter(text);
  if (!hasFrontmatter || frontmatter === "") return text;
  if (frontmatterSplits(frontmatter).length === 0) return text;
  return rewritable(text, () => rewriteFrontmatter(text, () => {}));
}

/** fixDuplicateFrontmatter — collapse the leading blocks to the one holding
 * every key; divergent or unreadable blocks are left for a hand merge. */
export function fixedDuplicateFrontmatter(text: string): string {
  const analysis = duplicateAnalysis(text);
  if (analysis === null || !analysis.readable) return text;
  if (analysis.dominant.length === 0) return text;

  const keep = analysis.blocks[analysis.dominant[0]];
  const last = analysis.blocks[analysis.blocks.length - 1];
  const collapsed = text.slice(keep.start, keep.end) + text.slice(last.end);
  if (collapsed === text) return text;
  return rewritable(text, () => rewriteFrontmatter(collapsed, () => {}));
}

/** Run a per-page fix over the whole vault, writing only the pages it changed. */
async function fixEveryPage(
  root: string,
  fix: (text: string) => string,
  include: (ref: string) => boolean = () => true,
): Promise<string[]> {
  const vault = new Vault(root);
  const plan = new Map<string, string>();
  for (const [ref, text] of Object.entries(vault.loadWikiPages())) {
    if (!include(ref)) continue;
    const next = fix(text);
    if (next !== text) plan.set(ref, next);
  }
  return writePlan(vault, plan);
}

export async function fixFrontmatterLinkFormat(
  root: string,
): Promise<string[]> {
  return fixEveryPage(root, fixedFrontmatterLinkFormat);
}

export async function fixIngestionSourceIntegrity(
  root: string,
): Promise<string[]> {
  return fixEveryPage(root, fixedIngestionSourceIntegrity, (ref) =>
    ref.startsWith(SOURCES_DIR + "/"),
  );
}

export async function fixMissingCrossReferences(
  root: string,
): Promise<string[]> {
  const vault = new Vault(root);
  const pages: Record<string, CrossReferencePage> = {};
  for (const [ref, { record, text }] of Object.entries(
    vault.pagesWithText({ skipMalformedEdges: true }),
  )) {
    pages[ref] = { title: record.title, text };
  }
  return writePlan(vault, fixedMissingCrossReferences(pages));
}

export async function fixSplitLinks(root: string): Promise<string[]> {
  return fixEveryPage(root, fixedSplitLinks);
}

export async function fixDuplicateFrontmatter(root: string): Promise<string[]> {
  return fixEveryPage(root, fixedDuplicateFrontmatter);
}

/** fixConsolidationExclusions — canonicalise every registry, refresh a cached
 * blob oid whose fingerprint still matches, and collapse safe duplicates
 * (ADR-0028). `--prune` also drops members that no longer match HEAD, which is
 * confirm-first because it discards a decision a human made. */
export async function fixConsolidationExclusions(
  root: string,
  opts: FixOptions = {},
): Promise<string[]> {
  const read = new VaultRead(root);
  if (read.registryFiles().length === 0) return [];
  const vault = new Vault(root);
  const index = await Index.open(root);
  const changed: string[] = [];
  try {
    const { registries, facts } = await readRegistries(read, index);
    for (const registry of registries) {
      // Not mechanically repairable: the check reports it for a hand edit.
      if (registry.error !== null) continue;
      const next = refreshExclusions(registry.exclusions, facts, {
        prune: opts.prune ?? false,
      });
      // Compared decoded, so a registry needing no repair keeps its own
      // formatting (and any comment a human added).
      if (JSON.stringify(next) === JSON.stringify(registry.exclusions))
        continue;
      vault.write(registry.ref, new Page(renderRegistry(next)));
      changed.push(registry.ref);
    }
  } finally {
    index.close();
  }
  return changed.sort();
}

/** The one fix that reads [FixOptions]: the others take a root and nothing
 * else, so `fix <slug> --prune` on them is an error rather than a silent
 * no-op. */
export const PruneFix = "consolidation-exclusions";

export const FIXES: Record<string, FixFn> = {
  "frontmatter-link-format": fixFrontmatterLinkFormat,
  "ingestion-source-integrity": fixIngestionSourceIntegrity,
  "missing-cross-references": fixMissingCrossReferences,
  "split-links": fixSplitLinks,
  "duplicate-frontmatter": fixDuplicateFrontmatter,
  [PruneFix]: fixConsolidationExclusions,
};
