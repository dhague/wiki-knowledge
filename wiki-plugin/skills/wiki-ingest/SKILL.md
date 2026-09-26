---
name: wiki-ingest
description: Ingest raw documents into schema-valid wiki pages — one file, a folder sweep, or a wiki-lint Consolidation handoff — chunked, placed, tagged, linked, and committed per the wiki-conventions contract.
---

# Wiki Ingest

Reads `wiki-conventions` for anything this procedure doesn't spell out. Folder/`raw/` sweeps belong to invoking session, not agent.

The script layer ships in this skill's `scripts/` directory. Resolve it once before any step that calls it — the host reports this skill's base directory when the skill loads:

```bash
RUNTIME=$(command -v node || command -v bun)
ENCHIRIDION="<this skill's base directory>/scripts/enchiridion.cjs"
```

Every call below is `"$RUNTIME" "$ENCHIRIDION" <subcommand> <args...>`, and the script resolves the vault root itself — `$WIKI_ROOT` first, else the nearest ancestor holding a `wiki/` directory or `.wiki-root` marker, else the cwd. If neither runtime is present, say so and stop.

[`wiki-conventions` → Scripts](../wiki-conventions/SKILL.md#scripts) — the shared reference for vault-root resolution and the full subcommand catalogue

## Invocation

- A folder argument, or no argument — **sweep**, not single ingestion. Read [`reference/sweep.md`](reference/sweep.md) and follow it instead.
- A file argument — ingest one document. Procedure below.
- **Consolidation** — a cluster handoff from the `wiki-lint` procedure's `concept-fragmentation` check (CONTEXT.md, **Consolidation**), naming a survivor and the refs it absorbs: sourced from pages, and it deletes committed pages. Follow step 4's Consolidation variant.
- **If this session can spawn a subagent** and the work is a single file: delegate only — hand the `wiki-ingest` procedure the document path, relay its returned report verbatim (manifest plus lint findings). Then scan output for any `kind-md-proposal` blocks; for each, ask: *"Create `<folder>/KIND.md` for kind `<kind>`? Proposed summary: `<summary>`"* — on explicit yes, write that file with frontmatter `kind: <kind>` and `summary: <summary>` (no other fields required; optional freeform body may follow the closing `---`). Declining is safe — ingestion already committed against the bare folder. A Consolidation delegates the same way, naming the cluster's member refs and the check's suggested survivor — never author the merged body here.
- **If already running the procedure as a subagent**, continue with procedure using own tools. (Single-file work only.)

## Procedure

Given one document at `<path>`.

1. **Read** document in full; also read its folder's `INGESTION.md` if it exists — issue both reads in one message (see [`reference/ingestion-hints.md`](reference/ingestion-hints.md)). Hints override defaults below.
2. **Semantic-chunk.** One page or several? Default one; split when document covers multiple independent ideas deserving own future citation.
3. **Draft the plan, then discover, then classify.** Write `<plan.json>` now — the file step 4 finishes and step 5 runs. Give every candidate chunk from step 2 a `pages` entry with `title`, `frontmatter.summary`, `body` (full shape in step 4); leave `edges` and unjudged frontmatter for step 4. Run `"$RUNTIME" "$ENCHIRIDION" discover --plan <plan.json> --tags-containing "<candidate tags, comma list>" --tag-count "<candidate tags, comma list>"` once against the whole draft — one call per draft, both flags derived from this draft's own candidate tags, always both. Candidates come back classified `duplicate`/`refines`/`related` (no `distinct` — score-filtered out); `tag_matches`/`tag_counts` feed step 4 tag-minting. Discovery reads only — step 4 owns every write.

   Hint is a starting point — confirm or override against the candidate's own `summary`; record only which **op** each entry gets ([verify rule](../wiki-conventions/SKILL.md#verify-against-the-source)).
   - **No candidates.** New subject. Keep as `op: "create"`; consider any vault page as a typed-edge target in step 4.
   - **`related`.** Worth a typed edge (usually `related`, sometimes `example-of`) from the new page in step 4, not same subject — keep as `op: "create"`.
   - **`duplicate` or `refines`, no conflict.** Candidate adds to or restates an existing page without contradicting. Set the entry to `op: "update"` targeting `page_ref` — step 4 fills whichever of `summary`/`tags`/`source_date`/`volatility`/`body` changes. Record as `updated`, not `created`, in the manifest and commit.
     - List-valued keys (`tags`, edge-lists: `refines`/`contradicts`/`example-of`/`source`/`related`/`supersedes`) **unioned** with existing values when `enchiridion ingest` applies plan — never diff, always full intended membership.
   - **Contradiction.** Candidate conflicts with an existing page's claim — the hint only measures lexical overlap, so judge it regardless. **Never overwrite existing page.** Keep the new page as `op: "create"`, set `contradicts` and `supersedes` on it pointing at the superseded `page_ref`. Superseded page content untouched; only the new page carries these edges. Decide which claim is right against the artifact the figure came from, never by which text was read last.
   - Candidate touching multiple existing pages: judge each pairing independently — one document can update one while contradicting another.
4. **Finish the plan.** Fill `edges` and any frontmatter step 3 left open on `<plan.json>`; step 5 executes it. Full shape:

   ```jsonc
   {
     "title": "<source document's title>",
     "source_date": "<the document's own date, not today's>",  // pages inherit it
     "raw": "raw/<artifact's path, exactly as it sits on disk>",   // omit if nothing came from raw/
     "pages": [
       {
         "op": "create",                 // source/ stub — mandatory when "raw" is set
         "kind": "source",
         "title": "<the artifact's own title>",
         "body": "<what this artifact is; thin when distilled below>",
         "frontmatter": {
           "summary": "<one line, ≤~20 words>",
           "raw_source": true,           // the "raw" stub — this kind only
           "volatility": "stable"        // an artifact is frozen: its stub is stable
         },
         "edges": {}
       },
       {
         "op": "create",
         "kind": "concept",              // any `vault kinds` kind; first match wins
         "title": "<page title>",
         "body": "<full markdown body>",
         "frontmatter": {
           "summary": "<one line, ≤~20 words>",
           "tags": ["<tag>"],
           "source_date": "<omit to inherit the plan's date>",
           "volatility": "stable | evolving | volatile"
         },
         "edges": {
           "source": ["wiki/sources/<stub-slug>.md"],  // mandatory back-edge to the stub above
           "related": ["<page reference>"],
           "supersedes": ["<page reference>"]           // when step 3 found a contradiction
         }
       },
       {
         "op": "update",
         "page_ref": "wiki/concepts/existing-page.md",   // step 3's substantive-overlap page
         "title": "<unchanged or corrected title>",
         "frontmatter": { "volatility": "evolving", "tags": ["new-tag"] },   // keys this update rewrites
         "edges": {
           "source": ["wiki/sources/<stub-slug>.md"],  // an updated page needs it too
           "related": ["<page reference>"]
         }
       }
     ]
   }
   ```

   Every `edges` value and `raw_source: true` names its target by **page reference** — vault-relative path only, `wiki/concepts/foo.md` — never a composed `[Title](../dest.md)` string; `enchiridion ingest` composes the link. Exception: *body* links are ordinary markdown (`[label](destination)`), encoded or not — `enchiridion ingest` re-encodes on write.

   **Every written page needs `volatility`** — judgment that can't be inherited: `enchiridion ingest` refuses a `create` without it, and an `update` whose `frontmatter` map omits it. So an `update` supplying a frontmatter map must restate it (`stable | evolving | volatile`), or it lands a page `wiki-lint`'s `missing-volatility-source-date` check reports.

   **Consolidation variant — `action: "consolidate"`** (CONTEXT.md, **Consolidation**): one page, the **survivor** (`op: "update"`, or `op: "create"` for a fresh one) whose `body` carries each absorbed body as a section, plus a top-level `"consolidates"` list of the absorbed page references, and no `raw`. Judgment around the survivor: [`reference/consolidation.md`](reference/consolidation.md) — read before authoring one.

   Judgment calls when filling in (folder's `INGESTION.md` may override any):
   - **Kind** (create pages only): `"$RUNTIME" "$ENCHIRIDION" vault kinds --json` gives the placement vocabulary; apply [Placement algorithm](../wiki-conventions/SKILL.md#placement-algorithm), first match wins. A custom kind-folder is a peer target — never emit a kind `vault kinds` doesn't return. Leave the filename to `enchiridion ingest`, which derives the kebab-slug from `kind` + `title` — never hand-slugify. A chosen custom kind with `definition: null` is noted for step 7's `kind-md-proposal` block; placement into the bare folder completes regardless.
   - **The `source/` stub is not optional** (see [The chain of evidence](../wiki-conventions/SKILL.md#the-chain-of-evidence)) — thin fine, absent not. Prior pass already filed the stub: target it with `op: "update"`, not a second create.
   - **Typed edges** ([vocabulary](../wiki-conventions/SKILL.md#typed-edges)) — judge for **every new or updated page** against every page surfaced in step 3. Assign the most specific type true (`related` only as fallback); `contradicts`/`supersedes` decided by step 3, belong on the *new* page only.
     - Non-judgment edge: **every page except the stub carries a `source` edge to it** — each chunk of a multi-chunk split, `op: "update"` same as `create`. Edges merge on update so restating is safe; omit only if the page already carries it from an earlier pass.
   - **Body** for an `update`: write the *complete* new body (not a diff) when material changes; omit `body` entirely to leave the existing body untouched.
   - **Body states facts only** ([rule](../wiki-conventions/SKILL.md#pages-state-facts)) — never narrate a correction or the vault's own process; a live disagreement goes in a `> [!warning] Contradiction` callout, in facts, naming both statements.
   - **Verify the body against the artifact before it lands** ([rule](../wiki-conventions/SKILL.md#verify-against-the-source) — the artifact, then the primary source where it is silent).
   - **`raw_source: true`** derives its link from the plan's `raw` field. **Ingestion never renames raw file** — a file from outside the plugin keeps its name verbatim.
5. **Run it.** `"$RUNTIME" "$ENCHIRIDION" ingest --plan <plan.json>` validates the whole plan before writing, then executes place → frontmatter → body → commit in one pass and prints the commit SHA. The index is not touched — the next search's staleness scan picks the pages up. On error: nothing committed, written pages left on disk uncommitted (writes idempotent — fix plan and rerun, don't hand-repair).
6. **Lint.** After the commit — never after a failed step 5 — run every [mechanical check](../wiki-lint/SKILL.md#2-run-mechanical-checks) over the vault in one call:

   `"$RUNTIME" "$ENCHIRIDION" check --all --json`

   One JSON Lines row per finding, each naming its own check: `{"check", "pageRef", "detail"}`, plus `concept-fragmentation`'s structured `cluster`. Silent when the vault is clean. The written pages are what the mechanical checks read back against the contract — the pipeline's own output is where it fails. The judgment checks (stale claims, implicit concepts, cross-references, data gaps, summary quality, under-typed edges) stay in `wiki-lint`: they cost per-page reading, and their fixes need a confirmation this procedure cannot ask for.
7. **Report.** Short manifest only — pages created vs. updated, edges added, `supersedes` pairs recorded; then the lint findings from step 6, one line each as the engine emitted them, `HIGH`-first per [wiki-lint's priority order](../wiki-lint/SKILL.md#6-report). Any `concept-fragmentation` cluster is reported as a wiki-lint Consolidation handoff, not acted on here. No page-content dumps. If step 4 noted a custom kind with no `definition`, append one `kind-md-proposal` block per distinct missing-definition folder (invoking session uses this — see `## Invocation`):

   ````markdown
   ```kind-md-proposal
   kind: person
   summary: A named individual referenced across multiple pages
   folder: wiki/people
   ```
   ````

   `kind` is the value used in the plan; `summary` is a one-line definition (≤ ~20 words) inferred from the folder name and the content filed; `folder` is the vault-relative folder path.
