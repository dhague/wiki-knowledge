// The deterministic half of a Consolidation assessment: read a cluster's
// members in full from one committed HEAD snapshot, and re-check that pin before
// a Consolidation writes (ADR-0028).

import { splitFrontmatter } from "./wikipage.js";
import { newPageRecord } from "./pagerecord.js";
import { semanticFingerprint } from "./fingerprint.js";
import type { PageFact } from "./searchindex.js";
import { VaultGit } from "./vaultgit.js";

/** One wiki page as a committed HEAD snapshot holds it. */
export interface HeadPage {
  pageRef: string;
  /** The blob's object ID at HEAD — what an exclusion and a plan pin. */
  blobOid: string;
  content: string;
  title: string;
  /** `null` when the text is not a readable page, so no assessment can use it. */
  fingerprint: string | null;
}

/** Every `wiki/**.md` page at HEAD, keyed by ref, with the commit holding them. */
export async function headPages(
  root: string,
): Promise<{ head: string; pages: Map<string, HeadPage> }> {
  const snapshot = await new VaultGit(root).committedPages("");
  const pages = new Map<string, HeadPage>();
  for (const change of snapshot.pages) {
    if (change.deleted) continue;
    let title = "";
    let fingerprint: string | null = null;
    try {
      const record = newPageRecord(change.pageRef, change.content);
      title = record.title;
      fingerprint = semanticFingerprint(
        record,
        splitFrontmatter(change.content).body,
      );
    } catch {
      // An unreadable page is still a page; the caller decides what that means.
    }
    pages.set(change.pageRef, {
      pageRef: change.pageRef,
      blobOid: change.oid,
      content: change.content,
      title,
      fingerprint,
    });
  }
  return { head: snapshot.head, pages };
}

/** The readable pages' registry-validation facts (ADR-0028). */
export function headPageFacts(
  pages: Map<string, HeadPage>,
): Map<string, PageFact> {
  const facts = new Map<string, PageFact>();
  for (const [ref, page] of pages) {
    if (page.fingerprint === null) continue;
    facts.set(ref, {
      pageRef: ref,
      blobOid: page.blobOid,
      fingerprint: page.fingerprint,
    });
  }
  return facts;
}

/** A member of a cluster as one committed snapshot holds it. */
export interface AssessedMember {
  page_ref: string;
  blob_oid: string;
  fingerprint: string;
  title: string;
  bytes: number;
  text: string;
}

/** One cluster's assessed input: the HEAD it was read at, and every member. */
export interface AssessedCluster {
  head: string;
  members: AssessedMember[];
}

/** A cluster could not be read from one committed snapshot. */
export class ErrAssess extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ErrAssess";
  }
}

/** Read every ref in full from HEAD, in the order given. Throws [ErrAssess]
 * naming the first ref that is not a readable committed page. */
export async function assessCluster(
  root: string,
  refs: string[],
): Promise<AssessedCluster> {
  const { head, pages } = await headPages(root);
  const members = refs.map((ref) => {
    const page = pages.get(ref);
    if (page === undefined) {
      throw new ErrAssess(
        `${ref} is not a committed page at HEAD — the cluster cannot be assessed from one snapshot`,
      );
    }
    if (page.fingerprint === null) {
      throw new ErrAssess(
        `${ref} could not be read at HEAD as a page — the cluster cannot be assessed`,
      );
    }
    return {
      page_ref: ref,
      blob_oid: page.blobOid,
      fingerprint: page.fingerprint,
      title: page.title,
      bytes: Buffer.byteLength(page.content, "utf8"),
      text: page.content,
    };
  });
  return { head, members };
}

/** The `assessed` block a `consolidate` plan pins: the snapshot the cluster was
 * read at, and each member's blob object ID. */
export interface PlanAssessment {
  head: string;
  members: Array<{ page_ref: string; blob_oid: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Decode a plan's optional `assessed` pin; a present non-object is refused. */
export function decodeAssessment(raw: unknown): PlanAssessment | null {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) {
    throw new Error('invalid plan JSON: "assessed" must be an object');
  }
  const head = typeof raw["head"] === "string" ? raw["head"] : "";
  const members = Array.isArray(raw["members"])
    ? raw["members"].map((entry) => {
        const member = isRecord(entry) ? entry : {};
        return {
          page_ref:
            typeof member["page_ref"] === "string" ? member["page_ref"] : "",
          blob_oid:
            typeof member["blob_oid"] === "string" ? member["blob_oid"] : "",
        };
      })
    : [];
  return { head, members };
}

/** Whether a plan's pinned snapshot still describes HEAD; [] when it holds. A
 * moved HEAD, a member that changed, and one no longer committed each mean the
 * assessment is stale, so the caller writes nothing. */
export async function assessmentErrors(
  assessed: PlanAssessment,
  consolidates: string[],
  root: string,
): Promise<string[]> {
  const snapshot = await headPages(root);
  if (assessed.head !== snapshot.head) {
    return [
      `the vault's HEAD moved since the cluster was assessed (assessed ${assessed.head || "(none)"}, now ${snapshot.head || "(none)"}); re-run against a fresh snapshot`,
    ];
  }
  const pinned = new Map(
    assessed.members.map((member) => [member.page_ref, member.blob_oid]),
  );
  const problems: string[] = [];
  for (const ref of new Set([...consolidates, ...pinned.keys()])) {
    const want = pinned.get(ref);
    const now = snapshot.pages.get(ref)?.blobOid;
    if (want === undefined) {
      problems.push(`${ref} is named by the plan but was not assessed`);
      continue;
    }
    if (now === undefined) {
      problems.push(`${ref} is no longer a committed page at HEAD`);
      continue;
    }
    if (now !== want) {
      problems.push(`${ref} changed since it was assessed`);
    }
  }
  if (problems.length > 0) {
    problems.push("re-run against a fresh snapshot");
  }
  return problems;
}
