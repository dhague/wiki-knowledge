// Vault health checks for `enchiridion check <name>`. All async so staleSynthesis (git-backed) fits the same interface as the sync ones.

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
