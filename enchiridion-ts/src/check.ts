// Vault health checks for `enchiridion check <name>` and auto-fixes for `enchiridion fix <name>`.
// All async so staleSynthesis (git-backed) fits the same interface as the sync ones.

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
import { malformedEdges } from "./pagerecord.js";

/** Options the CLI threads into a check. Only `concept-fragmentation` reads
 * `minSimilarity`; every other check ignores the bag. */
export interface CheckOptions {
  /** The Consolidation-vs-link cutoff, in [0, 1]. */
  minSimilarity?: number;
}

/** One problem found by a check. */
export interface Finding {
  pageRef: string;
  detail: string;
  /** Structured payload, set only by checks that report a proposal spanning
   * several pages rather than one page's problem. `concept-fragmentation`
   * sets it; the JSONL consumer reads it, the text renderer ignores it. */
  cluster?: FragmentationCluster;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Walk wiki/ for ALL .md files including those that fail isPageRef — surfaces structural errors enumeratePageRefs silently skips. */
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

/**
 * A YAML list item whose value begins with a bare `[` — an unquoted markdown
 * link, which YAML reads as a flow sequence rather than as the link string the
 * schema wants. The one test decides both what check 3 reports and what its
 * fix quotes, so the two cannot drift apart.
 */
const UNQUOTED_LIST_LINK_RE = /^\s*-\s+\[/;

/**
 * The sources kind-folder, and the route from one of its pages down into the
 * `raw/` inbox.
 *
 * Both are fixed by the plugin (ADR-0008), and the fix below is scoped to
 * `wiki/sources/` pages — which is the *only* reason `../../raw/` is the right
 * prefix for a body link found there. Deriving the prefix from the folder
 * keeps that coupling in one expression instead of leaving a hard-coded
 * `../../raw/` in a regex that reads as general when it is not.
 */
const SOURCES_DIR = "wiki/sources";
const RAW_HREF_PREFIX = path.posix.relative(SOURCES_DIR, "raw");

/** Escape a literal string for use inside a RegExp source. */
function regexEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// The nine mechanical checks
// ---------------------------------------------------------------------------

// Check 1 — any existing folder under wiki/ is a valid kind-folder (ADR-0020); only structural violations (wiki root or nested) are flagged.
export async function kindFolderConformance(root: string): Promise<Finding[]> {
  const findings: Finding[] = [];
  for (const ref of walkAllMd(root)) {
    const filename = ref.split("/").at(-1)!;
    if (filename === "KIND.md") continue;
    if (ref === "wiki/_index.md") continue;
    if (!isPageRef(ref)) {
      const segmentCount = ref.split("/").length; // "wiki/foo.md"=2, "wiki/k/sub/p.md"=4
      const nestingDepth = segmentCount - 3; // levels below kind-folder (0 = direct child, >0 = nested)
      const detail =
        segmentCount === 2
          ? "at wiki/ root — not under any kind-folder"
          : `nested ${nestingDepth} level(s) below a kind-folder — must be a direct child`;
      findings.push({ pageRef: ref, detail });
    }
  }
  return findings;
}

/** Check 2 — every wiki/sources/ page must carry raw_source pointing into raw/. */
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

// Check 3 — operates on raw text, not parsed records: frontmatter the record parser refuses — an unquoted link, an edge value that is not a markdown link — is what this check surfaces.
export async function frontmatterLinkFormat(root: string): Promise<Finding[]> {
  const pages = new Vault(root).loadWikiPages();
  const findings: Finding[] = [];
  for (const [ref, text] of Object.entries(pages)) {
    const { frontmatter, hasFrontmatter } = splitFrontmatter(text);
    if (!hasFrontmatter || frontmatter === "") continue;

    // Unquoted YAML list items: lines like "  - [Title](dest)" where the
    // value begins with `[` rather than `"[`.
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

    // Unencoded link destinations (skip lines already flagged as unquoted).
    // A frontmatter relationship link is the same link form as a body link,
    // anchors included (wiki-conventions, "Links"): `#` introducing an anchor
    // is literal, and only a filename's own `#` — decoded from `%23` — needs
    // encoding. So path and anchor are re-encoded through the one seam that
    // knows that, never by recombining them first (#492 §1).
    for (const link of iterLinks(frontmatter)) {
      if (unquotedLines.has(link.line)) continue;
      const reencoded = encodeDest(link.decodedPath, link.decodedAnchor);
      if (link.dest !== reencoded)
        findings.push({
          pageRef: ref,
          detail: `unencoded destination in frontmatter link: "${link.dest}" (should be "${reencoded}")`,
        });
    }

    // Edge values the schema refuses — a bare path, a non-string entry
    // (#549). Valid YAML, so the raw-text scans above go blind to it, yet the
    // record parser raises on it: without this scan the abort was the only
    // signal the tool gave anywhere.
    for (const detail of malformedEdges(text))
      findings.push({ pageRef: ref, detail });
  }
  return findings;
}

/** Check 4 — synthesis pages whose last git commit is more than 30 days ago. */
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

/** Check 5 — pages missing volatility or source_date degrade search ranking and temporal filtering. */
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

// Check 6 — contradicts + no supersedes + no active callout: resolved contradiction with supersession unrecorded.
// Pages with contradicts + active callout are live contradictions (check 7's domain), not a violation here.
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

/** Check 7 — pages with an active `> [!warning] Contradiction` callout in the body. */
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

/** Check 8 — pages with zero inbound links from other wiki pages (body or frontmatter). */
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
// Check 9 — splitLinks
// ---------------------------------------------------------------------------

/**
 * One raw region of a frontmatter link that a line break splits, and what a
 * conforming YAML reader makes of the same bytes.
 */
interface FrontmatterSplit {
  /** source offsets into the frontmatter block */
  start: number;
  end: number;
  /** the value a YAML reader reads for that region — what a fix splices in */
  joined: string;
  kind: "destination" | "label" | "boundary";
  /** the link's first line, 1-based in the file */
  line: number;
}

/**
 * The source spans of every double-quoted scalar in a frontmatter block.
 *
 * This is what keeps the check inside the one shape it may act on. Raw text
 * cannot tell a fold in a quoted scalar from a `\` that is *content* in a
 * block scalar (`related: |`), nor from a single-quoted scalar, where a
 * backslash is literal and a line break folds to a space rather than joining
 * with nothing — so the parser answers which scalar a link sits in, and
 * nothing is guessed from the bytes. A block that does not parse yields no
 * spans: nothing in it is reported, and nothing in it is joined.
 */
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

/** Report whether the raw span [start, end) sits inside one of spans. */
function insideAny(
  spans: Array<[number, number]>,
  start: number,
  end: number,
): boolean {
  return spans.some(([s, e]) => s <= start && end <= e);
}

/** Join a label the way YAML folds one: a space per line break, with the
 * indentation and any space before the break dropped. */
function joinLabel(raw: string): string {
  return raw.replace(/[ \t]*\r?\n[ \t]*/g, " ");
}

/**
 * Every line-break split in one frontmatter block's double-quoted link
 * scalars, in source order.
 *
 * The three shapes are told apart by *where* the break falls in the link, not
 * by where the link lives: a break inside the destination joins with nothing
 * (the backslash and the continuation's indentation are not content), a break
 * inside the label joins with a single space (YAML folds one there), and a
 * break at the label/destination boundary joins with nothing (YAML's escaped
 * line continuation). One enumeration decides both what [splitLinks] reports
 * and what [fixSplitLinks] splices, so the two cannot drift apart.
 */
function frontmatterSplits(frontmatter: string): FrontmatterSplit[] {
  const spans = doubleQuotedSpans(frontmatter);
  const splits: FrontmatterSplit[] = [];
  for (const link of iterLinks(frontmatter)) {
    // The link's own first line. The block's own line 0 is the file's line 2,
    // since `---` opens it on line 1.
    const line = link.line + 2;

    // Source order is label, boundary, destination — each region opens after
    // the one before it.
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
        // An escaped continuation drops the backslash, the break and the next
        // line's indent, so `"]\⏎  ("` reads as `"]("`.
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
        // iterLinks joins escaped line breaks out of the destination, so its
        // `dest` *is* the joined value — a fold is spliced as it is read.
        joined: link.dest,
        kind: "destination",
        line,
      });
    }
  }
  return splits;
}

/**
 * A destination run left open at the end of a line: `](` followed by the start
 * of a destination — no whitespace, no closing paren — and then the line ends.
 * The same characters a CommonMark destination is made of, so the run is
 * exactly the part of one that fits on this line.
 */
const OPEN_DEST_RE = /\]\(([^\s)]+)$/;

/**
 * The line that finishes a split destination: the run picks up at column zero
 * and closes with the `)`.
 *
 * A continuation opening with a quote, `(` or `)` is not one: a title may
 * follow a line ending, and so may the destination's own close, so
 * `[T](path.md` / `"title")` is a legal link and must not read as a split.
 */
const DEST_CONTINUATION_RE = /^[^\s"'()][^\s)]*\)/;

/**
 * Body destinations split across a line break — the fourth shape, and the one
 * no fix may touch.
 *
 * This split is the crux of the check: the same bytes mean different things in
 * the two halves of a page. A `\`-continuation in frontmatter is a YAML fold,
 * one value spelled on two lines; in a body it is a CommonMark hard line
 * break, which leaves `[T](path` and `.md)` as literal text — not a link at
 * all, so [iterLinks] never sees it and `vault move` never rewrites it.
 *
 * Lines inside code blocks are skipped, as [iterLinks] skips them: a split
 * there is not a link either, and no reader resolves it.
 */
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
 * Check 9 — no link is split across lines.
 *
 * Four shapes, one vocabulary (`wiki-conventions`, "Links";
 * docs/adr/0024-emitted-lines-are-not-folded.md):
 *
 *   1. a destination fold — a YAML escaped line break inside a frontmatter
 *      link scalar, the writer's mid-token break before #502;
 *   2. a label fold — a plain newline inside a quoted frontmatter link scalar,
 *      which YAML folds to a space;
 *   3. a boundary fold — a YAML escaped line break between the label's `]` and
 *      the destination's `(`, which YAML resolves with nothing (#550);
 *   4. a body almost-link — a destination broken across a line break in a
 *      body, which CommonMark does not read as a link at all.
 *
 * Shapes 1, 2 and 3 are auto-fixed by [fixSplitLinks], each join
 * semantics-preserving; shape 4 is reported only, because a break after a
 * destination is legal markdown and joining on sight can silently repoint the
 * link. Nothing is reported outside a double-quoted scalar, where raw text
 * cannot tell a fold from content.
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
// Check 10 — conceptFragmentation
// ---------------------------------------------------------------------------

/**
 * Default `--min-similarity`: the bar at or above which two pages are one
 * concept (a Consolidation) rather than two merely-related ones (a link, owned
 * by check 12). One number, so the two checks partition.
 */
export const DefaultMinSimilarity = 0.5;

/** Kinds fragmentation detection never considers: their one-per-thing or
 * one-per-artifact identity forbids consolidation (#454, ADR-0021). */
const NonConsolidatableKinds = ["entity", "source", "synthesis"];

/** Cap on the FTS5 title hits one page may contribute as candidates. A title
 * word common enough to blow past this is not an identity signal anyway. */
const TitleMatchLimit = 200;

/** One member of a candidate cluster, as the proposal reports it. */
export interface ClusterMember {
  pageRef: string;
  /** UTF-8 byte length of the page's committed text at HEAD. */
  bytes: number;
  /** Inbound links from other committed pages. */
  inbound: number;
}

/** The structured payload a `concept-fragmentation` finding carries — the whole
 * proposal, not just a per-page problem. */
export interface FragmentationCluster {
  members: ClusterMember[];
  /** The signals the members share — why they were clustered. */
  basis: { tags: string[]; titleTokens: string[] };
  /** Weakest pairwise similarity holding the cluster together, in [0, 1] —
   * the transitive closure can join pairs that are individually below the
   * bar, and this is how far below the cluster dips. */
  similarity: number;
  /** The member with the most inbound links, largest body on a tie, then
   * pageRef. A hint only: the Consolidation step may override it. */
  suggestedSurvivor: string;
}

/** Title words that carry no identity signal on their own. One-character
 * words are dropped by length, but stay listed so the set reads as the whole
 * rule. */
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

/**
 * The significant words of a title: lowercased `[a-z0-9]+`, stopwords and
 * one-character tokens dropped. A set, because similarity is over *which*
 * signals two pages share, not how often each appears.
 */
export function titleTokens(title: string): Set<string> {
  const tokens = new Set<string>();
  for (const word of title.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (word.length > 1 && !TitleStopwords.has(word)) tokens.add(word);
  }
  return tokens;
}

/** The two signal sets a page contributes to fragmentation similarity. */
interface Signals {
  tags: Set<string>;
  titleTokens: Set<string>;
}

/** The values both sets hold, sorted — the basis a cluster reports. */
function intersection(a: Set<string>, b: Set<string>): string[] {
  const shared: string[] = [];
  for (const value of a) if (b.has(value)) shared.push(value);
  return shared.sort();
}

/**
 * Combined Jaccard over both signals: shared tags plus shared title words,
 * over the union of the two pages' tags and title words.
 *
 * One ratio rather than a rule per signal, because a shared tag and a shared
 * title word are each one piece of evidence that two pages are the same
 * concept — counting them in the same numerator lets a strongly-tagged stub
 * pair with a larger page whose title only partly overlaps (user story 3)
 * without a second threshold. 0 when the two share no vocabulary at all.
 */
export function similarity(a: Signals, b: Signals): number {
  const sharedTags = intersection(a.tags, b.tags).length;
  const sharedTitle = intersection(a.titleTokens, b.titleTokens).length;
  const unionTags = a.tags.size + b.tags.size - sharedTags;
  const unionTitle = a.titleTokens.size + b.titleTokens.size - sharedTitle;
  const union = unionTags + unionTitle;
  return union === 0 ? 0 : (sharedTags + sharedTitle) / union;
}

/** An FTS5 MATCH expression scoped to the indexed `title` column, OR-joined
 * from the page's own significant title words. Raw, like `discover.orQuery`:
 * an AND of a whole title demands every word be present and finds nothing. */
function titleMatch(title: string): string {
  const words = [...titleTokens(title)];
  if (words.length === 0) return "";
  return `{title} : (${words.map((w) => `"${w}"`).join(" OR ")})`;
}

/** Inbound link count per page ref across one HEAD snapshot, counting only
 * links from *other* pages to pages the snapshot holds — check 8's rule. */
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

/** The one-line, human-readable form of a cluster — what the text renderer
 * prints and the report relays. The structured detail rides in `cluster`. */
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
 * Check 10 — concept fragmentation (#452/#454, ADR-0021).
 *
 * Finds clusters of small, closely-related concept (and custom-kind) pages
 * that would read better as one page with sections, and proposes a
 * Consolidation per cluster: a confirm-first, lossless merge. This check only
 * *surfaces* candidates — the judgment that a cluster truly consolidates, and
 * the merged body, belong to the Sonnet `/wiki-ingest` flow it routes to.
 *
 * Candidate generation is ADR-0021's pair: a SQL self-join over `page_tag`
 * (strongest shared-tag count first) unioned with an FTS5 `MATCH` on the
 * indexed titles. Both halves read the index — a view of HEAD (ADR-0015) — so
 * an uncommitted fragmented draft is invisible until committed, which the
 * ticket's user story 15 asks for. Each surviving pair is scored by
 * [similarity] against `minSimilarity`; pairs below the bar are left to check
 * 12 (`missing-cross-references`), which renders them as a typed edge.
 *
 * `entity`, `source` and `synthesis` pages are excluded: their one-per-thing
 * or one-per-artifact identity forbids consolidation.
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

    // Candidate pairs: the union of the two generators, deduplicated by an
    // ordered key so a pair found by both is scored once.
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
          // Supersession is not a reason to skip a page here: a superseded
          // page is still a page, and the tag self-join does not skip it
          // either — the two generators must see the same scope.
          includeSuperseded: true,
          limit: TitleMatchLimit,
        });
        for (const hit of hits) addPair(page.pageRef, hit.pageRef);
      }
    }

    // Score every candidate, keep the pairs at or above the bar, and union
    // them into clusters.
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
      // Path compression — the clusters are small, but a long transitive
      // chain would otherwise re-walk the same spine per lookup.
      for (const node of path) parent.set(node, cur);
      return cur;
    };
    const union = (a: string, b: string): void => {
      for (const ref of [a, b]) if (!parent.has(ref)) parent.set(ref, ref);
      const rootA = find(a);
      const rootB = find(b);
      if (rootA === rootB) return;
      // Smaller ref wins, so the root — and therefore cluster order — does
      // not depend on the order pairs happened to be visited.
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

    // Sizes and inbound counts come from HEAD too, so the proposal describes
    // the same committed pages the index scored (ADR-0015).
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

/** A check: its vault root, plus the optional options bag the CLI threads
 * through. Only `concept-fragmentation` reads anything from it today. */
export type CheckFn = (root: string, opts?: CheckOptions) => Promise<Finding[]>;

export const CHECKS: Record<string, CheckFn> = {
  "kind-folder-conformance": kindFolderConformance,
  "ingestion-source-integrity": ingestionSourceIntegrity,
  "frontmatter-link-format": frontmatterLinkFormat,
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

// Fix for check 3 — apply quoting and encoding corrections to frontmatter links in place.
export async function fixFrontmatterLinkFormat(
  root: string,
): Promise<string[]> {
  const pages = new Vault(root).loadWikiPages();
  const changed: string[] = [];
  for (const [ref, text] of Object.entries(pages)) {
    const { frontmatter, hasFrontmatter, body } = splitFrontmatter(text);
    if (!hasFrontmatter || frontmatter === "") continue;

    // Pass 1: quote unquoted markdown links in YAML list items ("  - [Title](dest)")
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

    // Pass 2: re-encode link destinations in the (now-quoted) frontmatter text.
    // Frontmatter relationships use the same link form as body links, anchors
    // included, so a destination carrying a heading fragment keeps it: the
    // path and the anchor are re-encoded separately by the one seam that owns
    // the rule (#492 §1). Recombining them first — the shape this replaced —
    // encoded the anchor's own `#` and rewrote a working
    // `../concepts/caching.md#ttl` into a dangling `…caching.md%23ttl`.
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

// Fix for check 2 — move the one unambiguous raw/ body link to raw_source: frontmatter.
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

    // Auto-fix only when exactly one raw/ link exists in the body. The prefix
    // is the route from *this* folder into `raw/` — see [RAW_HREF_PREFIX].
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

// Fix for check 12 (unambiguous case) — insert relative markdown links for exact title
// matches that appear in body text without an existing link to that page.
export async function fixMissingCrossReferences(
  root: string,
): Promise<string[]> {
  const pagesWithText = new Vault(root).pagesWithText({
    skipMalformedEdges: true,
  });

  // Build title → ref map; drop titles shared by multiple pages (ambiguous)
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

    // Collect refs already linked from this body
    const linkedRefs = new Set<string>();
    // Collect body link spans to detect "already inside a link"
    const linkSpans: Array<[number, number]> = [];
    for (const link of iterLinks(body)) {
      linkedRefs.add(resolveLinkDest(link.decodedPath, pageDir));
      // Estimate full link span: scan back from dest start to find opening [
      let spanStart = link.start - 1; // at least the ( character
      while (spanStart > 0 && body[spanStart] !== "[") spanStart--;
      linkSpans.push([spanStart, link.end + 1]); // +1 to include closing )
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

      // Shift spans after the insertion point and add the new span
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

// Fix for check 9 — join the three frontmatter shapes in place. Body splits
// are never joined (a break after a destination is legal markdown, so a join
// on sight can silently repoint the link); they stay a report-only finding.
export async function fixSplitLinks(root: string): Promise<string[]> {
  const pages = new Vault(root).loadWikiPages();
  const changed: string[] = [];
  for (const [ref, text] of Object.entries(pages)) {
    const { frontmatter, hasFrontmatter, body } = splitFrontmatter(text);
    if (!hasFrontmatter || frontmatter === "") continue;

    const splits = frontmatterSplits(frontmatter);
    if (splits.length === 0) continue;

    // Splice the raw frontmatter text, back-to-front by source offset, so
    // every untouched byte survives — key order, quote styles and spacing
    // alike (ADR-0012's relaxed round-trip allows only the join itself to
    // differ). Joining with the reader's own value is what makes each edit
    // semantics-preserving: nothing but the fold's bytes move.
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
