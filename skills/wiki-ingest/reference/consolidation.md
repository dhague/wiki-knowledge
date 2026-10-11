# Wiki Ingest — Consolidation procedure

Read only when the prompt names a **Consolidation** — the `wiki-lint` procedure's handoff for the `concept-fragmentation` check. A Consolidation absorbs a cluster of pages into one survivor, each absorbed page's content becoming a section of it and every inbound link repointed; lossless by construction, which is why the absorbed pages are **deleted** rather than recorded as superseded. The single-file procedure in [`../SKILL.md`](../SKILL.md) does not apply: a Consolidation is sourced from *pages*, not from an artifact, and it **deletes committed pages**. Step 4's **Consolidation variant** owns the plan shape; this file owns the judgment around it.

**Input:** the cluster's members plus the `wiki-lint` assessment — its disposition, rationale and recommended survivor. **Output:** one plan through `enchiridion ingest` — survivor written, every inbound link repointed, absorbed pages deleted, one commit under `deleted:`.

The script layer ships in this skill's `scripts/` directory. Resolve it once before any step that calls it — the host reports this skill's base directory when the skill loads:

```bash
RUNTIME=$(command -v node || command -v bun)
ENCHIRIDION="<this skill's base directory>/scripts/enchiridion.cjs"
```

`ENCHIRIDION` MUST be an absolute local filesystem path. A harness-internal `skill://` URI is not one — the runtime is an external process and resolves it as a relative file path, so the call fails before the script runs. If the host reports the base directory as such a URI rather than a real path, convert it first (`baseDir=$(realpath '<base-dir>')`).

Every call below is `"$RUNTIME" "$ENCHIRIDION" <subcommand> <args...>`. If neither runtime is present, say so and stop.

[`wiki-conventions` → Scripts](../../wiki-conventions/reference/scripts.md#script-runtime-contract) — the shared reference for vault-root resolution and the full subcommand catalogue

## Procedure

1. **Read every member in full, from one snapshot.** `"$RUNTIME" "$ENCHIRIDION" assess <ref> <ref> [...]` gives one JSON document — `{head, members: [{page_ref, blob_oid, fingerprint, title, bytes, text}]}` — reading `HEAD` only. Read all of them before drafting: the merge must be lossless, so no part of the survivor may be written from a summary, from the handoff's rationale, or from the check's one-line `detail`. The `head` and each `blob_oid` are what step 5 pins. If it fails, the cluster could not be assessed — stop and report; nothing is written.

2. **Judge the cluster before merging.** The check's similarity is lexical and the handoff's disposition is a recommendation — whether these pages are one concept is your call, and you may overrule it.
   - One concept, no conflict → consolidate.
   - Merely *related* → stop and report. That is a typed edge — the `missing-cross-references` check's proposal — not a Consolidation. Never merge just because the linter proposed it.
   - Members *contradict* → stop and report. A contradiction is supersession — a flow that keeps both pages — not a lossless merge.

3. **Pick the survivor.** Default to the assessment's recommendation (itself defaulting to the check's suggestion: most inbound links, largest body as tie-break). Override it when another member holds the cluster's subject more centrally, or when a fresh page reads better than bloating an existing one: a `create` survivor is a first-class choice, not a fallback.

4. **Author the survivor body.** Keep the survivor's own content, then add each absorbed page's content as a section (`## <absorbed page's title>`), carrying every claim, citation and link across. **Re-base sibling links** copied out of another kind-folder — see [the losslessness gate](#the-losslessness-gate). Frontmatter (`summary`, `tags`, `volatility`, typed edges) is your judgment about the merged page; list keys union as on any update, and a survivor whose plan rewrites frontmatter must carry `volatility` (`stable | evolving | volatile`) — a fresh `create` survivor always does. Set the survivor's `volatility` to the most volatile member's: a merge is only as durable as its shakiest part.

5. **Write the plan** to a scratch file, never inside the vault — step 4's Consolidation variant: `"action": "consolidate"`, a top-level `"consolidates"` naming the absorbed refs, and `pages` holding exactly one entry, the survivor, whose `body` is the full merged text.
   - Existing survivor: `op: "update"` with `page_ref`, and **no** `kind` (the executor rejects a kind on an update).
   - Fresh survivor: `op: "create"` with `title`, `kind` and `body`.
   - No `raw`, no `raw_source`, no second page, no ref named twice, survivor never listed in `consolidates`.
   - **Pin the snapshot you authored from**: a top-level `"assessed"` holding `{"head": "<assess head>", "members": [{"page_ref": "<absorbed ref>", "blob_oid": "<its assess oid>"}]}`, one entry per absorbed ref, copied verbatim from step 1. The executor refuses the plan when `HEAD` or any pinned member moved, so a stale merge never lands; re-run step 1 rather than editing the pin.

6. **Run it and report.** `"$RUNTIME" "$ENCHIRIDION" ingest --plan <plan.json>` validates the whole plan before writing — each absorbed body readable in the survivor's body, every ref a real page, the survivor not absorbing itself, the pinned snapshot still current — then commits once and prints the SHA. Report the survivor, the deleted refs and the SHA. No page-content dump. On error nothing was committed: fix the plan and rerun rather than hand-repairing, which is safe because writes are idempotent and the survivor is written before anything is deleted.

## The losslessness gate

`ingest` refuses a Consolidation that drops content: every word of each absorbed page — and of an `update` survivor's own former body — must survive in the survivor's authored body, in order, as one unbroken run of top-level blocks. Presentation is not compared (ADR-0030, ADR-0021). The authoring rule is short:

- **Free:** reflow a paragraph, change a heading's level or spelling, change a bullet glyph, renumber an ordered list, re-pad or realign a table.
- **Required:** every word, digit, identifier and punctuation mark; block order and list depth; fenced and inline code, including its fence language, verbatim; raw HTML, verbatim; link labels and image alt text. `**x**` and `*x*` are different claims, and so are a link and an image.

The bullets are the authoring rule, not the boundary itself (ADR-0030); when in doubt, carry the text across unchanged.

Links are compared by where they resolve, not how they are spelled — a destination outside the vault is compared literally — so a body copied into another kind-folder matches once its destinations are re-based (step 4). Line endings are normalised before the comparison, so the author need not match the working tree's endings.

**Bodies only.** Frontmatter is outside the comparison on both sides: an absorbed page's typed edges and `raw_source` are your judgment for the merged page, not part of the guarantee. An `update` survivor's own former body is covered too; a `create` survivor has no prior body, so only the absorbed pages are checked.

**When it runs.** During `ingest` validation, before any write, and again in the executor before it writes the survivor or deletes the absorbed pages. There is no partial-commit state to inspect: the one `ingest` invocation is the whole feedback loop.

**What failure looks like.** Exit code 1, nothing committed, and a single stderr line beginning `invalid plan: `, its problems joined by `; `. The gate's own problem names the absorbed ref — or says the survivor's own former content — and quotes the opening line of the first block that failed to match:

```
invalid plan: plan.consolidates: the survivor's body does not contain wiki/concepts/caching-ttl.md's content, starting at "A cache entry expires after its TTL." — a Consolidation is lossless (ADR-0021)
```

**What to do.** Carry that block into the survivor body and rerun the same plan — writes are idempotent, and the survivor lands before anything is deleted.

**The pin is required.** A `consolidate` plan without `assessed` is refused outright. The gate cannot see an absorbed page that *shrank* between the assessment read and the write — the shorter text is still contained — so the pin, not the comparison, is what stops a merge silently dropping what the absorbed page lost.
