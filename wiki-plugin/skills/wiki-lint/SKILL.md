---
name: wiki-lint
description: Vault health check against the wiki-conventions contract — structural and retrievability checks, prioritised findings, mechanical auto-fixes. Invoke via /wiki-lint.
---

# Wiki Lint

Reads `wiki-conventions` for anything this procedure doesn't cover — folder structure, frontmatter schema, link format, typed-edge vocabulary.

Runs 14 checks across two dimensions: structural and retrievability. Reports findings by priority; auto-fixes the mechanical ones; asks before structural changes needing judgment.

**On Claude Code**, resolve the binary once before any step that calls it:
```bash
ENCHIRIDION=$(ls ~/.claude/plugins/cache/enchiridion-wiki-plugin/wiki-knowledge/*/bin/enchiridion | sort -V | tail -1)
```
Use `"$ENCHIRIDION"` for every call below. **On OpenCode** use `wiki(args=["<subcommand>", ...])` instead.

## Invocation

- `/wiki-lint` — lint the current vault.
- `/wiki-lint <vault-root>` — lint a specific vault root.
- **If not already running as `wiki-linter` agent** (system prompt doesn't identify you): delegate the analysis and auto-fix work. Call `Task` with `subagent_type: "wiki-linter"` and a prompt containing the vault path (if given). Wait for the report. Then:
  - Relay the **auto-fixed** and **report-only findings** sections verbatim.
  - For each **confirm-first proposal** in the returned report, present it to the user and apply the stated command on yes, skip on no. One at a time, or offer accept-all / decline-all / choose.
  - After all confirms are resolved, print the final summary.
- **If you are `wiki-linter` agent**: run the full procedure below with own tools. Apply auto-fixes. Return confirm-first proposals as a structured list with exact commands — never ask the user (subagent has no channel to user; confirm-first interaction belongs to the invoking session that called you).

## Procedure

### 1. Resolve vault root

`$WIKI_ROOT` if set, else the argument passed at invocation, else `cwd`. Verify: directory has a `wiki/` subdirectory, else stop and report "not a vault root."

### 2. Walk all pages

```bash
find <vault-root>/wiki -name "*.md" | sort
```

Collect the full list. No extra collection needed for specific check types — the check commands handle their own scoping internally.

### 3. Run mechanical checks

Run all eight with `"$ENCHIRIDION" check <name> --json`. Each returns a JSON array of `{"pageRef": "...", "detail": "..."}` objects, or `[]` when clean. Run in parallel where the vault is large:

```bash
"$ENCHIRIDION" check kind-folder-conformance --json
"$ENCHIRIDION" check ingestion-source-integrity --json
"$ENCHIRIDION" check frontmatter-link-format --json
"$ENCHIRIDION" check stale-synthesis --json
"$ENCHIRIDION" check missing-volatility-source-date --json
"$ENCHIRIDION" check unresolved-supersession --json
"$ENCHIRIDION" check contradiction-callouts --json
"$ENCHIRIDION" check orphans --json
```

**Check 1 — Kind-folder conformance:** Every `.md` under `wiki/` (excluding `KIND.md` and `_index.md`) must sit directly under a valid kind-folder — canonical four or any pre-existing custom folder. Pages at the `wiki/` root or nested below a kind-folder are violations. Fix level: **confirm first** (uses `enchiridion vault move`).

**Check 2 — Ingestion source integrity:** Every `wiki/sources/*.md` must carry a `raw_source:` frontmatter field. Fix level: **auto-fix** if body contains an unambiguous `raw/` link; otherwise **report only**.

**Check 3 — Frontmatter link format:** Links in frontmatter edge keys must be quoted YAML strings (`"[title](path)"`) with percent-encoded destinations (space, `%`, `#`, `(`, `)`, `<`, `>` encoded; unicode stays literal). Fix level: **auto-fix**.

**Check 4 — Stale synthesis:** Synthesis pages whose last git commit is > 30 days ago. Fix level: **report only**.

**Check 5 — Missing volatility / source_date:** Pages missing either `volatility` or `source_date` frontmatter field. Fix level: **report only** (values require author judgment).

**Check 6 — Unresolved supersession:** Page has `contradicts:` edge, no `supersedes:` edge, and no active `> [!warning] Contradiction` callout in the body — resolved contradiction with supersession unrecorded. Pages with both `contradicts:` and an active callout are live contradictions (check 7). Fix level: **report only**.

**Check 7 — Contradiction callouts:** Pages containing an active `> [!warning] Contradiction` callout in the body. Fix level: **report only**.

**Check 8 — Orphans:** Pages with zero inbound links from other wiki pages (body or frontmatter edges). Fix level: **report only**.

### 4. Run judgment checks

These require reading page content and applying semantic judgment. Run after the mechanical pass. Limit to pages not already flagged to avoid duplicate work.

**Check 9 — Stale claims:** For pages whose last git commit is > 90 days ago, check whether a newer source on the same topic (by title/tag overlap) has been ingested since. Use `enchiridion search` to find related pages with more recent commits:
```bash
"$ENCHIRIDION" search "<page-title-terms>" --limit 10 --json
```
Compare `git_date` of related pages. If a related page's `git_date` is substantially newer and their content covers the same ground, flag. Finding: page's claims may be superseded by newer content. Fix level: **report only**.

**Check 10 — Implicit concepts:** Identify terms appearing verbatim (or near-verbatim) across ≥ 3 pages that do not have their own `wiki/concepts/` or `wiki/entities/` page. These are candidates for extraction. Judgment call: noun phrases in body text that would make coherent stand-alone pages. Finding: term lacks its own page. Fix level: **confirm first** (creating a new page via a new ingestion plan).

**Check 11 — Missing cross-references:** For each page, check whether it names another wiki page's title in its body without linking to it. Scan body text for strings matching `title:` values from other pages. Finding: page body mentions `<title>` without linking to `<path>`. Fix level: **auto-fix** when match is unambiguous (page title matches exactly, one candidate); **confirm first** when ambiguous.

**Check 12 — Data gaps:** For pages with `volatility: volatile` or `volatility: evolving` and `source_date` > 180 days ago, identify claims whose premises could have changed. Flag as candidates for a targeted search or new ingestion. Finding: page's volatile/evolving claims likely need refresh. Fix level: **report only**.

**Check 13 — Summary quality:** For each page:
- Missing `summary` field — **report only**.
- Empty `summary` — **report only**.
- `summary` > ~25 words — **report only** (guideline is ≤ ~20 words).
- Vague `summary` (contains phrases like "this page covers", "information about", "notes on", or is a bare restatement of the title) — **report only**.

**Check 14 — Under-typed edges:** For pages where `related:` edge targets could be reclassified as `refines`, `example-of`, or `contradicts`. Read the body text for both the source and target page to judge. Apply the typed-edge vocabulary from `wiki-conventions`:
- `refines` if source page sharpens/extends target's idea.
- `example-of` if source page is a concrete instance of target.
- `contradicts` if claims conflict.
Finding: `related` edge could be `<specific-type>`. Fix level: **confirm first** (use `enchiridion page set` or `page merge` to retype).

### 5. Apply auto-fixes

For each auto-fix finding, apply without asking. Use `"$ENCHIRIDION" page set` for frontmatter changes where applicable; direct `Edit` for body-level link encoding.

**Frontmatter link quoting:** For any unquoted link in a frontmatter edge key, wrap it in double quotes:
```yaml
# Before
related:
  - "[Target](../concepts/target.md)"   # fine — already quoted
  - [Target](../concepts/target.md)     # unquoted — fix

# After
  - "[Target](../concepts/target.md)"
```

**Frontmatter link encoding:** For any link destination in frontmatter containing literal space, `%`, `#`, `(`, `)`, `<`, `>`, percent-encode those characters. Unicode stays literal.

**Raw source field migration:** For a `wiki/sources/*.md` page missing `raw_source:` frontmatter but containing a `raw/` link in its body (`[filename](../../raw/...)`) — move the link to `raw_source:` in frontmatter, remove from body if it was the only occurrence. Only auto-fix when exactly one `raw/` link exists in the body; otherwise report only.

**Body cross-reference links:** For check 11 unambiguous matches — page body mentions an existing page's exact title without a link — insert the relative markdown link inline. Verify the path resolves before writing.

After auto-fixing, note each change in the summary (file, what changed).

### 6. Confirm-first proposals

**If running as `wiki-linter` subagent:** Do not ask the user. Instead, add each confirm-first finding to the `confirm-first proposals` section of the report as a structured entry — the invoking session presents these to the user and applies the commands on yes.

Each proposal entry must include:
- The check number and finding description.
- The vault-relative path of the affected page.
- The exact command(s) to run on yes.

**If running in invoking session** (after receiving the subagent's report): for each proposal, present clearly and wait for a yes/no decision. Accept-all / decline-all / choose is fine for grouping.

Proposal shapes:

**Cross-reference insertion (check 11, ambiguous):** "Page `<page>` mentions '<title>' without linking to it, but multiple candidate pages match. Which page should be linked?"
Present candidate list and wait for selection or "skip". On selection: insert relative markdown link inline at the first unlinked mention.

**Kind-folder conformance (check 1):** "Page `<path>` is not directly under a valid kind-folder. Move it to `wiki/<correct-kind>/`? `enchiridion vault move` rewrites all inbound links."
Command on yes: `"$ENCHIRIDION" vault move <old-ref> <new-ref>`

**Implicit concept (check 10):** "Term '<term>' appears in N pages without its own concept page. Create one?"
Command on yes: invoke `/wiki-ingest` with the term and the context pages as input.

**Edge retyping (check 14):** "In `<page>`, `related:` → `<target>` looks like `<specific-type>` because `<reason>`. Retype?"
Command on yes: `"$ENCHIRIDION" page set <absolute-path> <specific-type> "<link-string>"` and remove the entry from `related:`.

### 7. Report

After auto-fixes and confirms, emit the final report. Structure:

```
## Vault lint — <date>

**Auto-fixed (<N>):**
- <file>: <what changed>

**Confirm-first proposals (<N>):**
- Check <N> — <check-name>: <finding> (<page>)
  Command: `<exact command>`

**Findings (<N>):**
<priority> — <check-name>: <brief description> (<page>)
```

Priority ordering in the report:
1. **HIGH** — contradictions, kind-folder non-conformance, missing `raw_source` on source pages, frontmatter link format issues.
2. **MEDIUM** — orphans, under-typed edges, stale synthesis, missing `volatility`/`source_date`.
3. **LOW** — summary quality, implicit concepts, missing cross-references, data gaps, stale claims, unresolved supersession.

If no findings remain after fixes, report "Vault is clean."

## Check catalogue

| # | Check | Dimension | Fix level |
|---|---|---|---|
| 1 | Kind-folder conformance | structural | confirm first |
| 2 | Ingestion source integrity | structural | auto-fix (unambiguous) / report only |
| 3 | Frontmatter link format | structural | auto-fix |
| 4 | Stale synthesis | structural | report only |
| 5 | Missing volatility / source_date | retrievability | report only |
| 6 | Unresolved supersession | retrievability | report only |
| 7 | Contradiction callouts | structural | report only |
| 8 | Orphans | structural | report only |
| 9 | Stale claims | structural | report only |
| 10 | Implicit concepts | structural | confirm first |
| 11 | Missing cross-references | structural | auto-fix (unambiguous) / confirm first |
| 12 | Data gaps | structural | report only |
| 13 | Summary quality | retrievability | report only |
| 14 | Under-typed edges | retrievability | confirm first |
