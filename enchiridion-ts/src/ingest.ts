/**
 * ingest — the IngestPlan schema and its single-call executor. Plan in, the
 * commit SHA and the refs it wrote out.
 *
 * A [Plan] is the decided outcome of an ingestion: which pages to create or
 * update, with what frontmatter and typed edges. Chunking and overlap
 * classification are agent judgment; the mechanics downstream of that decision
 * live here.
 *
 * A page `summary` is one line, at or under [SummaryWordGuideline] words: it is
 * what retrieval judges a candidate by before reading the body.
 *
 * A plan names link targets by vault-relative page reference only: `edges` and
 * `supersedes` hold paths like `wiki/concepts/foo.md`, never composed
 * `[Title](../dest.md)` strings. Composing the link (title lookup, `../`
 * relativisation, percent-encoding, YAML quoting) is this module's job. The two
 * frontmatter maps are each other's fence: a typed edge belongs under `edges`
 * and is refused on a `frontmatter` map, while a `frontmatter` map takes only
 * the page's own keys plus the `raw_source` sentinel below. The `raw_source`
 * boolean sentinel works the same way as an edge:
 * `frontmatter: {"raw_source": true}` marks the page as the stub for [Plan.raw]
 * and the link is composed from it. [Plan.raw] itself is never renamed or moved
 * — the file keeps its name forever, and the link destination is
 * percent-encoded rather than the file sanitized. Body links are re-encoded on
 * write by [normalizeBodyLinks]. A plan may instead name `raw_source` directly
 * in `edges` — the single-link key — which is how a Consolidation survivor
 * carries forward an absorbed page's `raw_source` when [Plan.raw] is unset.
 *
 * `action` is one of `ingest` (the default), `synthesize`, or `consolidate` —
 * [PlanActions], and any other value is refused with the set named. `synthesize`
 * is wiki-ask's confirmed synthesis save: one `create` of kind `synthesis`, with
 * `source` edges and no raw artifact. `consolidate` (CONTEXT.md, Consolidation;
 * ADR-0021): one survivor absorbs the pages `consolidates` names, each absorbed
 * body becoming a section of the survivor's authored body, every inbound link
 * repointed at the survivor ([Vault.consolidate]), the absorbed pages deleted
 * rather than marked `superseded`, and one commit. `plan.raw` stays unset — a
 * Consolidation is sourced from pages, not an artifact. Losslessness is
 * mechanical: validation, and the executor again immediately before the delete,
 * refuses a survivor body that no longer reads an absorbed page's content as
 * one unbroken run of top-level markdown blocks, and — for an `update`
 * survivor — the survivor's own former body; it likewise refuses frontmatter
 * that drops an absorbed edge target or tag, or a `volatility` more stable than
 * the cluster's most volatile member (ADR-0031). What separates content from
 * presentation is [bodycontent]'s, stated there once (ADR-0030).
 *
 * A `consolidate` plan must pin the snapshot the cluster was assessed at —
 * `"assessed": {"head": "<sha>", "members": [{"page_ref", "blob_oid"}]}` — and
 * the `ingest` command refuses to run it once HEAD or any assessed member has
 * moved, because the merged body was authored against that snapshot. Every ref
 * in `consolidates` must be named there.
 *
 * Pipeline: [resolve] -> [Resolved.validate] -> [Resolved.execute] -> derive a
 * [commit.Manifest] -> commit. [resolve] is the single place placement,
 * frontmatter projection and edge/`raw_source` link composition happen;
 * validation reads only resolved facts and execution writes only resolved
 * pages, so the checked plan and the written plan cannot diverge. Resolve is
 * pure apart from vault reads. Validation runs entirely before any write —
 * shape (required fields, valid op, a `frontmatter` key within
 * [FrontmatterKeys] and no edge key on that map, no edge pointing at its own
 * page) then semantic (an update's pageRef exists, a create's target does not
 * yet, every edge target resolves to a page on disk or created by this same
 * plan, no `source` edge joins two `source` pages, and
 * [chainofevidence.check] holds). The chain check is a courtesy;
 * [commit.commit] re-runs it as the hard gate.
 *
 * Two frontmatter fields are this module's to guarantee, not the agent's to
 * forget. A page omitting `source_date` inherits the plan's top-level
 * [Plan.source_date] — the document's own date, not today's — so a plan carrying
 * a date cannot write a page the `missing-volatility-source-date` check reports;
 * a page's own value (or, on an update, the one already on disk) wins, and a
 * plan without a date inherits nothing. `volatility` is authored judgment that
 * cannot be derived, so validation requires it — within [Volatilities] — on
 * every `create` and on any `update` that supplies a `frontmatter` map; a
 * body-only update leaves the existing block alone.
 *
 * An edge label is its target's `title`: a non-empty title on one of this plan's
 * own pages wins, so a corrected title propagates to every link the plan writes;
 * otherwise the on-disk title is read, and failing that the filename. An empty
 * plan title is no title, never a decision — see [resolveTitle]. `raw_source` is
 * the exception: its label is the artifact's filename by design.
 *
 * No rollback on failure, deliberately: a page written before a later step fails
 * stays on disk, uncommitted. Every write is idempotent, so re-running the plan
 * after fixing the cause is safe.
 */

import fs from "node:fs";
import path from "node:path";
import { Page, splitFrontmatter } from "./frontmatter.js";
import { canonicalizeLinkTargets } from "./moveplan.js";
import { normalizeBodyLinks } from "./wikipage.js";
import { composeEdgeLink } from "./pageedge.js";
import {
  path as placePath,
  emptySlugRefusal,
  Kinds,
  KindFolders,
} from "./place.js";
import { Vault } from "./vault.js";
import { kindForFolder } from "./kindmeta.js";
import { check as checkChainOfEvidence } from "./chainofevidence.js";
import { commit, type Git, type Supersession } from "./commit.js";
import { CANONICAL_DATE_FORMAT, parseSourceDate } from "./sourcedate.js";
import { isPageRef } from "./pagepredicate.js";
import {
  EdgeKeys,
  Volatilities,
  edgeTargets,
  newPageRecord,
  isSingleLinkEdgeKey,
  type PageRecord,
} from "./pagerecord.js";
import { decodeAssessment, type PlanAssessment } from "./assess.js";
import {
  bodyBlocks,
  firstUnmatchedBlock,
  type BodyBlock,
} from "./bodycontent.js";

/** Windows' 255-char path limit, measured against root plus vault-relative path. */
export const MaxPathLength = 255;

/** The `summary` length the plan schema asks for, in words — a guideline the
 * skill prose restates and `skills.test.ts` fences to this value. */
export const SummaryWordGuideline = 20;

export const OpCreate = "create";
export const OpUpdate = "update";

/** What a plan's `frontmatter` map may name: the page's own keys plus the
 * `raw_source` sentinel. An edge key is refused, pointing at `edges`. */
const FrontmatterKeys: string[] = [
  "title",
  "summary",
  "tags",
  "source_date",
  "volatility",
  "raw_source",
];

export const ActionIngest = "ingest";
export const ActionSynthesize = "synthesize";

/** The plan verb whose one page absorbs the pages `consolidates` names (ADR-0021). */
export const ActionConsolidate = "consolidate";

/** Every `action` a plan may declare; anything else is refused, naming this set.
 * [ActionIngest] is the default when a plan omits `action`. */
export const PlanActions = [
  ActionIngest,
  ActionSynthesize,
  ActionConsolidate,
] as const;

/** Whether [action] is one the validator accepts. A plan's raw action string is
 * untrusted until [Resolved.validate] has passed it. */
export function isPlanAction(action: string): boolean {
  return (PlanActions as readonly string[]).includes(action);
}

/** A plan failed validation; the message lists every problem found, not the first. */
export class ErrPlan extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ErrPlan";
  }
}

/** A JSON object that remembers its key order: plain objects iterate in a
 * deterministic but not plan order, which would make ingested pages vary run to
 * run (ADR-0012 relaxes byte-identical round-tripping, not determinism). */
export class OrderedMap<V> {
  readonly keys: string[] = [];
  readonly values = new Map<string, V>();

  get(key: string): { value: V | undefined; ok: boolean } {
    if (!this.values.has(key)) return { value: undefined, ok: false };
    return { value: this.values.get(key), ok: true };
  }

  length(): number {
    return this.keys.length;
  }

  *all(): Generator<[string, V]> {
    for (const key of this.keys) {
      yield [key, this.values.get(key) as V];
    }
  }

  private set(key: string, value: V): void {
    if (!this.values.has(key)) this.keys.push(key);
    this.values.set(key, value);
  }

  /** Decode a JSON object recording key order; a duplicate keeps its first
   * position and takes the last value. */
  static decode<V>(data: unknown): OrderedMap<V> {
    const m = new OrderedMap<V>();
    if (data === null || typeof data !== "object" || Array.isArray(data)) {
      // an explicit null is absent, not an error
      return m;
    }
    for (const key of Object.keys(data as Record<string, unknown>)) {
      m.set(key, (data as Record<string, unknown>)[key] as V);
    }
    return m;
  }
}

export interface PagePlan {
  op: string;
  title: string;
  kind: string;
  page_ref: string;
  /** Null leaves the existing body alone; `""` blanks it. */
  body: string | null;
  frontmatter: OrderedMap<unknown>;
  edges: OrderedMap<string[]>;
}

export interface Plan {
  title: string;
  /** The commit verb ([Manifest.action]); see the module comment. */
  action: string;
  source_date: string;
  raw: string;
  pages: PagePlan[];
  /** For `consolidate`, the vault-relative refs the survivor absorbs; empty otherwise. */
  consolidates: string[];
  /** For `consolidate`, the committed snapshot the cluster was assessed at;
   * null to write without that guard. */
  assessed: PlanAssessment | null;
}

/** The JSON type of a value, for a refusal that has to say what it got. */
function jsonShape(v: unknown): string {
  return v === null ? "null" : Array.isArray(v) ? "an array" : typeof v;
}

/** Read one plan from JSON; `action` defaults to `ingest`. `source` is the plan
 * path, or `"(stdin)"`, named in a refusal. */
export function decodePlan(jsonText: string, source = ""): Plan {
  const where = source === "" ? "" : ` in ${source}`;
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(jsonText) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`invalid plan JSON${where}: ${(err as Error).message}`, {
      cause: err,
    });
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error(
      `invalid plan JSON${where}: the document must be a JSON object, got ${jsonShape(data)}`,
    );
  }
  const action = typeof data["action"] === "string" ? data["action"] : "";
  const rawPages = Array.isArray(data["pages"]) ? data["pages"] : [];
  const consolidates = Array.isArray(data["consolidates"])
    ? (data["consolidates"] as unknown[]).map((ref) =>
        typeof ref === "string" ? ref : String(ref),
      )
    : [];
  const pages: PagePlan[] = rawPages.map((p, i) => {
    if (p === null || typeof p !== "object" || Array.isArray(p)) {
      throw new Error(
        `invalid plan JSON${where}: pages[${i}] must be a JSON object, got ${jsonShape(p)}`,
      );
    }
    const page = p as Record<string, unknown>;
    return {
      op: typeof page["op"] === "string" ? page["op"] : "",
      title: typeof page["title"] === "string" ? page["title"] : "",
      kind: typeof page["kind"] === "string" ? page["kind"] : "",
      page_ref: typeof page["page_ref"] === "string" ? page["page_ref"] : "",
      body:
        page["body"] === null || page["body"] === undefined
          ? null
          : typeof page["body"] === "string"
            ? page["body"]
            : String(page["body"]),
      frontmatter: OrderedMap.decode<unknown>(page["frontmatter"]),
      edges: OrderedMap.decode<string[]>(page["edges"]),
    };
  });
  return {
    title: typeof data["title"] === "string" ? data["title"] : "",
    action: action === "" ? ActionIngest : action,
    source_date:
      typeof data["source_date"] === "string" ? data["source_date"] : "",
    raw: typeof data["raw"] === "string" ? data["raw"] : "",
    pages,
    consolidates,
    assessed: decodeAssessment(data["assessed"]),
  };
}

/** One plan page, resolved to the exact file the vault will hold. pageRef is ""
 * and page null together when placement could not be computed (an invalid kind,
 * a missing pageRef, or a title with nothing to slug), each already its own
 * shape error. */
export interface ResolvedPage {
  plan: PagePlan;
  pageRef: string;
  /** Full post-write content: a create starts blank, an update from its on-disk copy. */
  page: Page | null;
  /** Anything already at pageRef, which a create may not claim — a *directory* counts. */
  occupied: boolean;
  /** An existing page was read as the base — required of an update, never true of a create. */
  loaded: boolean;
}

/** Volatility ordered least to most durable; a value's index is its rank. */
const VolatilityOrder: readonly string[] = Volatilities;

/** One page's frontmatter decoded, or why it could not be. */
export type FrontmatterRead = { record: PageRecord } | { error: string };

/** One page a Consolidation absorbs, with the body and frontmatter [resolve]
 * read from disk. */
export interface AbsorbedPage {
  pageRef: string;
  body: string;
  found: boolean;
  /** null when the page is absent; otherwise its frontmatter or the refusal. */
  frontmatter: FrontmatterRead | null;
}

export interface ResolvedConsolidation {
  survivorRef: string;
  absorbed: AbsorbedPage[];
  /** The survivor's on-disk body before this plan rewrote it; null for a create. */
  survivorPriorBody: string | null;
  /** The survivor's frontmatter before this plan rewrote it; null for a create. */
  survivorPrior: FrontmatterRead | null;
}

/** One page [Resolved.execute] wrote, with the op it wrote it under. */
export interface WrittenPage {
  op: string;
  pageRef: string;
}

/** What [Resolved.execute] did. `written` is in plan order — for a
 * Consolidation, its survivor then the pages whose inbound links it repointed. */
export interface Execution {
  sha: string;
  written: WrittenPage[];
}

/** A plan with every derived fact computed exactly once. Constructible directly
 * for tests; [resolve] is the production path. */
export class Resolved {
  constructor(
    readonly plan: Plan,
    readonly pages: ResolvedPage[],
    /** "" when resolved without a vault — shape checks only, no reads. */
    readonly root: string,
    /** {kind: folder} for discovered kind-folders beyond the canonical ones; empty without a vault. */
    readonly extraKindFolders: Record<string, string>,
    readonly consolidation: ResolvedConsolidation | null = null,
  ) {}

  private vault(): Vault | null {
    if (this.root === "") return null;
    return new Vault(this.root);
  }

  opOf(page: ResolvedPage): string {
    return page.plan.op;
  }

  /** Check this plan, shape then semantic, before any write; throws [ErrPlan] naming every problem. */
  validate(): void {
    const problems = [...this.shapeErrors(), ...this.semanticErrors()];
    if (problems.length > 0) {
      throw new ErrPlan(`invalid plan: ${problems.join("; ")}`);
    }
  }

  /** Required fields and valid ops — everything checkable without a vault. */
  private shapeErrors(): string[] {
    const problems: string[] = [];
    if (!isPlanAction(this.plan.action)) {
      problems.push(
        `plan.action must be one of ${PlanActions.join("|")}, got ${JSON.stringify(this.plan.action)}`,
      );
    }
    if (this.plan.title === "") {
      problems.push("plan.title is required");
    }
    if (this.plan.pages.length === 0) {
      problems.push("plan.pages must be a JSON array with at least one page");
    }

    for (let i = 0; i < this.pages.length; i++) {
      const page = this.pages[i].plan;
      const prefix = `pages[${i}]`;
      // Empty when placement could not be computed — its own shape error.
      const pageRef_ = this.pages[i].pageRef;

      if (page.op !== OpCreate && page.op !== OpUpdate) {
        problems.push(
          `${prefix}.op must be 'create' or 'update', got ${JSON.stringify(page.op)}`,
        );
        continue;
      }
      if (page.op === OpCreate && page.title === "") {
        problems.push(`${prefix}.title is required`);
      } else if (page.op === OpCreate) {
        const refusal = emptySlugRefusal(page.title);
        if (refusal !== null) problems.push(`${prefix}.${refusal}`);
      }

      if (page.op === OpCreate) {
        if (page.page_ref !== "") {
          problems.push(`${prefix}.page_ref must not be set for op=create`);
        }
        if (page.kind === "") {
          problems.push(`${prefix}.kind is required for op=create`);
        } else if (
          !Kinds.includes(page.kind) &&
          !(page.kind in this.extraKindFolders)
        ) {
          problems.push(
            `${prefix}.kind ${JSON.stringify(page.kind)} is not a valid kind; one of ${[...Kinds, ...Object.keys(this.extraKindFolders)].join(", ")}`,
          );
        }
        if (page.body === null) {
          problems.push(`${prefix}.body is required for op=create`);
        }
      } else {
        if (page.kind !== "") {
          problems.push(`${prefix}.kind must not be set for op=update`);
        }
        if (page.page_ref === "") {
          problems.push(`${prefix}.page_ref is required for op=update`);
        }
      }

      // `raw_source` here is the `true` sentinel; a ref under it is a typed
      // edge and is refused below with the map that composes one.
      const rawSource = page.frontmatter.get("raw_source");
      if (rawSource.ok && rawSource.value === true && this.plan.raw === "") {
        problems.push(
          `${prefix}.frontmatter.raw_source is true but plan.raw is not set`,
        );
      }

      // A date, with an optional clock that is truncated on write; anything
      // not a date at all is refused. The rule is [sourcedate.parseSourceDate]'s.
      const sourceDate = page.frontmatter.get("source_date");
      if (sourceDate.ok && sourceDate.value !== null) {
        if (parseSourceDate(sourceDate.value) === null) {
          problems.push(
            `${prefix}.frontmatter.source_date must be a valid date (${CANONICAL_DATE_FORMAT}), got ${String(sourceDate.value)}`,
          );
        }
      }

      // Required whenever frontmatter is rewritten — always for a create, for
      // an update only when it supplies a map. Null and "" read as absent.
      const rewritesFrontmatter =
        page.op === OpCreate || page.frontmatter.length() > 0;
      if (rewritesFrontmatter) {
        const volatility = page.frontmatter.get("volatility");
        const missing =
          !volatility.ok ||
          volatility.value === null ||
          String(volatility.value).trim() === "";
        if (missing) {
          problems.push(`${prefix}.frontmatter.volatility is required`);
        } else if (
          !(Volatilities as readonly string[]).includes(
            String(volatility.value),
          )
        ) {
          // A value outside [Volatilities] writes a page `search --volatility`
          // can never match.
          problems.push(
            `${prefix}.frontmatter.volatility must be one of ${Volatilities.join("|")}, got ${String(volatility.value)}`,
          );
        }
      }

      // OrderedMap.decode leaves edge values unchecked, so validation is the
      // only place a non-list can be refused; `page set` refuses a multi-entry
      // single-link key, and the plan path must too rather than silently
      // writing the first ref.
      for (const [key, refs] of (page.edges as OrderedMap<unknown>).all()) {
        if (!EdgeKeys.includes(key)) {
          problems.push(
            `${prefix}.edges.${key} is not an edge key; one of ${EdgeKeys.join(", ")}`,
          );
          continue;
        }
        if (!Array.isArray(refs)) {
          problems.push(
            `${prefix}.edges.${key} must be a list of vault-relative page refs, got ${JSON.stringify(refs)}`,
          );
          continue;
        }
        if (isSingleLinkEdgeKey(key) && refs.length > 1) {
          problems.push(
            `${prefix}.edges.${key} holds a single link; pass one ref, got ${refs.length}`,
          );
        }
        for (const entry of refs) {
          if (typeof entry !== "string") {
            problems.push(
              `${prefix}.edges.${key} entries must be strings, got ${JSON.stringify(entry)}`,
            );
          }
        }
      }

      if (pageRef_ !== "") {
        for (const target of pageLinkTargets(page, this.plan)) {
          if (target.ref === pageRef_) {
            problems.push(
              `${prefix}.${target.at} points at ${pageRef_} itself — an edge needs a target other than the page carrying it`,
            );
          }
        }
      }

      // A `frontmatter` map writes its values verbatim, so an edge key here
      // commits a bare ref no consumer follows. An unknown key is the same
      // silent write-through, one typo away.
      for (const [key, value] of page.frontmatter.all()) {
        // Null reads as absent, like an omitted key.
        if (value === null) continue;
        if (
          EdgeKeys.includes(key) &&
          !(key === "raw_source" && value === true)
        ) {
          problems.push(
            `${prefix}.frontmatter.${key} is an edge key — name it under ${prefix}.edges instead, where ingest composes the link`,
          );
        } else if (!FrontmatterKeys.includes(key)) {
          problems.push(
            `${prefix}.frontmatter.${key} is not a frontmatter key; one of ${FrontmatterKeys.join(", ")}`,
          );
        }
      }
    }

    // A Consolidation is exactly one survivor: no raw artifact to chain
    // evidence to, no second page to write (ADR-0021).
    if (this.plan.action === ActionConsolidate) {
      if (this.plan.consolidates.length === 0) {
        problems.push(
          `plan.consolidates must name at least one page when action is '${ActionConsolidate}'`,
        );
      }
      if (this.plan.pages.length !== 1) {
        problems.push(
          `action '${ActionConsolidate}' takes exactly one page (the survivor), got ${this.plan.pages.length}`,
        );
      } else if (this.plan.pages[0].body === null) {
        problems.push(
          `pages[0].body is required when action is '${ActionConsolidate}' (the survivor's merged body)`,
        );
      }
      if (this.plan.raw !== "") {
        problems.push(
          `plan.raw must not be set when action is '${ActionConsolidate}': a Consolidation is sourced from pages, not an artifact`,
        );
      }
    } else if (this.plan.consolidates.length > 0) {
      problems.push(
        `plan.consolidates is only valid when action is '${ActionConsolidate}'`,
      );
    }

    // A synthesis save is exactly one new synthesis page, sourced from other
    // pages rather than a raw artifact.
    if (this.plan.action === ActionSynthesize) {
      if (this.plan.pages.length !== 1) {
        problems.push(
          `action '${ActionSynthesize}' takes exactly one page, got ${this.plan.pages.length}`,
        );
      } else {
        const page = this.plan.pages[0];
        if (page.op !== OpCreate) {
          problems.push(
            `pages[0].op must be '${OpCreate}' when action is '${ActionSynthesize}', got ${JSON.stringify(page.op)}`,
          );
        }
        if (page.kind !== "synthesis") {
          problems.push(
            `pages[0].kind must be 'synthesis' when action is '${ActionSynthesize}', got ${JSON.stringify(page.kind)}`,
          );
        }
      }
      if (this.plan.raw !== "") {
        problems.push(
          `plan.raw must not be set when action is '${ActionSynthesize}': a synthesis is sourced from pages, not an artifact`,
        );
      }
    }

    // A pinned assessment is the cluster's snapshot guard: it is required on a
    // Consolidation, and it must name every page the plan absorbs.
    if (this.plan.action === ActionConsolidate && this.plan.assessed === null) {
      problems.push(
        `plan.assessed is required when action is '${ActionConsolidate}': pin the snapshot the cluster was assessed at with \`enchiridion assess <page_ref...>\``,
      );
    }
    if (this.plan.assessed !== null) {
      const assessed = this.plan.assessed;
      if (this.plan.action !== ActionConsolidate) {
        problems.push(
          `plan.assessed is only valid when action is '${ActionConsolidate}'`,
        );
      }
      if (assessed.head === "") {
        problems.push("plan.assessed.head is required");
      }
      if (assessed.members.length === 0) {
        problems.push(
          "plan.assessed.members must name at least one assessed page",
        );
      }
      const named = new Set<string>();
      for (let i = 0; i < assessed.members.length; i++) {
        const member = assessed.members[i];
        if (member.page_ref === "") {
          problems.push(`plan.assessed.members[${i}].page_ref is required`);
          continue;
        }
        if (named.has(member.page_ref)) {
          problems.push(
            `plan.assessed.members names ${member.page_ref} more than once`,
          );
          continue;
        }
        named.add(member.page_ref);
        if (member.blob_oid === "") {
          problems.push(
            `plan.assessed.members[${i}].blob_oid is required for ${member.page_ref}`,
          );
        }
      }
      for (let i = 0; i < this.plan.consolidates.length; i++) {
        const ref = this.plan.consolidates[i];
        if (ref !== "" && !named.has(ref)) {
          problems.push(
            `plan.consolidates[${i}] ${ref} is not named by plan.assessed`,
          );
        }
      }
    }

    const seenConsolidated = new Set<string>();
    for (let i = 0; i < this.plan.consolidates.length; i++) {
      const ref = this.plan.consolidates[i];
      if (ref === "") {
        problems.push(`plan.consolidates[${i}] must not be empty`);
        continue;
      }
      if (seenConsolidated.has(ref)) {
        problems.push(`plan.consolidates names ${ref} more than once`);
        continue;
      }
      seenConsolidated.add(ref);
    }
    return problems;
  }

  /** The checks that need the vault: target existence, path length, evidence chain. */
  private semanticErrors(): string[] {
    if (this.root === "") return [];
    const v = this.vault() as Vault;
    const problems: string[] = [];

    // A page this plan creates counts as resolvable, so siblings can link to
    // each other before either exists on disk.
    const prospective = new Set<string>();
    for (const rp of this.pages) {
      if (rp.plan.op === OpCreate && rp.pageRef !== "") {
        prospective.add(rp.pageRef);
      }
    }

    for (let i = 0; i < this.pages.length; i++) {
      const rp = this.pages[i];
      const page = rp.plan;
      const prefix = `pages[${i}]`;
      if (page.op !== OpCreate && page.op !== OpUpdate) {
        continue;
      }

      if (page.op === OpCreate && rp.pageRef !== "") {
        if (rp.occupied) {
          problems.push(
            `${prefix}: create target ${rp.pageRef} already exists — use op:"update" to revise it, or give the page a different title`,
          );
        }
        const full = v.path(rp.pageRef);
        if (full.length > MaxPathLength) {
          problems.push(
            `${prefix}: path ${rp.pageRef} exceeds ${MaxPathLength} chars (${full.length} chars with vault root) — shorten the title, or put the vault nearer the filesystem root`,
          );
        }
      } else if (page.op === OpUpdate && rp.pageRef !== "" && !rp.loaded) {
        problems.push(
          `${prefix}.page_ref ${rp.pageRef} does not exist — use op:"create" to add it, or fix the ref`,
        );
      }

      const targets = pageLinkTargets(page, this.plan);
      for (const target of targets) {
        if (prospective.has(target.ref)) continue;
        // `exists` is file-only, so a directory target fails here rather than
        // composing a link to something unopenable.
        if (!v.exists(target.ref)) {
          problems.push(
            `${prefix}: ${target.key} target ${JSON.stringify(target.ref)} does not resolve to a real page — create it in this plan, fix the ref, or drop the ${target.key} entry`,
          );
        }
      }

      // A source -> source edge ends the chain of evidence at a second stub.
      // Both ends' kinds are vault facts (ADR-0020), hence the semantic pass.
      if (rp.pageRef !== "") {
        for (const target of targets) {
          if (target.key !== "source" || target.ref === rp.pageRef) continue;
          if (kindAt(rp.pageRef, this.pages, v) !== "source") continue;
          if (kindAt(target.ref, this.pages, v) !== "source") continue;
          problems.push(
            `${prefix}.${target.at} gives ${rp.pageRef} a source edge to ${target.ref}, another source page — the chain of evidence runs page -> wiki/${KindFolders["source"]}/ stub -> raw/ artifact, so a stub may not cite a stub`,
          );
        }
      }
    }

    if (this.plan.raw !== "") {
      const staged: Record<string, Page> = {};
      for (const rp of this.pages) {
        if (rp.pageRef !== "" && rp.page !== null) {
          staged[rp.pageRef] = rp.page;
        }
      }
      problems.push(
        ...checkChainOfEvidence(staged, this.plan.raw, (raw) =>
          v.rawSourceStub(raw),
        ),
      );
    }

    if (this.plan.action === ActionConsolidate) {
      problems.push(...this.consolidationErrors());
    }
    return problems;
  }

  /** The absorbed pages are real and exist, and the survivor still reads their content. */
  private consolidationErrors(): string[] {
    const c = this.consolidation;
    if (c === null) return [];
    const problems: string[] = [];
    if (c.survivorRef === "") {
      // The survivor's own shape error is already reported; nothing to compare
      // it against yet.
      return problems;
    }
    if (c.absorbed.some((a) => a.pageRef === c.survivorRef)) {
      problems.push(
        `plan.consolidates names the survivor ${c.survivorRef}; a page cannot absorb itself`,
      );
    }
    for (let i = 0; i < c.absorbed.length; i++) {
      const absorbed = c.absorbed[i];
      if (absorbed.pageRef === "") continue;
      // The page predicate, not bare existence: `_index.md`, KIND.md and nested
      // files sit on disk without being pages.
      if (!isPageRef(absorbed.pageRef)) {
        problems.push(
          `plan.consolidates[${i}] ${absorbed.pageRef} is not a page (wiki/<kind-folder>/<file>.md)`,
        );
        continue;
      }
      if (!absorbed.found) {
        problems.push(
          `plan.consolidates[${i}] ${absorbed.pageRef} does not exist`,
        );
      }
    }
    problems.push(...this.losslessnessErrors());
    return problems;
  }

  /**
   * The losslessness gate (ADR-0021, ADR-0030, ADR-0031): every absorbed body's
   * content, and an `update` survivor's own former body, must still be readable
   * — as one unbroken run of top-level blocks — in the survivor's authored body.
   * Compared through [canonicalizeLinkTargets] — by where links point, not how
   * they are spelled — so a body re-based into another kind-folder compares
   * equal and a link the merge broke does not. The survivor's frontmatter is
   * checked too, by [frontmatterLosslessnessErrors].
   */
  private losslessnessErrors(): string[] {
    const c = this.consolidation;
    if (c === null || c.survivorRef === "" || this.pages.length !== 1)
      return [];
    const survivor = this.pages[0].page;
    if (survivor === null) return [];

    const consolidated = new Set(c.absorbed.map((a) => a.pageRef));
    const target = (ref: string): string =>
      consolidated.has(ref) ? c.survivorRef : ref;
    const canonical = (body: string, from: string): string =>
      canonicalizeLinkTargets(body, path.posix.dirname(from), target);
    const have = bodyBlocks(canonical(survivor.body(), c.survivorRef));

    const problems: string[] = [];
    if (c.survivorPriorBody !== null) {
      const want = bodyBlocks(canonical(c.survivorPriorBody, c.survivorRef));
      const at = firstUnmatchedBlock(want, have);
      if (at >= 0) {
        problems.push(
          `plan.consolidates: the survivor's body does not contain its own former content, starting at ${describeBlock(want[at])} — a Consolidation is lossless (ADR-0021)`,
        );
      }
    }
    for (const absorbed of c.absorbed) {
      if (!absorbed.found) continue; // its own "does not exist" error
      const want = bodyBlocks(canonical(absorbed.body, absorbed.pageRef));
      if (want.length === 0) continue; // a stub absorbs nothing
      const at = firstUnmatchedBlock(want, have);
      if (at >= 0) {
        problems.push(
          `plan.consolidates: the survivor's body does not contain ${absorbed.pageRef}'s content, starting at ${describeBlock(want[at])} — a Consolidation is lossless (ADR-0021)`,
        );
      }
    }
    problems.push(...this.frontmatterLosslessnessErrors(c, survivor));
    return problems;
  }

  /**
   * Frontmatter losslessness (ADR-0031): the survivor's authored frontmatter
   * must carry every absorbed edge target under any key, the cluster's tags,
   * and the most volatile member's `volatility`. An edge pointing at an absorbed
   * page or the survivor is exempt — both collapse into the survivor.
   */
  private frontmatterLosslessnessErrors(
    c: ResolvedConsolidation,
    survivor: Page,
  ): string[] {
    const problems: string[] = [];
    const read = readFrontmatter(c.survivorRef, survivor.text);
    if ("error" in read) {
      return [unreadableFrontmatter("the survivor's frontmatter", read.error)];
    }
    const have = read.record;

    const consolidated = new Set(c.absorbed.map((a) => a.pageRef));
    const haveTargets = new Set(
      have.edges.flatMap((edge) =>
        edgeTargets(edge).map((ref) => path.posix.normalize(ref)),
      ),
    );
    const wantTags = new Set<string>();
    let mostVolatile = "";
    let mostRank = -1;
    const considerVolatility = (value: string): void => {
      const rank = VolatilityOrder.indexOf(value);
      if (rank > mostRank) {
        mostRank = rank;
        mostVolatile = value;
      }
    };
    if (c.survivorPrior !== null) {
      if ("error" in c.survivorPrior) {
        problems.push(
          unreadableFrontmatter(
            "the survivor's prior frontmatter",
            c.survivorPrior.error,
          ),
        );
      } else {
        for (const tag of c.survivorPrior.record.tags) wantTags.add(tag);
        considerVolatility(c.survivorPrior.record.volatility);
      }
    }

    for (const absorbed of c.absorbed) {
      // A non-page (KIND.md, a nested file) or a missing one is already its own
      // error; there is no frontmatter here to compare.
      if (!absorbed.found || !isPageRef(absorbed.pageRef)) continue;
      if (absorbed.frontmatter === null) continue;
      if ("error" in absorbed.frontmatter) {
        problems.push(
          unreadableFrontmatter(
            `${absorbed.pageRef}'s frontmatter`,
            absorbed.frontmatter.error,
          ),
        );
        continue;
      }
      const record = absorbed.frontmatter.record;
      for (const edge of record.edges) {
        for (const raw of edgeTargets(edge)) {
          const ref = path.posix.normalize(raw);
          if (consolidated.has(ref) || ref === c.survivorRef) continue;
          if (!haveTargets.has(ref)) {
            problems.push(
              `plan.consolidates: the survivor's frontmatter does not carry ${absorbed.pageRef}'s ${describeEdge(edge.key)} to ${ref} — a Consolidation is lossless (ADR-0021)`,
            );
          }
        }
      }
      for (const tag of record.tags) wantTags.add(tag);
      considerVolatility(record.volatility);
    }

    const haveTags = new Set(have.tags);
    const missing = [...wantTags].filter((tag) => !haveTags.has(tag));
    if (missing.length > 0) {
      problems.push(
        `plan.consolidates: the survivor's tags must union the cluster's; missing ${missing.map((tag) => JSON.stringify(tag)).join(", ")} — a Consolidation is lossless (ADR-0021)`,
      );
    }
    if (mostVolatile !== "" && have.volatility !== mostVolatile) {
      problems.push(
        `plan.consolidates: the survivor's volatility is ${JSON.stringify(have.volatility)}, but the cluster's most volatile member is ${JSON.stringify(mostVolatile)} — a Consolidation is only as durable as its shakiest part (ADR-0021)`,
      );
    }
    return problems;
  }

  /** Write every resolved page and commit. Assumes [Resolved.validate] passed;
   * no rollback on failure. */
  async execute(git: Git): Promise<Execution> {
    if (this.root === "") {
      throw new ErrPlan(
        "invalid plan: cannot execute a plan resolved without a vault root",
      );
    }
    const v = this.vault() as Vault;

    if (this.plan.action === ActionConsolidate) {
      return this.executeConsolidation(v, git);
    }

    const superseded: Supersession[] = [];
    const written: WrittenPage[] = [];

    for (const resolved of this.pages) {
      if (resolved.pageRef === "" || resolved.page === null) {
        throw new ErrPlan(
          `invalid plan: page ${JSON.stringify(resolved.plan.title)} was not resolved`,
        );
      }
      v.write(resolved.pageRef, resolved.page);
      written.push({ op: resolved.plan.op, pageRef: resolved.pageRef });
      if (resolved.plan.op !== OpCreate) continue;
      const targets = resolved.plan.edges.get("supersedes");
      if (targets.ok) {
        for (const target of targets.value ?? []) {
          superseded.push({
            old: path.posix.normalize(target),
            new: resolved.pageRef,
          });
        }
      }
    }

    // The manifest's own grouping, projected from the one record of what was written.
    const created = written
      .filter((page) => page.op === OpCreate)
      .map((page) => page.pageRef);
    const updated = written
      .filter((page) => page.op !== OpCreate)
      .map((page) => page.pageRef);

    const sha = await commit(
      this.root,
      {
        title: this.plan.title,
        action: this.plan.action,
        created,
        updated,
        superseded,
        source_date: manifestSourceDate(this.plan.source_date),
        raw_source: this.plan.raw,
      },
      git,
    );
    return { sha, written };
  }

  /**
   * [execute] for `consolidate`: write the survivor, repoint every inbound
   * link, delete the absorbed pages, commit once (ADR-0021). The losslessness
   * check runs again here so a hand-built [Resolved] cannot route around
   * [validate]. */
  private async executeConsolidation(v: Vault, git: Git): Promise<Execution> {
    const c = this.consolidation;
    const survivor = this.pages.length === 1 ? this.pages[0] : null;
    if (
      c === null ||
      c.survivorRef === "" ||
      survivor === null ||
      survivor.page === null
    ) {
      throw new ErrPlan("invalid plan: consolidation was not resolved");
    }

    const problems = this.losslessnessErrors();
    for (const absorbed of c.absorbed) {
      if (!absorbed.found) {
        problems.push(`plan.consolidates ${absorbed.pageRef} does not exist`);
      }
    }
    if (problems.length > 0) {
      throw new ErrPlan(`invalid plan: ${problems.join("; ")}`);
    }

    const losers = c.absorbed.map((a) => a.pageRef);
    // The survivor is written before anything is deleted, so an interrupted run
    // has always laid the absorbed content down first.
    const changed = v.consolidate(c.survivorRef, survivor.page, losers);

    // The rest are pages whose inbound links were rewritten; the absorbed pages
    // are deleted, never written.
    const written: WrittenPage[] = [
      { op: survivor.plan.op, pageRef: c.survivorRef },
      ...changed
        .filter((ref) => ref !== c.survivorRef)
        .map((pageRef) => ({ op: OpUpdate, pageRef })),
    ];
    const created = written
      .filter((page) => page.op === OpCreate)
      .map((page) => page.pageRef);
    const updated = written
      .filter((page) => page.op !== OpCreate)
      .map((page) => page.pageRef);

    const sha = await commit(
      this.root,
      {
        title: this.plan.title,
        action: this.plan.action,
        created,
        updated,
        deleted: losers,
        source_date: manifestSourceDate(this.plan.source_date),
        raw_source: this.plan.raw,
      },
      git,
    );
    return { sha, written };
  }

  /** A human-readable summary of what [Resolved.execute] would write. */
  describe(): string {
    const lines = [`${this.plan.action}: ${this.plan.title}`];
    for (const resolved of this.pages) {
      lines.push(`  ${resolved.plan.op.padEnd(6)} ${resolved.pageRef}`);
    }
    for (const absorbed of this.consolidation?.absorbed ?? []) {
      lines.push(`  ${"delete".padEnd(6)} ${absorbed.pageRef}`);
    }
    return lines.join("\n");
  }
}

/** Turn a plan into the exact pages the vault will hold — pure apart from vault
 * reads. Pass root == "" to resolve without a vault, for shape checks alone. */
export function resolve(plan: Plan, root: string): Resolved {
  let v: Vault | null = null;
  const extraKindFolders: Record<string, string> = {};
  if (root !== "") {
    v = new Vault(root);
    // Refuse an unmigrated vault rather than split one kind across singular and
    // plural folders.
    const legacy = v.legacyKindFolders();
    if (legacy.length > 0) {
      const moves = legacy.map(
        (kind) => `git mv wiki/${kind}/* wiki/${KindFolders[kind]}/`,
      );
      throw new Error(
        `${root} holds pre-ADR-0008 kind-folders (wiki/${legacy.join(", wiki/")}); ` +
          `move their pages into the plural folders before ingesting (${moves.join("; ")}), ` +
          `then remove the empty singular folders. Merge by hand where both spellings hold the same filename`,
      );
    }
    Object.assign(extraKindFolders, v.discoveredKinds());
  }

  const refs = plan.pages.map((page) => pageRef(page, extraKindFolders, v));

  // First page wins, so a link's title matches the earliest plan page claiming
  // it. An empty title is no title, not a decision: recording one would shadow
  // the on-disk title with a filename label.
  const titles = new Map<string, string>();
  for (let i = 0; i < refs.length; i++) {
    const ref = refs[i];
    if (ref === "") continue;
    const title = plan.pages[i].title;
    if (title === "") continue;
    if (!titles.has(ref)) titles.set(ref, title);
  }

  const resolvedPages: ResolvedPage[] = [];
  for (let i = 0; i < plan.pages.length; i++) {
    const planPage = plan.pages[i];
    const pageRef_ = refs[i];
    if (pageRef_ === "") {
      resolvedPages.push({
        plan: planPage,
        pageRef: "",
        page: null,
        occupied: false,
        loaded: false,
      });
      continue;
    }

    let base = new Page("");
    let loaded = false;
    if (planPage.op === OpUpdate && v !== null && v.exists(pageRef_)) {
      base = v.load(pageRef_);
      loaded = true;
    }

    let page = applyFrontmatter(
      base,
      planPage,
      path.posix.dirname(pageRef_),
      plan,
      titles,
      v,
    );
    page = applyBody(page, planPage.body);

    resolvedPages.push({
      plan: planPage,
      pageRef: pageRef_,
      page,
      occupied: v !== null && v.occupied(pageRef_),
      loaded,
    });
  }
  return new Resolved(
    plan,
    resolvedPages,
    root,
    extraKindFolders,
    resolveConsolidation(plan, resolvedPages, v),
  );
}

/** Read the consolidation a plan declares: its survivor and the survivor's
 * former body, and each absorbed page's body and frontmatter as they stand on
 * disk — captured once so validate and execute read the same content, including
 * on a second execute after the file is gone. */
function resolveConsolidation(
  plan: Plan,
  resolvedPages: ResolvedPage[],
  v: Vault | null,
): ResolvedConsolidation | null {
  if (plan.action !== ActionConsolidate || resolvedPages.length === 0) {
    return null;
  }
  const survivorRef = resolvedPages[0].pageRef;
  let survivorPriorBody: string | null = null;
  let survivorPrior: FrontmatterRead | null = null;
  if (
    resolvedPages[0].plan.op === OpUpdate &&
    survivorRef !== "" &&
    v !== null &&
    v.exists(survivorRef)
  ) {
    const prior = v.load(survivorRef);
    survivorPriorBody = prior.body();
    survivorPrior = readFrontmatter(survivorRef, prior.text);
  }
  const absorbed: AbsorbedPage[] = plan.consolidates.map((ref) => {
    const pageRef = path.posix.normalize(ref);
    let body = "";
    let found = false;
    let frontmatter: FrontmatterRead | null = null;
    if (v !== null && pageRef !== "" && v.exists(pageRef)) {
      const page = v.load(pageRef);
      body = page.body();
      found = true;
      frontmatter = readFrontmatter(pageRef, page.text);
    }
    return { pageRef, body, found, frontmatter };
  });
  return { survivorRef, absorbed, survivorPriorBody, survivorPrior };
}

/** Read one page's frontmatter; the error branch lets a caller refuse rather
 * than read an undecodable page as edge-less. */
function readFrontmatter(pageRef: string, text: string): FrontmatterRead {
  try {
    return { record: newPageRecord(pageRef, text) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** The refusal for a page whose frontmatter cannot be decoded. */
function unreadableFrontmatter(where: string, error: string): string {
  return `plan.consolidates: ${where} could not be read (${error}) — a Consolidation is lossless (ADR-0021)`;
}

/** What one [EdgeKeys] key's link to a target is called in a refusal: a
 * single-link key points at a raw artifact, not a page. */
function describeEdge(key: string): string {
  return isSingleLinkEdgeKey(key) ? `${key} link` : `${key} edge`;
}

/** The vault-relative path a plan page will occupy, or "" when it cannot be
 * computed (each cause is already its own shape error). An update's ref is a
 * caller-supplied path, so it is canonicalised against the vault — `./`,
 * `../` and the on-disk spelling of the name — rather than trusted verbatim:
 * everything downstream (the manifest, the chain gate, the self-edge check)
 * says "the page at this ref", and two spellings of one file would disagree. */
function pageRef(
  page: PagePlan,
  extraKindFolders: Record<string, string>,
  v: Vault | null,
): string {
  if (page.op !== OpCreate) {
    const ref = path.posix.normalize(page.page_ref);
    if (v === null || ref === "" || !v.exists(ref)) return ref;
    try {
      const real = fs.realpathSync(v.path(ref));
      const root = fs.realpathSync(v.root);
      if (real.startsWith(root + path.sep)) {
        return real
          .slice(root.length + 1)
          .split(path.sep)
          .join("/");
      }
    } catch {
      // unreadable or a dangling symlink: the normalized spelling is the ref,
      // and existence validation reports it as it finds it
    }
    return ref;
  }
  if (page.title === "") return "";
  try {
    return placePath(page.kind, page.title, extraKindFolders);
  } catch {
    return "";
  }
}

/** The title a link to targetRef should carry: this plan's own page for that
 * ref wins, so a corrected title propagates to every link the plan writes; then
 * the on-disk title; then `""` for [composeEdgeLink] to use the basename. */
function resolveTitle(
  targetRef: string,
  titles: Map<string, string>,
  v: Vault | null,
): string {
  targetRef = path.posix.normalize(targetRef);
  const title = titles.get(targetRef);
  if (title !== undefined) return title;
  if (v !== null && v.exists(targetRef)) {
    const page = v.load(targetRef);
    const diskTitle = page.getString("title");
    if (diskTitle !== "") return diskTitle;
  }
  return "";
}

/** The only frontmatter projection in this module — see [resolve]. */
function applyFrontmatter(
  page: Page,
  planPage: PagePlan,
  pageDir: string,
  plan: Plan,
  titles: Map<string, string>,
  v: Vault | null,
): Page {
  if (planPage.op === OpCreate || planPage.title !== "") {
    page = page.set("title", planPage.title);
  }

  const merging = planPage.op === OpUpdate;
  // `source_date` is absent here because [Page.set] applies the source-date rule
  // to every value it is handed; validation already refused anything not a date.
  for (const [key, value] of planPage.frontmatter.all()) {
    let v_ = value;
    if (key === "raw_source" && value === true) {
      if (plan.raw === "") {
        // Nothing to point at; validate reports it as a shape error.
        continue;
      }
      v_ = composeEdgeLink("raw_source", plan.raw, pageDir, "");
    }
    if (Array.isArray(v_) && merging) {
      page = page.merge(key, v_);
    } else {
      page = page.set(key, v_);
    }
  }

  // A page still omitting `source_date` inherits the plan's top-level value, so
  // the writer never emits a page the missing-volatility-source-date check
  // reports; a value already on the page wins.
  if (page.getString("source_date") === "" && plan.source_date !== "") {
    page = page.set("source_date", plan.source_date);
  }

  for (const [key, refs] of planPage.edges.all()) {
    // A non-list value or a non-string entry is a shape error; validation
    // reports it, so only well-typed refs are composed here.
    if (!Array.isArray(refs)) continue;
    const typed = refs.filter((ref) => typeof ref === "string");
    const single = isSingleLinkEdgeKey(key);
    if (single && typed.length === 0) continue; // nothing to point at
    const links = typed.map((ref) =>
      composeEdgeLink(key, ref, pageDir, resolveTitle(ref, titles, v)),
    );
    // A single-link key (`raw_source`) is a scalar; validation already refused
    // more than one ref, and every other edge is a list.
    if (single) {
      page = page.set(key, links[0]);
    } else if (merging) {
      page = page.mergeStrings(key, links);
    } else {
      page = page.set(key, links);
    }
  }
  return page;
}

/** Canonicalises the commit-trailer `source_date` to YYYY-MM-DD; a non-date
 * passes through ([sourcedate.parseSourceDate]). */
function manifestSourceDate(s: string): string {
  const date = parseSourceDate(s);
  return date !== null ? date : s;
}

/** A block's opening source line, truncated, for naming it in a refusal. */
function describeBlock(block: BodyBlock): string {
  const line = block.opening.trim();
  return JSON.stringify(line.length > 60 ? `${line.slice(0, 60)}…` : line);
}

/** Replaces the body, leaving the frontmatter block byte-exact and re-encoding
 * the new body's link destinations. */
function applyBody(page: Page, newBody: string | null): Page {
  if (newBody === null) return page;
  const { bodyOffset } = splitFrontmatter(page.text);
  return new Page(page.text.slice(0, bodyOffset) + normalizeBodyLinks(newBody));
}

/** One link a plan asks for, with the plan field it sits under so a refusal can
 * name the path an author would edit. */
interface LinkTarget {
  /** The plan field, `pages[i].`-relative — `edges.related`,
   * `frontmatter.raw_source`. */
  at: string;
  key: string;
  ref: string;
}

/** The kind of the page at ref: a plan create's own kind field (its folder is
 * not on disk yet), else the vault's folder -> kind ladder (ADR-0020). Null when
 * no page resolves there — a dangling target has no kind to judge. */
function kindAt(ref: string, pages: ResolvedPage[], v: Vault): string | null {
  for (const rp of pages) {
    if (rp.pageRef === ref && rp.plan.op === OpCreate) return rp.plan.kind;
  }
  if (!v.exists(ref)) return null;
  const folder = path.posix.basename(path.posix.dirname(ref));
  return kindForFolder(v.root, folder);
}

/** The targets this page's plan asks to link to — plain refs, so a normalize
 * and no markdown-link parsing. */
function pageLinkTargets(page: PagePlan, plan: Plan): LinkTarget[] {
  const targets: LinkTarget[] = [];
  const rawSource = page.frontmatter.get("raw_source");
  if (rawSource.ok && rawSource.value === true && plan.raw !== "") {
    targets.push({
      at: "frontmatter.raw_source",
      key: "raw_source",
      ref: path.posix.normalize(plan.raw),
    });
  }
  for (const [key, refs] of page.edges.all()) {
    if (!Array.isArray(refs)) continue;
    for (const ref of refs) {
      if (typeof ref !== "string") continue;
      targets.push({
        at: `edges.${key}`,
        key,
        ref: path.posix.normalize(ref),
      });
    }
  }
  return targets;
}
