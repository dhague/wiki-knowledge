---
name: wiki-lint
description: Vault health check against the wiki-conventions contract — structural and retrievability checks, prioritised findings, mechanical auto-fixes.
---

# Wiki Lint

Reads `wiki-conventions` for anything this procedure doesn't cover — folder structure, frontmatter schema, link format, typed-edge vocabulary.

Runs 16 checks across two dimensions: structural and retrievability. Reports findings by priority; auto-fixes the mechanical ones; asks before structural changes needing judgment.

The script layer ships in this skill's `scripts/` directory. Resolve the runtime and the bundle once before any step that calls it — `node` where it exists, `bun` where it does not (the fallback for a host that ships only Bun) — and this skill's base directory as the host reports it when the skill loads:

```bash
RUNTIME=$(command -v node || command -v bun)
ENCHIRIDION="<this skill's base directory>/scripts/enchiridion.cjs"
```

Every call below is then `"$RUNTIME" "$ENCHIRIDION" <subcommand> <args...>`. If neither runtime is present, say so plainly and stop.

## Invocation

- No argument — lint the current vault.
- A vault-root argument — lint that vault root.
- **If this session can spawn a subagent**: delegate the analysis and auto-fix work — hand the `wiki-lint` procedure the vault path (if given). Wait for the report. Then:
  - Relay the **auto-fixed** and **report-only findings** sections verbatim.
  - For each **confirm-first proposal** in the returned report, present it to the user and apply the stated command on yes, skip on no. One at a time, or offer accept-all / decline-all / choose — **except a Consolidation proposal (`concept-fragmentation`)**: always one cluster at a time, never batched, never an accept-all, because each deletes committed pages.
  - After all confirms are resolved, print the final summary.
- **If already running the procedure as a subagent**: run the full procedure below with own tools. Apply auto-fixes. Return confirm-first proposals as a structured list with exact commands — never ask the user (a subagent has no channel to the user; confirm-first interaction belongs to the invoking session that called you).

## Procedure

### 1. Resolve vault root

`$WIKI_ROOT` if set, else the argument passed at invocation, else `cwd`. Verify: directory has a `wiki/` subdirectory, else stop and report "not a vault root."

### 2. Run mechanical checks

Run every mechanical check with `"$RUNTIME" "$ENCHIRIDION" check <name> --json`. Each emits JSON Lines — one `{"pageRef": "...", "detail": "..."}` object per finding, one per line, and nothing at all when clean (no `[]` to unwrap). The `concept-fragmentation` check adds a structured `cluster` key to each row (members, basis, similarity, suggested survivor). Run in parallel where the vault is large:

```bash
"$RUNTIME" "$ENCHIRIDION" check kind-folder-conformance --json
"$RUNTIME" "$ENCHIRIDION" check ingestion-source-integrity --json
"$RUNTIME" "$ENCHIRIDION" check frontmatter-link-format --json
"$RUNTIME" "$ENCHIRIDION" check stale-synthesis --json
"$RUNTIME" "$ENCHIRIDION" check missing-volatility-source-date --json
"$RUNTIME" "$ENCHIRIDION" check unresolved-supersession --json
"$RUNTIME" "$ENCHIRIDION" check contradiction-callouts --json
"$RUNTIME" "$ENCHIRIDION" check orphans --json
"$RUNTIME" "$ENCHIRIDION" check split-links --json
"$RUNTIME" "$ENCHIRIDION" check concept-fragmentation --json
```

**Kind-folder conformance (`kind-folder-conformance`):** Every `.md` under `wiki/` (excluding `KIND.md` and `_index.md`) must sit directly under a valid kind-folder — canonical four or any pre-existing custom folder. Pages at the `wiki/` root or nested below a kind-folder are violations. Fix level: **confirm first** (uses `enchiridion vault move`).

**Ingestion source integrity (`ingestion-source-integrity`):** Every `wiki/sources/*.md` must carry a `raw_source:` frontmatter field. Fix level: **auto-fix** if body contains an unambiguous `raw/` link; otherwise **report only**.

**Frontmatter link format (`frontmatter-link-format`):** Links in frontmatter edge keys must be quoted YAML strings (`"[title](path)"`) with percent-encoded destinations (space, `%`, `(`, `)`, `<`, `>` encoded; unicode stays literal). `#` is the anchor separator and stays literal — frontmatter links carry the same link form as body links, anchors included; only a `#` inside a *filename* is `%23`. An edge value that is no markdown link at all — a bare path like `wiki/concepts/foo.md`, a non-string entry — is reported here too: the record parser refuses it, so the other checks read on past it rather than aborting blank. Fix level: **auto-fix** the quoting and encoding; **report only** the no-link shape, where a fix cannot invent a label — repair it by re-setting the edge with `page set` (or `page merge` with a JSON list), which composes a vault-relative ref into a link.

**Stale synthesis (`stale-synthesis`):** Synthesis pages whose last git commit is > 30 days ago. Fix level: **report only**.

**Missing volatility / source_date (`missing-volatility-source-date`):** Pages missing either `volatility` or `source_date` frontmatter field. Fix level: **report only** (values require author judgment).

**Unresolved supersession (`unresolved-supersession`):** Page has `contradicts:` edge, no `supersedes:` edge, and no active `> [!warning] Contradiction` callout in the body — resolved contradiction with supersession unrecorded. Pages with both `contradicts:` and an active callout are live contradictions, which `contradiction-callouts` reports. Fix level: **report only**.

**Contradiction callouts (`contradiction-callouts`):** Pages containing an active `> [!warning] Contradiction` callout in the body. Fix level: **report only**.

**Orphans (`orphans`):** Pages with zero inbound links from other wiki pages (body or frontmatter edges). Fix level: **confirm first** (delete via git rm after user confirms).

**Split links (`split-links`):** No link split across lines, frontmatter or body. Three shapes: destination folded mid-slug with a trailing `\` inside a quoted frontmatter link scalar; label folded at a space inside one (legal YAML both — they join back to the same value); body destination broken across a line break — not a link at all under CommonMark, so `vault move` never rewrites it. Scoped to double-quoted frontmatter scalars: raw text cannot tell a block scalar (`related: |`) from a fold, so nothing outside that shape is reported or joined. Fix level: **auto-fix** the two frontmatter shapes (destination joins with nothing, label with one space); **report only** body splits — a break after a destination is legal markdown (`[T](path.md` / `"title")`), so joining on sight can silently repoint the link.

**Concept fragmentation (`concept-fragmentation`):** Clusters of small, closely-related `concept` pages — and custom-kind pages that behave like concepts — whose knowledge is better read as one page with sections (CONTEXT.md, **Concept fragmentation**). One finding per cluster, whose `cluster` payload carries the members with committed byte size and inbound-link count, the shared basis (tags / title words), the weakest pairwise similarity holding the cluster together, and a suggested survivor (most inbound links, largest body as tie-break). The suggestion is a hint, not a verdict. `--min-similarity <n>` (CLI-tunable, default `0.5`) is the one cutoff: at or above it a pair is one concept, below it the pair belongs to Missing cross-references. `entity`, `source` and `synthesis` pages are never in scope — their one-per-thing or one-per-artifact identity forbids consolidation. Reads the index, so it sees only committed pages: an uncommitted draft is invisible until committed. Fix level: **confirm first** — a Consolidation, proposed one cluster at a time and never auto-applied. The finding's `pageRef` is the suggested survivor and its `detail` a one-line summary of the cluster; the structured `cluster` is what step 5 presents.

### 3. Run judgment checks

These require reading page content and applying semantic judgment. Run after the mechanical pass. Get the full page list first, then limit to pages not already flagged to avoid duplicate work:

```bash
find <vault-root>/wiki -name "*.md" | sort
```

**Stale claims:** For pages whose last git commit is > 90 days ago, check whether a newer source on the same topic (by title/tag overlap) has been ingested since. Use `enchiridion search` to find related pages with more recent commits:
```bash
"$RUNTIME" "$ENCHIRIDION" search "<page-title-terms>" --limit 10 --json
```
Compare `git_date` of related pages. If a related page's `git_date` is substantially newer and their content covers the same ground, flag. Finding: page's claims may be superseded by newer content. Fix level: **report only**.

**Implicit concepts:** Identify terms appearing verbatim (or near-verbatim) across ≥ 3 pages that do not have their own `wiki/concepts/` or `wiki/entities/` page. These are candidates for extraction. Judgment call: noun phrases in body text that would make coherent stand-alone pages. Finding: term lacks its own page. Fix level: **confirm first** (creating a new page via a new ingestion plan).

**Missing cross-references:** For each page, check whether it names another wiki page's title in its body without linking to it. Scan body text for strings matching `title:` values from other pages. Finding: page body mentions `<title>` without linking to `<path>`. This check owns the pair that is merely *related*; a pair close enough to be one concept is `concept-fragmentation`'s — `--min-similarity` is the line between them. Fix level: **auto-fix** when match is unambiguous (page title matches exactly, one candidate); **confirm first** when ambiguous.

**Data gaps:** For pages with `volatility: volatile` or `volatility: evolving` and `source_date` > 180 days ago, identify claims whose premises could have changed. Flag as candidates for a targeted search or new ingestion. Finding: page's volatile/evolving claims likely need refresh. Fix level: **report only**.

**Summary quality:** For each page:
- Missing `summary` field — **report only**.
- Empty `summary` — **report only**.
- `summary` > ~25 words — **report only** (guideline is ≤ ~20 words).
- Vague `summary` (contains phrases like "this page covers", "information about", "notes on", or is a bare restatement of the title) — **report only**.

**Under-typed edges:** For pages where `related:` edge targets could be reclassified as `refines`, `example-of`, or `contradicts`. Read the body text for both the source and target page to judge. Apply the typed-edge vocabulary from `wiki-conventions`:
- `refines` if source page sharpens/extends target's idea.
- `example-of` if source page is a concrete instance of target.
- `contradicts` if claims conflict.
Finding: `related` edge could be `<specific-type>`. Fix level: **confirm first** (use `enchiridion page set` or `page merge` to retype).

**The three-way boundary — fragmentation / cross-reference / implicit concept.** One question (*is this one concept or two?*) and one dial (`--min-similarity`) split three checks, so they partition rather than double-report. Read this before raising any of them:

- **Concept fragmentation (`concept-fragmentation`):** the pages are the same concept → **Consolidation** — absorb into one survivor, delete the losers. Several pages in, one page out.
- **Missing cross-references:** distinct concepts, one names the other, no link → **typed edge**. Two pages in, two pages out, now joined.
- **Implicit concepts:** one concept with no page at all — its *term* recurs across ≥ 3 pages → **extract** a page. No page in, one page out.

Direction is the tell: Concept fragmentation collapses pages that exist, Implicit concepts creates the missing one, Missing cross-references joins two that already exist. A pair below the fragmentation bar is never a Consolidation — it is an edge, and Missing cross-references' to propose.

### 4. Apply auto-fixes

For each auto-fix finding, apply without asking:

```bash
"$RUNTIME" "$ENCHIRIDION" fix frontmatter-link-format
"$RUNTIME" "$ENCHIRIDION" fix ingestion-source-integrity
"$RUNTIME" "$ENCHIRIDION" fix missing-cross-references
"$RUNTIME" "$ENCHIRIDION" fix split-links
```

Each command prints the vault-relative refs of files it modified (one per line), or nothing if no changes were needed. `fix ingestion-source-integrity` only rewrites a source page when exactly one `raw/` link exists in the body; ambiguous pages are left for report-only. `fix missing-cross-references` only inserts a link when exactly one page bears the matching title; ambiguous or already-linked mentions are skipped. `fix split-links` joins folded frontmatter destinations and labels in place; body splits are never touched — those stay report-only, so surface them as findings and leave the join to the user.

After running, note each changed ref in the summary (file, what changed).

### 5. Confirm-first proposals

**If running as a subagent:** Do not ask the user. Instead, add each confirm-first finding to the `confirm-first proposals` section of the report as a structured entry — the invoking session presents these to the user and applies the commands on yes.

Each proposal entry must include:
- The check name and finding description.
- The vault-relative path(s) of the affected page(s) — every member, for a cluster.
- The exact command(s) to run on yes.

**If running in invoking session** (after receiving the subagent's report): for each proposal, present clearly and wait for a yes/no decision. Accept-all / decline-all / choose is fine for grouping — **except Consolidation proposals (`concept-fragmentation`)**, which are always one cluster at a time, never batched.

Proposal shapes:

**Consolidation (`concept-fragmentation`):** "Pages `<a>`, `<b>`[, `<c>`] read as one concept (basis: `<shared tags / shared title terms>`, weakest pairwise similarity `<s>`). Consolidate into `<suggested-survivor>`?" Name every member with its committed size and inbound-link count, so the user can judge the suggested survivor — and offer to override it, which is a judgment the ingest flow also gets to make.
Command on yes: hand off to the `wiki-ingest` procedure with the survivor and the absorbed refs (a Consolidation) — that flow reads each member's body, authors the merged survivor, and lands the one atomic commit. **Never author the merged body here**: the merge is a judgment call that belongs to the ingest flow. Never batch two clusters into one handoff.
On no: skip the cluster. Do not downgrade it to an edge — the pair was above the fragmentation bar, so Missing cross-references does not own it.

**Cross-reference insertion (ambiguous):** "Page `<page>` mentions '<title>' without linking to it, but multiple candidate pages match. Which page should be linked?"
Present candidate list and wait for selection or "skip". On selection: insert relative markdown link inline at the first unlinked mention.

**Kind-folder conformance (`kind-folder-conformance`):** "Page `<path>` is not directly under a valid kind-folder. Move it to `wiki/<correct-kind>/`? `enchiridion vault move` rewrites all inbound links."
Command on yes: `"$RUNTIME" "$ENCHIRIDION" vault move <old-ref> <new-ref>`

**Implicit concept:** "Term '<term>' appears in N pages without its own concept page. Create one?"
Command on yes: invoke the `wiki-ingest` procedure with the term and the context pages as input.

**Edge retyping:** "In `<page>`, `related:` → `<target>` looks like `<specific-type>` because `<reason>`. Retype?"
Command on yes: `"$RUNTIME" "$ENCHIRIDION" page merge <absolute-path> <specific-type> '["<vault-relative-ref>"]'`, then rewrite `related:` without that target via `page set <absolute-path> related --json '<remaining-links>'`. An edge value is a markdown link or a vault-relative ref (`wiki/concepts/foo.md`) — the command composes the link. `page set` **replaces** a list-valued key; `page merge` **unions** into it.

**Delete orphan page:** "Page `<path>` has no inbound links and no apparent purpose. Delete it?"
Command on yes: `git -C <vault-root> rm <vault-relative-path> && git -C <vault-root> commit -m "chore: remove orphan page <path>"`

### 6. Report

After auto-fixes and confirms, emit the final report. Structure:

```
## Vault lint — <date>

**Auto-fixed (<N>):**
- <file>: <what changed>

**Confirm-first proposals (<N>):**
- <check-name>: <finding> (<page>)
  Command: `<exact command>`

**Findings (<N>):**
<priority> — <check-name>: <brief description> (<page>)
```

Priority ordering in the report:
1. **HIGH** — contradictions, kind-folder non-conformance, missing `raw_source` on source pages, frontmatter link format issues, split links.
2. **MEDIUM** — orphans, concept fragmentation, under-typed edges, stale synthesis, missing `volatility`/`source_date`.
3. **LOW** — summary quality, implicit concepts, missing cross-references, data gaps, stale claims, unresolved supersession.

If no findings remain after fixes, report "Vault is clean."

## Check catalogue

Mechanical checks are named by their `enchiridion check <name>` slug; the judgment checks that follow have no script spelling.

| Check | Dimension | Fix level |
|---|---|---|
| `kind-folder-conformance` | structural | confirm first |
| `ingestion-source-integrity` | structural | auto-fix (unambiguous) / report only |
| `frontmatter-link-format` | structural | auto-fix |
| `stale-synthesis` | structural | report only |
| `missing-volatility-source-date` | retrievability | report only |
| `unresolved-supersession` | retrievability | report only |
| `contradiction-callouts` | structural | report only |
| `orphans` | structural | confirm first |
| `split-links` | structural | auto-fix (frontmatter) / report only (body) |
| `concept-fragmentation` | structural | confirm first |
| Stale claims | structural | report only |
| Implicit concepts | structural | confirm first |
| Missing cross-references | structural | auto-fix (unambiguous) / confirm first |
| Data gaps | structural | report only |
| Summary quality | retrievability | report only |
| Under-typed edges | retrievability | confirm first |
