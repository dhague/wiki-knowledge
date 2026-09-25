# Wiki Ingest — Consolidation procedure

Read only when the prompt names a **Consolidation** — the `wiki-lint` procedure's handoff for the `concept-fragmentation` check (CONTEXT.md, **Consolidation**). The single-file procedure in [`../SKILL.md`](../SKILL.md) does not apply: a Consolidation is sourced from *pages*, not from an artifact, and it **deletes committed pages**. Step 4's **Consolidation variant** owns the plan shape; this file owns the judgment around it.

**Input:** the cluster's member refs plus the check's suggested survivor. **Output:** one plan through `enchiridion ingest` — survivor written, every inbound link repointed, absorbed pages deleted, one commit under `deleted:`.

The script layer ships in this skill's `scripts/` directory. Resolve the runtime and the bundle once before any step that calls it — `node` where it exists, `bun` where it does not (the fallback for a host that ships only Bun) — and this skill's base directory as the host reports it when the skill loads:

```bash
RUNTIME=$(command -v node || command -v bun)
ENCHIRIDION="<this skill's base directory>/scripts/enchiridion.cjs"
```

Every call below is then `"$RUNTIME" "$ENCHIRIDION" <subcommand> <args...>`. If neither runtime is present, say so plainly and stop.

## Procedure

1. **Read every member in full.** `"$RUNTIME" "$ENCHIRIDION" read-page <ref> --json` gives `{page_ref, frontmatter, body}`; without `--json` it prints the raw markdown. Read all of them before drafting: the merge must be lossless, so no part of the survivor may be written from a summary or from the linter's one-line `detail`.

2. **Judge the cluster before merging.** The check's similarity is lexical — whether these pages are one concept is your call.
   - One concept, no conflict → consolidate.
   - Merely *related* → stop and report. That is a typed edge — the `missing-cross-references` check's proposal — not a Consolidation. Never merge just because the linter proposed it.
   - Members *contradict* → stop and report. A contradiction is supersession — a flow that keeps both pages — not a lossless merge.

3. **Pick the survivor.** Default to the check's suggestion (most inbound links, largest body as tie-break). Override it when another member holds the cluster's subject more centrally, or when a fresh page reads better than bloating an existing one: a `create` survivor is a first-class choice, not a fallback.

4. **Author the survivor body.** Keep the survivor's own content, then add each absorbed page's content as a section (`## <absorbed page's title>`), carrying every claim, citation and link across. **Re-base sibling links** copied out of another kind-folder: the executor compares an absorbed body against the merged one by *where its links point*, so a verbatim copy that keeps its old `../` prefix fails the losslessness gate even though the text is present. Frontmatter (`summary`, `tags`, typed edges) is your judgment about the merged page; list keys union as on any update.

5. **Write the plan** to a scratch file, never inside the vault — step 4's Consolidation variant: `"action": "consolidate"`, a top-level `"consolidates"` naming the absorbed refs, and `pages` holding exactly one entry, the survivor, whose `body` is the full merged text.
   - Existing survivor: `op: "update"` with `page_ref`, and **no** `kind` (the executor rejects a kind on an update).
   - Fresh survivor: `op: "create"` with `title`, `kind` and `body`.
   - No `raw`, no `raw_source`, no second page, no ref named twice, survivor never listed in `consolidates`.

6. **Run it and report.** `"$RUNTIME" "$ENCHIRIDION" ingest --plan <plan.json>` validates the whole plan before writing — each absorbed body readable in the survivor's body, every ref a real page, the survivor not absorbing itself — then commits once and prints the SHA. Report the survivor, the deleted refs and the SHA. No page-content dump. On error nothing was committed: fix the plan and rerun rather than hand-repairing, which is safe because writes are idempotent and the survivor is written before anything is deleted.
