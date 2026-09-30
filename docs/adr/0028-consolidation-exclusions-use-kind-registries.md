# Consolidation exclusions use committed kind-level registries

A declined Consolidation is a decision about a same-kind cluster, not a property of any one page, so it is recorded once in `CONSOLIDATION_EXCLUSIONS.yaml` in that kind-folder rather than duplicated in page frontmatter. Each exact-cluster record carries its members, a human-readable reason, their Git blob object IDs as the validation fast path, and semantic fingerprints as the fallback: fingerprints cover canonical title, summary, typed relationships, `supersedes`, and body, but ignore tags, source date, volatility, YAML formatting, and field order.

When a blob changes but its semantic fingerprint does not, lint refreshes the cached object ID automatically. A semantically changed member drops from the effective exclusion while unchanged members remain; a record ceases to exclude anything when fewer than two members remain. `contradicts` or `supersedes` between candidate pages already proves they must remain separate and needs no registry record. The registry and candidates are both evaluated against committed `HEAD`, preserving ADR-0015's snapshot boundary.

## Considered options

- **Page frontmatter.** Rejected because a cluster-level decision would need an arbitrary owner or reciprocal copies whose consistency had to be maintained.
- **Git object IDs alone.** Rejected because irrelevant edits to tags, dates, volatility, or YAML formatting would repeatedly revive an unchanged decision.
- **Semantic fingerprints alone.** Correct but misses the cheap common case: an unchanged blob can be accepted without examining its semantic projection.

## Consequences

- One visible, versioned registry exists per consolidatable kind-folder only when that folder has exclusions. Humans inspect and remove records by editing the YAML directly; agents add and maintain them through deterministic script operations.
- Exclusions apply to their exact current member set regardless of the lexical similarity threshold. A different subset or superset receives a fresh recommendation, except that partial invalidation deliberately leaves the unchanged members as the effective excluded set.
- Malformed registries fail open for candidate reporting and produce a high-priority integrity finding. A semantically equivalent blob-ID refresh is an auto-fix; persisting stale-member pruning remains confirm-first.
