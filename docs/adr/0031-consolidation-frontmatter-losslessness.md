# Consolidation losslessness covers absorbed frontmatter as target containment

[ADR-0021](0021-consolidation-is-lossless-delete-not-supersede.md) makes a Consolidation a *lossless delete*; [ADR-0030](0030-consolidation-losslessness-compares-content-not-bytes.md) implements "lossless" as body-content containment and deliberately leaves frontmatter out. Nothing else checked it. So when a page was absorbed, its typed edges and `raw_source` went with the delete unless the agent happened to union them into the survivor's frontmatter — which the procedure asked for in prose and nothing verified. An absorbed `refines`, `contradicts`, `example-of`, `source` or `related` edge could vanish silently, taking a retrieval route with it. `raw_source` was the narrower case: [ADR-0027](0027-fragmentation-scope-is-a-declared-allowlist.md)'s floor means `source` pages never consolidate, so it could only bite through a custom consolidatable kind carrying one.

## Decision

The losslessness gate compares frontmatter too, by **target containment, not equality**. For every absorbed page:

- **Every outgoing edge target**, across every key in `EdgeKeys` — `raw_source`, `supersedes`, `refines`, `contradicts`, `example-of`, `source`, `related` — must appear somewhere in the survivor's frontmatter edges, **under any key**. Re-typing an edge on a merge is judgment, so `refines` surviving as `related` is accepted; an absorbed edge pointing at a page the consolidation itself absorbs, or at the survivor, is exempt — both collapse into the survivor.
- **The cluster's tags must be unioned** into the survivor's `tags`.
- **`volatility` must be the most volatile member's**, the survivor's own former value included — the sentence the procedure already stated, now asserted.

`summary` stays free author judgment. Like the body comparison, this runs in validation and again in the executor immediately before the delete, and every absorbed page's frontmatter is read once at resolve time alongside its body.

## Why

- **Typed edges are knowledge, and the delete is the point of no return.** ADR-0021 leaves the linter out of the guarantee: losslessness is a property of the executor. A gate that checks only bodies verifies half of what it deletes.
- **Equality would refuse legitimate merges.** Two absorbed `related` edges to one target become one; a `refines` edge can go meaningless once the pages are one. Containment asks the question that matters — did a target disappear? — without freezing the edge typing the merge is allowed to improve.
- **Key-agnostic containment is the weakest rule that still catches loss.** It tolerates re-typing, which judgment needs. It does not assert that a *relation's type* survives; `supersedes` carried forward as a `related` target passes. The alternative — same-key containment — refuses exactly the re-typing the merge exists to do.
- **Tags are exact-match retrieval inputs.** They are compared literally and unioned; a dropped tag is a dropped filter.
- **The volatility rule was already the procedure's, stated as prose no one checked.** Asserting it makes the rule about the vault rather than about the agent's diligence.
- **Absorbed-to-absorbed edges cannot survive as edges.** After the delete both endpoints are the survivor, so a self-edge is the only reading; exempting them is what makes containment a statement about the rest of the graph.
- **A single-link key needs its scalar path.** `edges.raw_source` names one ref, and the writer used to write it as a list the reader ignores. Carrying an absorbed `raw_source` is only possible through that path once it writes a scalar — `frontmatter.raw_source` is the `plan.raw` sentinel and `plan.raw` is refused on a Consolidation.

## Considered options

- **Frontmatter equality with the union.** Refuses legitimate re-typing and duplicate-target collapse; the merge is a place judgment is meant to be applied.
- **Same-key containment.** Catches more, but refuses the re-typing the procedure invites; it makes the gate an oracle about spelling rather than about surviving targets.
- **Assert the union by having the executor merge frontmatter automatically.** Would write edges the agent never chose, and edges are exactly the judgment this gate should not take over.
- **Leave it as prose.** The reported failure mode: the declaration is unverified, so it drifts from what the executor does.
- **Cover `summary` and `volatility` too, by equality.** `summary` is a fresh one-line statement about the merged page, not a union of its parts; volatility is a maximum, not a copy.
- **Skip `raw_source` as unreachable.** True for the canonical kinds and false for a custom consolidatable one; excluding it would leave that kind's pages silently lossy.

## Consequences

- `ingest.ts` gains `frontmatterLosslessnessErrors`, called from the same `losslessnessErrors` the body gate uses, so validation and the executor's pre-delete re-check cannot disagree about either half.
- `ResolvedConsolidation` captures each absorbed page's frontmatter facts and the survivor's, once at resolve time, exactly as it already captures bodies — an unreadable frontmatter is refused rather than read as edge-less (`chainofevidence`'s precedent).
- `applyFrontmatter` writes single-link edge keys as scalars, and shape validation refuses a key given more than one ref; `edges.raw_source` becomes the documented way for a Consolidation survivor to carry an absorbed `raw_source` forward.
- The wiki-ingest Consolidation reference states the frontmatter rules and the carrying path; the gate's fuller skill-text treatment remains [#658](https://github.com/dhague/wiki-knowledge/issues/658).
- [ADR-0030](0030-consolidation-losslessness-compares-content-not-bytes.md)'s remaining "frontmatter outside the comparison" clause is superseded here; its body boundary is unchanged.
