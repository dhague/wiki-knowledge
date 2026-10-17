/**
 * One run's read of a vault's text and records — working tree or caller-held —
 * each loaded at most once however many readers ask, so `check --all` stops
 * re-walking and re-parsing the vault per check.
 */

import fs from "node:fs";
import path from "node:path";
import { Vault } from "./vault.js";
import type { PageWithText } from "./vault.js";
import type { LoadRecordsOptions, PageRecord } from "./pagerecord.js";

/** All `.md` refs under `wiki/`, including ones that fail isPageRef and that
 * enumeratePageRefs skips. */
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

/** A lazily-loaded snapshot of one vault's text and records. The maps go out by
 * reference, so a reader must not mutate them. */
export class VaultRead {
  private readonly vault: Vault;
  private textsCache?: Record<string, string>;
  private allRefsCache?: string[];
  /** Keyed by error mode — `skipMalformedEdges` is the only option that changes
   * decoding; a new one needs a key too. */
  private readonly recordsCache = new Map<
    boolean,
    Record<string, PageRecord>
  >();
  private kindsCache?: string[];
  private registryCache?: Array<{ ref: string; text: string }>;

  constructor(readonly root: string) {
    this.vault = new Vault(root);
  }

  /** Every `wiki/**` page as a {pageRef: text} map. */
  texts(): Record<string, string> {
    return (this.textsCache ??= this.vault.loadWikiPages());
  }

  /** Every `.md` under `wiki/`, pages and non-pages alike. */
  allRefs(): string[] {
    return (this.allRefsCache ??= walkAllMd(this.root));
  }

  /** Parsed records for the working tree, strict by default; `opts` per
   * [LoadRecordsOptions]. */
  records(opts: LoadRecordsOptions = {}): Record<string, PageRecord> {
    const tolerant = opts.skipMalformedEdges === true;
    let records = this.recordsCache.get(tolerant);
    if (records === undefined) {
      records = this.vault.recordsFor(this.texts(), opts);
      this.recordsCache.set(tolerant, records);
    }
    return records;
  }

  /** Parsed records for `pages` the caller already holds, such as HEAD text;
   * not cached. */
  recordsFor(
    pages: Record<string, string>,
    opts: LoadRecordsOptions = {},
  ): Record<string, PageRecord> {
    return this.vault.recordsFor(pages, opts);
  }

  /** Each page's parsed record paired with its text, strict by default. */
  pagesWithText(opts: LoadRecordsOptions = {}): Record<string, PageWithText> {
    const texts = this.texts();
    const records = this.records(opts);
    const out: Record<string, PageWithText> = {};
    for (const ref of Object.keys(records)) {
      out[ref] = { record: records[ref], text: texts[ref] };
    }
    return out;
  }

  /** The kind values `concept-fragmentation` scores (ADR-0027). */
  consolidatableKinds(): string[] {
    return (this.kindsCache ??= this.vault.consolidatableKinds());
  }

  /** Every consolidatable kind-folder's Consolidation-exclusion registry, as
   * written on disk (ADR-0028). */
  registryFiles(): Array<{ ref: string; text: string }> {
    return (this.registryCache ??= this.vault.loadRegistries());
  }
}
