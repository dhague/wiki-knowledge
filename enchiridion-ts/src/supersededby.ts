/**
 * Resolve a candidate set's supersession chains to their current heads — the
 * retrieval-facing entrypoint into [pagerecord.loadRecords]'s `supersededBy`
 * inversion. A head outside the candidate set is still returned: `supersedes`
 * is a recorded fact.
 */

import type { PageRecord } from "./pagerecord.js";

/** One seed walked to its head. `chain` excludes Seed, ends with Active, and is
 * empty when Seed is already current. */
export interface Resolution {
  seed: string;
  active: string;
  chain: string[];
}

/** Walk each seed's `supersededBy` pointers to its current head. A page missing
 * from records resolves to itself; with multiple successors the first is
 * followed (first-write-wins, as in the search index — the schema has no fork). */
export function resolve(
  seeds: string[],
  records: Record<string, PageRecord>,
): Resolution[] {
  const resolutions: Resolution[] = [];
  for (const seed of seeds) {
    const chain: string[] = [];
    let current = seed;
    const seen = new Set<string>([current]);
    for (;;) {
      const rec = records[current];
      const successors = rec ? rec.supersededBy : [];
      if (successors.length === 0) break;
      const next = successors[0];
      if (seen.has(next)) {
        break; // a supersedes cycle would spin forever otherwise
      }
      chain.push(next);
      seen.add(next);
      current = next;
    }
    resolutions.push({ seed, active: current, chain });
  }
  return resolutions;
}
