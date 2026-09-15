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
      const detail =
        segmentCount === 2
          ? "at wiki/ root — not under any kind-folder"
          : `nested ${segmentCount - 3} level(s) below a kind-folder — must be a direct child`;
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
      if (/^\s*-\s+\[/.test(fmLines[i])) {
        unquotedLines.add(i); // 0-based to match link.line from iterLinks
        findings.push({
          pageRef: ref,
          detail: `unquoted markdown link in frontmatter: ${fmLines[i].trim()}`,
        });
      }
    }

    // Unencoded link destinations (skip lines already flagged as unquoted).
    for (const link of iterLinks(frontmatter)) {
      if (unquotedLines.has(link.line)) continue;
      const reencoded = percentEncode(link.decodedPath);
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
export async function fixFrontmatterLinkFormat(root: string): Promise<string[]> {
  const pages = new Vault(root).loadWikiPages();
  const changed: string[] = [];
  for (const [ref, text] of Object.entries(pages)) {
    const { frontmatter, hasFrontmatter, body } = splitFrontmatter(text);
    if (!hasFrontmatter || frontmatter === "") continue;

    // Pass 1: quote unquoted markdown links in YAML list items ("  - [Title](dest)")
    let fm = frontmatter
      .split("\n")
      .map((line) => {
        if (!/^\s*-\s+\[/.test(line)) return line;
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
    // Frontmatter edge links never carry genuine anchors, so a literal "#" in
    // the dest (which causes the parser to split path/anchor) is always a
    // filename character that needs %23 encoding — recombine and re-encode.
    const edits: Array<{ start: number; end: number; dest: string }> = [];
    for (const link of iterLinks(fm)) {
      const fullDecoded =
        link.decodedPath +
        (link.decodedAnchor ? "#" + link.decodedAnchor : "");
      const reencoded = percentEncode(fullDecoded);
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
export async function fixIngestionSourceIntegrity(root: string): Promise<string[]> {
  const pages = new Vault(root).loadWikiPages();
  const changed: string[] = [];
  for (const [ref, text] of Object.entries(pages)) {
    if (!ref.startsWith("wiki/sources/")) continue;
    const { frontmatter, hasFrontmatter, body } = splitFrontmatter(text);
    if (!hasFrontmatter) continue;
    if (/^raw_source\s*:/m.test(frontmatter)) continue;

    // Auto-fix only when exactly one raw/ link exists in the body
    const rawLinkRe = /\[[^\]]+\]\(\.\.\/\.\.\/raw\/[^)]+\)/g;
    const rawLinks = [...body.matchAll(rawLinkRe)];
    if (rawLinks.length !== 1) continue;

    const [m] = rawLinks;
    const newFm = frontmatter.trimEnd() + `\nraw_source: "${m[0]}"\n`;
    const newBody = body.slice(0, m.index!) + body.slice(m.index! + m[0].length);
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
export async function fixMissingCrossReferences(root: string): Promise<string[]> {
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
    const { frontmatter, hasFrontmatter, body, bodyOffset } = splitFrontmatter(text);
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
    let delta = 0; // offset shift from previous insertions
    let anyEdit = false;

    for (const [title, targetRef] of titleToRef) {
      if (targetRef === ref) continue;
      if (linkedRefs.has(targetRef)) continue;

      const searchIn = newBody;
      const idx = searchIn.indexOf(title);
      if (idx < 0) continue;

      // Skip if the mention falls inside an existing link span
      const adjustedSpans = linkSpans.map(([s, e]) => [s + delta, e + delta] as [number, number]);
      if (adjustedSpans.some(([s, e]) => idx >= s && idx + title.length <= e)) continue;

      // Skip if preceded by [ (already a link label) or backtick (code span)
      const ch = idx > 0 ? searchIn[idx - 1] : "";
      if (ch === "[" || ch === "`") continue;

      const relPath = path
        .relative(pageDir, targetRef)
        .split(path.sep)
        .join("/");
      const insertion = `[${title}](${percentEncode(relPath)})`;
      newBody =
        newBody.slice(0, idx) + insertion + newBody.slice(idx + title.length);
      delta += insertion.length - title.length;
      linkedRefs.add(targetRef);
      anyEdit = true;
    }

    if (!anyEdit) continue;
    const newText = hasFrontmatter ? `---\n${frontmatter}---\n${newBody}` : newBody;
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
