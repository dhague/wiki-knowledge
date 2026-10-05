# Consolidation assessment and the exclusion offer

The `concept-fragmentation` check finds clusters mechanically; this file owns the
content-based read that turns one into a recommendation, and the boundary
between the recommendation and the four writes it can lead to. Step 3 of
[`../SKILL.md`](../SKILL.md) runs the assessment; step 6 presents it.

## The assessment

Read one cluster at a time, every member in full, from one committed snapshot:

```bash
"$RUNTIME" "$ENCHIRIDION" assess <member-ref-1> <member-ref-2> [<member-ref-3> ...]
```

One JSON document on stdout: `{head, members: [{page_ref, blob_oid, fingerprint,
title, bytes, text}]}`. It reads `HEAD`, so an uncommitted draft is invisible —
the same view the check scored. It fails, naming the page, when a member is not a
readable committed page.

Emit exactly one disposition per cluster, judged from the bodies you read — never
from the check's `detail`, and never from a summary:

```json
{
  "head": "<assess head>",
  "disposition": "consolidate",
  "members": [{"page_ref": "wiki/concepts/a.md", "blob_oid": "<assess oid>"}],
  "survivor": "wiki/concepts/a.md",
  "rationale": "One concept, two halves: a covers eviction policy, b the invalidation that triggers it.",
  "relationships": []
}
```

- `consolidate` — the pages express one concept, with no claim in conflict.
  Recommend a survivor. Default to the check's `suggestedSurvivor`; override it
  when another member holds the subject more centrally, or when a fresh page
  reads better than bloating an existing one.
- `relate` — the pages are distinct concepts that belong joined. Recommend the
  specific typed edges in `relationships`, each a `{key, target}` pair drawn from
  the [typed-edge vocabulary](../../wiki-conventions/SKILL.md#typed-edges).
- `conflict` — the claims conflict. Name the conflict in `rationale` and
  recommend the contradiction/supersession flow: keep both pages, record which
  one wins.

`rationale` is one or two sentences naming the pages and the reason, with page
links where that reads better; `head` and every member's `blob_oid` come
verbatim from the `assess` document. **No assessment writes anything** — no
Consolidation, no edge, no supersession, no exclusion — and no assessment offers
a write the user has not separately confirmed.

## Unassessable clusters

When `assess` fails for a cluster — a member is not a readable committed page —
report that the cluster could not be assessed and recommend nothing: no
disposition, no survivor, and no exclusion offer. Say why, and note that a later
run against a fresh snapshot will retry. Do not fall back to the check's
mechanical suggestion, which is a hint about clustering, not a judgment about
content.

## The four writes, and who confirms what

Each is confirmed on its own; a yes to one is never a yes to another.

| Disposition | Offer | Command on yes |
|---|---|---|
| `consolidate` | Consolidate into `<survivor>`? | hand off to the `wiki-ingest` procedure with the assessment |
| `relate` | Add `<key>` edge to `<target>`? | [`proposals.md`](proposals.md) — edge retyping |
| `conflict` | Record the supersession? | [`proposals.md`](proposals.md) — edge review, **Supersede** |
| any declined `consolidate` | Record a Consolidation exclusion? | `"$RUNTIME" "$ENCHIRIDION" exclusion add <refs...> --reason "<rationale>"` |

**On accepting a Consolidation**, the handoff carries the assessment: the
`wiki-ingest` procedure reads the same members, authors the merged survivor, and
pins the plan to the assessed snapshot (`head` and each member's `blob_oid`). A
snapshot that moved before the write refuses the plan rather than merging stale
bodies — re-run the assessment.

**On declining a Consolidation**, offer the exclusion once, naming the exact
member set. The command records the members' current revisions in the
kind-folder's `CONSOLIDATION_EXCLUSIONS.yaml` and commits the registry on its
own; nothing else is written. Declining the offer leaves the vault unchanged, and
the cluster stays eligible to be proposed again. Never record an exclusion
without that yes, and never edit the YAML by hand — the blob object IDs and
fingerprints are the script's to calculate.

The exclusion covers exactly that member set: a different subset or a superset
(say, a third near-duplicate joins later) is assessed afresh. An edit that
changes none of a page's meaning keeps the exclusion valid; an edit that changes
its title, summary, typed edges or body drops that member out, and a record left
with fewer than two members stops suppressing anything.

## Registry findings

The `consolidation-exclusions` check reports the registry's own problems, and
none of them is a Consolidation proposal:

- **Malformed** (`registry integrity: …`) — nothing in the file suppresses
  anything until the YAML is repaired by hand. Report only.
- **A member that no longer matches `HEAD`** — confirm first:
  `"$RUNTIME" "$ENCHIRIDION" fix consolidation-exclusions --prune` drops the
  stale and uncommitted members, and deletes a record left with fewer than two.
  Without `--prune` the same fix only refreshes cached blob IDs and collapses
  identical records, and step 5 runs it.
- **Identical duplicate records** — auto-fixed by the same command.
