# Confirm-first proposal shapes

The exact wording and command for each confirm-first shape. Step 5 of
[`../SKILL.md`](../SKILL.md) owns when to present one and how to resolve it;
every command here assumes the `$RUNTIME` / `$ENCHIRIDION` pair is resolved.

**Consolidation** (`concept-fragmentation`) — "Pages `<a>`, `<b>`[, `<c>`] read
as one concept (basis: `<shared tags / shared title terms>`, weakest pairwise
similarity `<s>`). Consolidate into `<suggested-survivor>`?" Name every member
with its committed size and inbound-link count, so the user can judge the
suggested survivor — and offer to override it, a judgment the ingest flow also
gets to make.

Command on yes: hand off to the `wiki-ingest` procedure with the survivor and
the absorbed refs — that flow reads each member's body, authors the merged
survivor, and lands the one atomic commit.

On no: skip the cluster.

**Cross-reference insertion** (ambiguous) — "Page `<page>` mentions '<title>'
without linking to it, but multiple candidate pages match. Which page should be
linked?" Present the candidate list and wait for a selection or "skip". On
selection: insert the relative markdown link inline at the first unlinked
mention.

**Kind-folder conformance** (`kind-folder-conformance`) — "Page `<path>` is not
directly under a valid kind-folder. Move it to `wiki/<correct-kind>/`?
`enchiridion vault move` rewrites all inbound links."

Command on yes: `"$RUNTIME" "$ENCHIRIDION" vault move <old-ref> <new-ref>`

**Implicit concept** — "Term '<term>' appears in N pages without its own concept
page. Create one?" Command on yes: invoke the `wiki-ingest` procedure with the
term and the context pages as input.

**Edge retyping** — "In `<page>`, `related:` → `<target>` looks like
`<specific-type>` because `<reason>`. Retype?"

Command on yes: `"$RUNTIME" "$ENCHIRIDION" page merge <absolute-path> <specific-type> '["<vault-relative-ref>"]'`, then rewrite `related:` without that target via `page set <absolute-path> related --json '<remaining-links>'`. An edge value is a markdown link or a vault-relative ref (`wiki/concepts/foo.md`) — the command composes the link. `page set` **replaces** a list-valued key; `page merge` **unions** into it.

**Edge review** (over-typed and stale edges) — "In `<page>`, `<type>:` → `<target>`: `<why the recorded type does not hold>`. Which disposition — keep, retype, drop, or supersede?" Name the reason from both bodies, and offer every disposition the case admits.

- **Keep** — the edge holds and its justification is missing: add the `> [!warning] Contradiction` callout to `<page>`'s body ([`wiki-conventions`](../../wiki-conventions/SKILL.md#typed-edges)).
- **Retype** — the relationship holds under a different type; run the Edge-retyping command above with the recorded type in place of `related`.
- **Drop** — `"$RUNTIME" "$ENCHIRIDION" page set <absolute-path> <type> --json '<remaining-links>'`, then delete the empty key by hand when that was its only link — the conventions omit a key with no links, and `page set` leaves an empty list. A page whose own claim is the error needs its body corrected too, which no edge edit does.
- **Supersede** — `<page>` replaces `<target>`: keep the `contradicts:` edge and record the replacement with `"$RUNTIME" "$ENCHIRIDION" page merge <absolute-path> supersedes '["<target-ref>"]'`.

**Delete orphan page** — "Page `<path>` has no inbound links and no apparent
purpose. Delete it?"

Command on yes: `git -C <vault-root> rm <vault-relative-path> && git -C <vault-root> commit -m "chore: remove orphan page <path>"`
