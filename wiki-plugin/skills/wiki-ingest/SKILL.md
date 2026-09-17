---
name: wiki-ingest
description: Turn a raw document into one or more schema-valid wiki pages — chunked, placed, tagged, linked, and committed per the wiki-conventions contract. Invoke via /wiki-ingest <path>.
---

# Wiki Ingest

Reads `wiki-conventions` for anything this procedure doesn't spell out — folder placement, frontmatter schema, link format, typed-edge vocabulary. Folder/`raw/` sweeps belong to invoking session, not agent — [`reference/sweep.md`](reference/sweep.md), read on demand.

Scripts live in plugin's install directory, resolve vault root itself — see `## Scripts` in `wiki-conventions` for full reference (vault-root resolution, locating the plugin root, common tasks, script catalogue).

**On Claude Code**, resolve the binary once before any step that calls it:
```bash
ENCHIRIDION=$(ls ~/.claude/plugins/cache/enchiridion-wiki-plugin/wiki-knowledge/*/bin/enchiridion | sort -V | tail -1)
```
Use `"$ENCHIRIDION"` for every call below. **On OpenCode** replace every `Bash` + `"$ENCHIRIDION" <subcommand> <args...>` call with `wiki(args=["<subcommand>", ...])` — same subcommand, same flags, no path to resolve.

## Invocation

- `/wiki-ingest <folder>` or `/wiki-ingest` (no path) — **sweep**, not single ingestion. `Read` [`reference/sweep.md`](reference/sweep.md) and follow it instead.
- `/wiki-ingest <file>` — ingest one document. Procedure below.
- `/wiki-ingest --consolidate <survivor-ref> <absorbed-ref>...` — **Consolidation**, handed off from `/wiki-lint` check 10 (CONTEXT.md, **Consolidation**; ADR-0021). Not an ingestion: it is sourced from pages, not an artifact, and it deletes committed pages. The `wiki-ingest` agent reads [`reference/consolidation.md`](reference/consolidation.md) and follows it instead of the single-file procedure.
- **If not already running as `wiki-ingest` agent** (system prompt doesn't identify you — e.g. invoked via `/wiki-ingest <path>` in ordinary session) and `<path>` is single file: delegate only. Call `Task` with `subagent_type: "wiki-ingest"` and prompt containing document path, relay returned manifest verbatim. Then scan output for any `kind-md-proposal` blocks; for each, ask: *"Create `<folder>/KIND.md` for kind `<kind>`? Proposed summary: `<summary>`"* — on explicit yes, write that file with frontmatter `kind: <kind>` and `summary: <summary>` (no other fields required; optional freeform body may follow the closing `---`). Declining is safe — ingestion already committed against the bare folder. A `--consolidate` invocation delegates the same way, prompt naming the cluster's member refs and the check's suggested survivor — never author the merged body in this session.
- **If you are `wiki-ingest` agent**, continue with procedure using own tools. (Single-file work only — sweep delegates one file at a time, per [`reference/sweep.md`](reference/sweep.md). A Consolidation is the exception: prompt names the member refs, so `Read` [`reference/consolidation.md`](reference/consolidation.md) and follow that.)

## Procedure

Given one document at `<path>`.

1. **Read** document in full; also read `<path>`'s folder's `INGESTION.md` if it exists — issue both reads in one message (see [`reference/ingestion-hints.md`](reference/ingestion-hints.md)). Hints override defaults below.
2. **Semantic-chunk.** One page or several? Default one; split when document covers multiple independent ideas deserving own future citation.
3. **Draft the plan, then discover, then classify.** Write `<plan.json>` now — same file step 4 finishes and step 5 runs; nothing written twice. Give every candidate chunk from step 2 a `pages` entry with `title`, `frontmatter.summary`, `body` filled in (full shape in step 4); leave `edges` and unjudged frontmatter for step 4. Run `"$ENCHIRIDION" discover --plan <plan.json> --tags-containing "<candidate tags, comma list>" --tag-count "<candidate tags, comma list>"` once against whole draft — no per-chunk calls, no scratch files. Derive both comma lists from this draft's own candidate tags (the tags step 2's chunks are likely to want); always pass both. Returns candidates classified `duplicate`/`refines`/`related` per page (no `distinct` — score-filtered out), each carrying `summary`, `tags`, `volatility`, `superseded_by` — plus, in place of the full `vocabulary` dump, `tag_matches` (the vault tags matching `--tags-containing`) and `tag_counts` (per-tag page counts for `--tag-count`; 0 means safe to mint) — named fields in that same one JSON document, so no second parse and no trailing text to strip. Both feed step 4 tag-minting.

   Hint is starting point — confirm or override against candidate's own `summary`; record only which **op** each plan entry gets. Step 4 owns every write; nothing here calls `Edit` or `enchiridion page`.
   - **No candidates.** New subject. Keep as `op: "create"`; consider any pages in the vault as typed-edge targets in step 4.
   - **`related`.** Worth typed edge (usually `related`, sometimes `example-of`) from new page in step 4, not same subject — keep as `op: "create"`.
   - **`duplicate` or `refines`, no conflict.** Candidate adds to or restates existing page without contradicting. Set plan entry to `op: "update"` targeting `page_ref` — step 4 fills whichever of `summary`/`tags`/`source_date`/`volatility`/`body` changes. Record as `updated`, not `created`, in manifest and commit.
     - List-valued keys (`tags`, edge-lists: `refines`/`contradicts`/`example-of`/`source`/`related`/`supersedes`) **unioned** with existing values when `enchiridion ingest` applies plan — never diff, always full intended membership.
   - **Contradiction.** Candidate conflicts with existing page's claim — semantic judgment hint can't make (only measures lexical overlap), check regardless. **Never overwrite existing page.** Keep new page as `op: "create"`, set `contradicts` and `supersedes` on it pointing at superseded `page_ref`. Superseded page content untouched; only new page carries these edges.
   - Candidate touching multiple existing pages: judge each pairing independently — document can update one while contradicting another.
4. **Finish the plan.** Fill `edges` and any frontmatter step 3 left open on `<plan.json>` — placement, frontmatter, body, commit one downstream call: `"$ENCHIRIDION" ingest --plan <plan.json>` (step 5). Full shape:

   ```jsonc
   {
     "title": "<source document's title>",
     "source_date": "<the document's own date, not today's>",
     "raw": "raw/<artifact's path, exactly as it sits on disk>",   // omit if nothing came from raw/
     "pages": [
       {
         "op": "create",                 // the artifact's source/ stub — mandatory whenever "raw" is set
         "kind": "source",
         "title": "<the artifact's own title>",
         "body": "<what this artifact is; thin when its content was distilled into the pages below>",
         "frontmatter": {
           "summary": "<one line, ≤~20 words>",
           "raw_source": true   // required here, omitted on every other kind — marks this page as the "raw" field's stub; `enchiridion ingest` composes the actual link
         },
         "edges": {}
       },
       {
         "op": "create",
         "kind": "concept",            // any kind returned by `enchiridion vault kinds` — canonical (source | synthesis | entity | concept) or a custom kind whose folder pre-exists; placement algorithm in wiki-conventions, first match wins
         "title": "<page title>",
         "body": "<full markdown body>",
         "frontmatter": {
           "summary": "<one line, ≤~20 words>",
           "tags": ["<reuse an existing tag where one fits, mint only when nothing does>"],
           "source_date": "<same as above, or this page's own if it differs>",
           "volatility": "stable | evolving | volatile"
         },
         "edges": {
           "source": ["wiki/sources/<stub-slug>.md"],  // mandatory back-edge to the stub above
           "related": ["<vault-relative path.md>"],
           "supersedes": ["<vault-relative path.md>"]           // include on the new page when step 3 found a contradiction to resolve
         }
       },
        {
          "op": "update",
          "page_ref": "wiki/concepts/existing-page.md",   // the page step 3 classified as substantive-overlap
         "title": "<unchanged or corrected title>",
         "frontmatter": { "volatility": "evolving", "tags": ["new-tag"] },   // scalar keys overwrite; lists union
         "edges": {
           "source": ["wiki/sources/<stub-slug>.md"],  // an updated page needs it too
           "related": ["<vault-relative path.md>"]
         }
       }
     ]
   }
   ```

   Every `edges` value and `raw_source: true` names target by **vault-relative path only** (`"wiki/concepts/foo.md"`, matching the kind-folders in [Vault structure](../wiki-conventions/SKILL.md)) — never a composed `[Title](../dest.md)` string. `enchiridion ingest` reads each target's title (on disk or from sibling in plan), works out `../` relativisation, percent-encodes destination; never build link string by hand. Exception: *body* links — write as ordinary markdown (`[label](destination)`), encoded or not; `enchiridion ingest` re-encodes on write.

   **Consolidation variant — `action: "consolidate"`** (CONTEXT.md, **Consolidation**; ADR-0021). Same executor, one page: `pages` holds only the **survivor** (`op: "update"`, or `op: "create"` for a fresh one), its `body` carrying each absorbed body as a section, plus a top-level `"consolidates"` list of the vault-relative refs absorbed. `raw` omitted — a Consolidation is sourced from pages, not an artifact. Executor repoints every inbound link at survivor, deletes absorbed pages, commits once; refuses a plan whose survivor body no longer contains an absorbed page's content (links compared by where they point, so a body copied across kind-folders must re-base its sibling links). Frontmatter follows ordinary update rules — list keys (`tags`, edges) union. Reached by the `--consolidate` invocation, not the procedure above — how to read the cluster, judge it, and author the survivor is [`reference/consolidation.md`](reference/consolidation.md).

   Judgment calls when filling in (folder's `INGESTION.md` may override any, except where noted):
   - **Kind** (create pages only): run `"$ENCHIRIDION" vault kinds --json` once (OpenCode: `wiki(args=["vault", "kinds", "--json"])`) to get the complete placement vocabulary — the four canonical kinds plus any custom kind-folders already present in the vault. Apply [Placement algorithm](../wiki-conventions/SKILL.md#placement-algorithm) over all returned kinds, first match wins; custom kinds are peers of canonical ones. Never emit a kind not returned by `vault kinds` — `enchiridion ingest` rejects an unknown kind. `enchiridion ingest` computes kebab-slug from `kind`+`title` — never hand-slugify. When a custom kind is chosen and its `vault kinds --json` entry has `definition: null`, note it — step 6 emits a `kind-md-proposal` block. Placement into the bare folder still completes regardless; the proposal is an enrichment nudge, not a gate.
   - **The `source/` stub is not optional** (see [The chain of evidence](../wiki-conventions/SKILL.md#the-chain-of-evidence)) — thin fine, absent not. Prior pass already filed stub: target with `op: "update"`, not second create.
   - **Typed edges** ([vocabulary](../wiki-conventions/SKILL.md#typed-edges)) — judge for **every new or updated page** against every page surfaced in step 3. Assign most specific type true (`related` only as fallback); `contradicts`/`supersedes` decided by step 3, belong on *new* page only — never on superseded page.
     - Non-judgment edge: **every page except stub carries `source` edge to stub** — each chunk of multi-chunk split, `op: "update"` same as `create`. Edges merge on update so restating safe; omit only if page already carries it from earlier pass.
   - **Body** for `update` page: write *complete* new body (not diff) when material changes; omit `body` key entirely to leave existing body untouched. For `create`, `body` always required.
   - **`raw_source: true`** derives link from plan's `raw` field. **Ingestion never renames raw file** — file from outside plugin keeps name verbatim; don't add `YYYY-MM-DD-hhmm-` prefix (bound at creation, plugin-created files only). `enchiridion ingest` mechanics: literal `#` separates anchor from path, so `#` in *filename* must be `%23`; unbalanced `)` in filename must be encoded (destination ends at first unbalanced `)`).
5. **Run it.** `"$ENCHIRIDION" ingest --plan <plan.json>` validates whole plan up front (required fields, `update` `page_ref` exists, `create` target doesn't yet, every edge/`raw_source` resolves — including siblings this plan creates — and when `raw` set, chain of evidence: stub exists and every page links back) before writing, then executes place → frontmatter → body → commit in one pass (index not touched — next search's staleness scan picks the pages up) and prints commit SHA. On error: nothing committed, written pages left on disk uncommitted (writes idempotent — fix plan and rerun, don't hand-repair).
6. **Report.** Short manifest only — pages created vs. updated, edges added, `supersedes` pairs recorded. No page-content dumps. If any page was placed into a custom kind whose `vault kinds --json` entry had `definition: null`, append one `kind-md-proposal` block per distinct missing-definition folder (invoking session uses this — see `## Invocation`):

   ````markdown
   ```kind-md-proposal
   kind: person
   summary: A named individual referenced across multiple pages
   folder: wiki/people
   ```
   ````

   `kind` is the value used in the plan; `summary` is a one-line definition (≤ ~20 words) inferred from the folder name and the content filed. `folder` is the vault-relative folder path. Invoking session writes the file on explicit user yes; ingestion already committed regardless.
