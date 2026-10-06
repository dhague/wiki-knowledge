/**
 * The lint judgment pass's body reader (ADR-0029): page bodies read in bounded
 * batches from one committed HEAD snapshot, through a per-run ledger that caches
 * what the run already read and bounds the sweep.
 */

import fs from "node:fs";
import path from "node:path";
import { headPages, type HeadPage } from "./assess.js";
import { mkdirSafe } from "./fsutil.js";
import { splitFrontmatter } from "./wikipage.js";

/** Pages one call returns when the caller names no limit. */
export const DefaultLimit = 12;

/** Body bytes one call returns when the caller names no cap. */
export const DefaultMaxBytes = 49_152;

/** Page bodies one lint run may newly read before its sweep stops. */
export const DefaultBudget = 60;

const LedgerFile = "lint-bodies.json";

/** One page body as the run read it, at the revision it was read at. */
export interface BodyPage {
  page_ref: string;
  blob_oid: string;
  title: string;
  /** Body bytes, the size the batch cap measures. */
  bytes: number;
  /** True when this run had already read it; a cached body costs no budget. */
  cached: boolean;
  body: string;
}

/** The run's read budget: what it has spent, and whether the sweep hit the cap. */
export interface BodyBudget {
  spent: number;
  cap: number;
  exhausted: boolean;
}

/** One read-pages call's result: the snapshot, the coverage, and the bodies. */
export interface BodyBatch {
  head: string;
  /** Pages the sweep is eligible to read, after --exclude. */
  eligible: number;
  returned: number;
  cached: number;
  /** The --after cursor a later sweep batch continues from; null when done. */
  next_after: string | null;
  remaining: number;
  budget: BodyBudget;
  pages: BodyPage[];
}

export interface ReadBodiesOptions {
  /** Read exactly these refs. Absent, the call sweeps the eligible pages. */
  refs?: string[];
  /** Pages a sweep batch returns; an explicit read serves every ref it names. */
  limit?: number;
  /** Body bytes a sweep batch returns; an explicit read is never truncated. */
  maxBytes?: number;
  budget?: number;
  /** Refs a mechanical finding already flagged; the sweep skips them. */
  exclude?: string[];
  /** Continue a sweep after this ref. */
  after?: string;
  /** Open a fresh run: drop the ledger, its cached bodies and its spent budget. */
  reset?: boolean;
}

/** A ref the caller named is not a page at HEAD. */
export class ErrBodies extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ErrBodies";
  }
}

/** The run ledger's path under the vault's disposable `.wiki-knowledge/`. */
export function ledgerPath(root: string): string {
  return path.join(root, ".wiki-knowledge", LedgerFile);
}

interface LedgerEntry {
  blob_oid: string;
  title: string;
  bytes: number;
  body: string;
}

/** The ledger is per-HEAD: a run's bodies and its spent budget describe one snapshot. */
interface Ledger {
  head: string;
  spent: number;
  pages: Record<string, LedgerEntry>;
}

function emptyLedger(head: string): Ledger {
  return { head, spent: 0, pages: {} };
}

/** A ledger that is absent, unreadable, or from another HEAD reads as empty. */
function loadLedger(file: string, head: string): Ledger {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return emptyLedger(head);
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return emptyLedger(head);
    }
    const led = parsed as Partial<Ledger>;
    if (led.head !== head) return emptyLedger(head);
    const pages =
      led.pages !== null && typeof led.pages === "object" ? led.pages : {};
    return {
      head,
      spent: typeof led.spent === "number" && led.spent >= 0 ? led.spent : 0,
      pages: pages as Record<string, LedgerEntry>,
    };
  } catch {
    return emptyLedger(head);
  }
}

/** A page's body text and its size in bytes. */
function bodyOf(page: HeadPage): { body: string; bytes: number } {
  const body = splitFrontmatter(page.content).body;
  return { body, bytes: Buffer.byteLength(body, "utf8") };
}

/** One ledger entry as the batch hands it back. */
function bodyPage(
  pageRef: string,
  page: HeadPage,
  entry: LedgerEntry,
  cached: boolean,
): BodyPage {
  return {
    page_ref: pageRef,
    blob_oid: page.blobOid,
    title: page.title,
    bytes: entry.bytes,
    cached,
    body: entry.body,
  };
}

/** Read page bodies in bounded batches; see the module comment and ADR-0029. */
export async function readBodies(
  root: string,
  opts: ReadBodiesOptions = {},
): Promise<BodyBatch> {
  const limit = opts.limit ?? DefaultLimit;
  const maxBytes = opts.maxBytes ?? DefaultMaxBytes;
  const cap = opts.budget ?? DefaultBudget;
  const explicit = opts.refs !== undefined;
  const { head, pages: atHead } = await headPages(root);
  const file = ledgerPath(root);
  const ledger = opts.reset ? emptyLedger(head) : loadLedger(file, head);
  const before = JSON.stringify(ledger);

  // A cached body is only this run's if HEAD still holds that exact revision.
  for (const ref of Object.keys(ledger.pages)) {
    const page = atHead.get(ref);
    if (page === undefined || ledger.pages[ref].blob_oid !== page.blobOid) {
      delete ledger.pages[ref];
    }
  }

  const excluded = new Set(opts.exclude ?? []);
  const eligible = [...atHead.keys()]
    .filter((ref) => !excluded.has(ref))
    .sort();

  const after = opts.after ?? null;
  const requested = explicit
    ? opts.refs!
    : eligible.filter((ref) => after === null || ref > after).slice(0, limit);

  const out: BodyPage[] = [];
  let usedBytes = 0;
  let exhausted = false;
  for (const ref of requested) {
    const page = atHead.get(ref);
    if (page === undefined) {
      if (explicit) {
        throw new ErrBodies(
          `${ref} is not a committed page at HEAD — no body to read`,
        );
      }
      continue;
    }
    const cached = ledger.pages[ref];
    // The caps bound a sweep. An explicit read is a check's required input, so it
    // is always served and merely counted against the run.
    if (cached === undefined && !explicit && ledger.spent >= cap) {
      exhausted = true;
      break;
    }
    if (cached === undefined) {
      const { body, bytes } = bodyOf(page);
      const entry: LedgerEntry = {
        blob_oid: page.blobOid,
        title: page.title,
        bytes,
        body,
      };
      ledger.pages[ref] = entry;
      ledger.spent += 1;
    }
    const entry = ledger.pages[ref];
    if (explicit) {
      out.push(bodyPage(ref, page, entry, cached !== undefined));
      continue;
    }
    // Always return at least one page: one oversized body must not stall the sweep.
    if (out.length > 0 && usedBytes + entry.bytes > maxBytes) break;
    usedBytes += entry.bytes;
    out.push(bodyPage(ref, page, entry, cached !== undefined));
  }

  // The cursor is where the next sweep batch resumes: the last page returned, or
  // the caller's own cursor when the cap stopped this one before it read anything.
  const cursor =
    out.length > 0 ? out[out.length - 1].page_ref : explicit ? null : after;
  const remaining = explicit
    ? 0
    : eligible.filter((ref) => cursor === null || ref > cursor).length;

  const serialised = JSON.stringify(ledger);
  if (opts.reset || serialised !== before) {
    mkdirSafe(path.dirname(file));
    fs.writeFileSync(file, serialised, { mode: 0o644 });
  }

  return {
    head,
    eligible: eligible.length,
    returned: out.length,
    cached: out.filter((page) => page.cached).length,
    next_after: remaining > 0 ? cursor : null,
    remaining,
    budget: { spent: ledger.spent, cap, exhausted },
    pages: out,
  };
}
