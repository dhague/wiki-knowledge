// Consolidation exclusions: the committed `CONSOLIDATION_EXCLUSIONS.yaml` a
// declined cluster is remembered in, one per consolidatable kind-folder
// (ADR-0028). Pure text in, text out — callers own every filesystem and git
// read.

import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { PageFact } from "./searchindex.js";

/** The registry's fixed filename inside a consolidatable kind-folder. */
export const RegistryFilename = "CONSOLIDATION_EXCLUSIONS.yaml";

/** One page a declined cluster named, with the cached HEAD-blob facts that
 * identify the revision the user declined. */
export interface ExclusionMember {
  pageRef: string;
  blobOid: string;
  fingerprint: string;
}

/** One declined cluster: its member set, and why the user declined it. */
export interface Exclusion {
  /** Sorted by pageRef — the canonical order. */
  members: ExclusionMember[];
  reason: string;
}

/** One registry file: its decoded records, or the reason it could not be read
 * as a registry (`exclusions` is then empty — candidate reporting fails open). */
export interface Registry {
  /** Vault-relative ref of the YAML file. */
  ref: string;
  exclusions: Exclusion[];
  error: string | null;
}

/** The registry's vault-relative ref inside a kind-folder. */
export function registryRef(folder: string): string {
  return `wiki/${folder}/${RegistryFilename}`;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(
  value: Record<string, unknown>,
  key: string,
): string | null {
  const raw = value[key];
  return typeof raw === "string" && raw !== "" ? raw : null;
}

/** Decode one registry's text. Anything the schema rejects fails the *whole*
 * file open — a malformed registry must never suppress a candidate. */
export function parseRegistry(text: string): {
  exclusions: Exclusion[];
  error: string | null;
} {
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch (err) {
    return { exclusions: [], error: `not parseable as YAML: ${message(err)}` };
  }
  if (data === null || data === undefined)
    return { exclusions: [], error: null };
  if (!isRecord(data)) {
    return { exclusions: [], error: "the document is not a mapping" };
  }
  const rawExclusions = data["exclusions"];
  if (rawExclusions === undefined || rawExclusions === null) {
    return { exclusions: [], error: null };
  }
  if (!Array.isArray(rawExclusions)) {
    return { exclusions: [], error: "`exclusions` is not a list" };
  }

  const exclusions: Exclusion[] = [];
  for (let i = 0; i < rawExclusions.length; i++) {
    const where = `exclusions[${i}]`;
    const entry = rawExclusions[i];
    if (!isRecord(entry)) {
      return { exclusions: [], error: `${where} is not a mapping` };
    }
    const reason = stringField(entry, "reason");
    if (reason === null) {
      return {
        exclusions: [],
        error: `${where}.reason must be a non-empty string`,
      };
    }
    const rawMembers = entry["members"];
    if (!Array.isArray(rawMembers) || rawMembers.length === 0) {
      return {
        exclusions: [],
        error: `${where}.members must be a non-empty list`,
      };
    }
    const members: ExclusionMember[] = [];
    const seen = new Set<string>();
    for (let j = 0; j < rawMembers.length; j++) {
      const memberWhere = `${where}.members[${j}]`;
      const raw = rawMembers[j];
      if (!isRecord(raw)) {
        return { exclusions: [], error: `${memberWhere} is not a mapping` };
      }
      const pageRef = stringField(raw, "page_ref");
      const blobOid = stringField(raw, "blob_oid");
      const fingerprint = stringField(raw, "fingerprint");
      if (pageRef === null) {
        return {
          exclusions: [],
          error: `${memberWhere}.page_ref must be a non-empty string`,
        };
      }
      if (blobOid === null) {
        return {
          exclusions: [],
          error: `${memberWhere}.blob_oid must be a non-empty string`,
        };
      }
      if (fingerprint === null) {
        return {
          exclusions: [],
          error: `${memberWhere}.fingerprint must be a non-empty string`,
        };
      }
      if (seen.has(pageRef)) {
        return {
          exclusions: [],
          error: `${memberWhere}.page_ref ${pageRef} appears twice`,
        };
      }
      seen.add(pageRef);
      members.push({ pageRef, blobOid, fingerprint });
    }
    exclusions.push({ members: sortMembers(members), reason });
  }
  return { exclusions, error: null };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/** A plain YAML scalar is written bare; anything else is JSON-quoted, which is
 * also valid YAML. A `:` is safe bare unless a space follows it, so a ref,
 * oid or `sha256:` digest stays readable while a reason stays quoted. */
function scalar(value: string): string {
  return /^[A-Za-z0-9._/@+:-]+$/.test(value) ? value : JSON.stringify(value);
}

function sortMembers(members: ExclusionMember[]): ExclusionMember[] {
  return [...members].sort((a, b) => a.pageRef.localeCompare(b.pageRef));
}

/** The set key refs are ordered and matched by: sorted, NUL separated (NUL
 * cannot occur in a page ref). */
export function refSetKey(refs: string[]): string {
  return [...refs].sort().join("\u0000");
}

/** [refSetKey] over a record's members. */
export function memberSetKey(members: Array<{ pageRef: string }>): string {
  return refSetKey(members.map((m) => m.pageRef));
}

/** Canonical order: records by their member-set key then reason, so two records
 * naming one set have a stable order of their own; members by page ref. */
export function canonicalExclusions(exclusions: Exclusion[]): Exclusion[] {
  return [...exclusions]
    .map((e) => ({ members: sortMembers(e.members), reason: e.reason }))
    .sort(
      (a, b) =>
        memberSetKey(a.members).localeCompare(memberSetKey(b.members)) ||
        a.reason.localeCompare(b.reason),
    );
}

/** Render the registry's canonical YAML — the one spelling `exclusion add` and
 * `fix consolidation-exclusions` write. */
export function renderRegistry(exclusions: Exclusion[]): string {
  const canonical = canonicalExclusions(exclusions);
  if (canonical.length === 0) return "exclusions: []\n";
  const lines = ["exclusions:"];
  for (const exclusion of canonical) {
    exclusion.members.forEach((member, index) => {
      const head = index === 0 ? "  - members:" : "";
      if (head !== "") lines.push(head);
      lines.push(`      - page_ref: ${scalar(member.pageRef)}`);
      lines.push(`        blob_oid: ${scalar(member.blobOid)}`);
      lines.push(`        fingerprint: ${scalar(member.fingerprint)}`);
    });
    lines.push(`    reason: ${JSON.stringify(exclusion.reason)}`);
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// Validation against HEAD
// ---------------------------------------------------------------------------

/** One member read against the snapshot the index materialised. */
export interface MemberVerdict {
  member: ExclusionMember;
  /** The page's facts at HEAD, or null when the index holds no such page. */
  fact: PageFact | null;
  /** The cached revision still describes the page, by blob oid or fingerprint. */
  valid: boolean;
  /** Valid by fingerprint, but the cached blob oid is stale. */
  needsOidRefresh: boolean;
}

/** One record read against HEAD. */
export interface ResolvedExclusion {
  exclusion: Exclusion;
  verdicts: MemberVerdict[];
  /** Members still describing the page at HEAD. */
  validMembers: ExclusionMember[];
  /** Members whose page changed semantically — the exclusion no longer covers
   * them. */
  staleMembers: ExclusionMember[];
  /** Members whose page is absent from HEAD (deleted or never committed). */
  missingMembers: ExclusionMember[];
}

/** The two-tier rule: a matching blob oid is the fast path, a matching
 * fingerprint the fallback that also refreshes the cached oid. */
export function resolveExclusion(
  exclusion: Exclusion,
  facts: Map<string, PageFact>,
): ResolvedExclusion {
  const verdicts: MemberVerdict[] = exclusion.members.map((member) => {
    const fact = facts.get(member.pageRef) ?? null;
    if (fact === null) {
      return { member, fact, valid: false, needsOidRefresh: false };
    }
    if (fact.blobOid !== "" && fact.blobOid === member.blobOid) {
      return { member, fact, valid: true, needsOidRefresh: false };
    }
    if (fact.fingerprint !== "" && fact.fingerprint === member.fingerprint) {
      return { member, fact, valid: true, needsOidRefresh: true };
    }
    return { member, fact, valid: false, needsOidRefresh: false };
  });
  return {
    exclusion,
    verdicts,
    validMembers: verdicts.filter((v) => v.valid).map((v) => v.member),
    staleMembers: verdicts
      .filter((v) => !v.valid && v.fact !== null)
      .map((v) => v.member),
    missingMembers: verdicts
      .filter((v) => !v.valid && v.fact === null)
      .map((v) => v.member),
  };
}

/** Whether a cluster's member set is exactly an exclusion's *effective* set —
 * its members that still describe their page at HEAD, and the only shape that
 * suppresses (ADR-0028). */
export function suppressedBy(
  clusterRefs: string[],
  resolved: ResolvedExclusion[],
): ResolvedExclusion | null {
  const key = memberSetKey(clusterRefs.map((pageRef) => ({ pageRef })));
  for (const record of resolved) {
    if (record.validMembers.length < 2) continue;
    if (memberSetKey(record.validMembers) === key) return record;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Mechanical repair
// ---------------------------------------------------------------------------

/** Two records with the same member set whose reasons agree — the one kind of
 * duplicate that can be dropped without losing a human's words. */
function isSafeDuplicate(a: Exclusion, b: Exclusion): boolean {
  return (
    memberSetKey(a.members) === memberSetKey(b.members) && a.reason === b.reason
  );
}

/** A stable dedupe of [canonicalExclusions]' order: the first record of a safe
 * duplicate pair wins. */
function dedupeExclusions(exclusions: Exclusion[]): Exclusion[] {
  const out: Exclusion[] = [];
  for (const exclusion of canonicalExclusions(exclusions)) {
    if (out.some((kept) => isSafeDuplicate(kept, exclusion))) continue;
    out.push(exclusion);
  }
  return out;
}

/** The mechanically repairable half of the registry: refresh a cached blob oid
 * whose fingerprint still matches, drop safe duplicates, canonicalise. With
 * `prune`, stale members leave too, and a record left with fewer than two valid
 * members is deleted. */
export function refreshExclusions(
  exclusions: Exclusion[],
  facts: Map<string, PageFact>,
  opts: { prune: boolean } = { prune: false },
): Exclusion[] {
  const out: Exclusion[] = [];
  for (const exclusion of exclusions) {
    const resolved = resolveExclusion(exclusion, facts);
    const members: ExclusionMember[] = [];
    for (const verdict of resolved.verdicts) {
      if (verdict.valid) {
        members.push({
          ...verdict.member,
          blobOid: verdict.fact?.blobOid || verdict.member.blobOid,
        });
        continue;
      }
      // A member that no longer holds keeps its stale cache: rewriting it would
      // re-validate an exclusion the page has outgrown.
      if (!opts.prune) members.push(verdict.member);
    }
    if (opts.prune && resolved.validMembers.length < 2) continue;
    out.push({ members, reason: exclusion.reason });
  }
  return dedupeExclusions(out);
}

/** Record a declined cluster: an exact member-set match is replaced, anything
 * else is appended. */
export function upsertExclusion(
  exclusions: Exclusion[],
  added: Exclusion,
): Exclusion[] {
  const key = memberSetKey(added.members);
  return canonicalExclusions([
    ...exclusions.filter((e) => memberSetKey(e.members) !== key),
    added,
  ]);
}

/** Follow a `<old> → <new>` move through one registry's text: within a kind the
 * moved page's reference follows it, across kinds it leaves the record (a
 * cluster never mixes kinds). `freshFingerprint` re-reads a member the move may
 * have re-spelled a link in. Null when nothing changed; a move never repairs a
 * malformed registry. */
export function moveInRegistry(
  text: string,
  oldRef: string,
  newRef: string,
  sameFolder: boolean,
  freshFingerprint?: (pageRef: string) => string | null,
): string | null {
  const { exclusions, error } = parseRegistry(text);
  if (error !== null) return null;
  const refresh = (member: ExclusionMember): ExclusionMember => {
    const fingerprint = freshFingerprint?.(member.pageRef);
    return fingerprint == null || fingerprint === member.fingerprint
      ? member
      : { ...member, fingerprint };
  };
  let changed = false;
  const out: Exclusion[] = [];
  for (const exclusion of exclusions) {
    const members: ExclusionMember[] = [];
    for (const member of exclusion.members) {
      if (member.pageRef !== oldRef) {
        members.push(refresh(member));
        continue;
      }
      changed = true;
      if (sameFolder) members.push(refresh({ ...member, pageRef: newRef }));
    }
    if (members.length < 2) continue;
    out.push({ members, reason: exclusion.reason });
  }
  if (!changed) return null;
  // Compared decoded, so a move that leaves the record set identical (the same
  // ref) rewrites nothing and keeps the file's own formatting.
  const before = JSON.stringify(canonicalExclusions(exclusions));
  if (JSON.stringify(canonicalExclusions(out)) === before) return null;
  return renderRegistry(out);
}

/** The kind-folder segment of a vault-relative page ref. */
export function folderOf(pageRef: string): string {
  return path.posix.basename(path.posix.dirname(pageRef));
}
