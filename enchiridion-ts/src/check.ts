// Vault health checks for `enchiridion check <name>` and auto-fixes for `enchiridion fix <name>`.
// All async so staleSynthesis (git-backed) fits the same interface as the sync ones.

import fs from "node:fs";
import path from "node:path";
import { Vault } from "./vault.js";
import { VaultGit } from "./vaultgit.js";
import {
  splitFrontmatter,
  iterLinks,
  percentEncode,
  resolveLinkDest,
  encodeDest,
} from "./wikipage.js";
import { isPageRef } from "./pagepredicate.js";

/** One problem found by a check. */
export interface Finding {
  pageRef: string;
  detail: string;
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
// The eight mechanical checks
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
  const pages = new Vault(root).pages();
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

// Check 3 — operates on raw text, not parsed records: malformed YAML that would choke the record parser is what this check surfaces.
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
  }
  return findings;
}

/** Check 4 — synthesis pages whose last git commit is more than 30 days ago. */
export async function staleSynthesis(root: string): Promise<Finding[]> {
  const pages = new Vault(root).pages();
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
  const pages = new Vault(root).pages();
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
  const pagesWithText = new Vault(root).pagesWithText();
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
  const pagesWithText = new Vault(root).pagesWithText();
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
  const pagesWithText = new Vault(root).pagesWithText();
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
// Check registry
// ---------------------------------------------------------------------------

export const CHECKS: Record<string, (root: string) => Promise<Finding[]>> = {
  "kind-folder-conformance": kindFolderConformance,
  "ingestion-source-integrity": ingestionSourceIntegrity,
  "frontmatter-link-format": frontmatterLinkFormat,
  "stale-synthesis": staleSynthesis,
  "missing-volatility-source-date": missingVolatilitySourceDate,
  "unresolved-supersession": unresolvedSupersession,
  "contradiction-callouts": contradictionCallouts,
  orphans,
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

// Fix for check 11 (unambiguous case) — insert relative markdown links for exact title
// matches that appear in body text without an existing link to that page.
export async function fixMissingCrossReferences(
  root: string,
): Promise<string[]> {
  const pagesWithText = new Vault(root).pagesWithText();

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

export const FIXES: Record<string, (root: string) => Promise<string[]>> = {
  "frontmatter-link-format": fixFrontmatterLinkFormat,
  "ingestion-source-integrity": fixIngestionSourceIntegrity,
  "missing-cross-references": fixMissingCrossReferences,
};
