---
name: wiki-lint
description: Lint a vault against the wiki-conventions contract after ingestion or before trusting it — prioritised findings, mechanical auto-fixes, and confirm-first proposals for the changes that need judgment.
---

# Wiki Lint

Reads [`wiki-conventions` → Scripts](../wiki-conventions/SKILL.md#scripts) — the shared reference for vault-root resolution and the full subcommand catalogue — for folder structure, frontmatter schema, link format and typed-edge vocabulary this procedure doesn't cover.

The script layer ships in this skill's `scripts/` directory. Resolve it once before any step that calls it — the host reports this skill's base directory when the skill loads:

```bash
RUNTIME=$(command -v node || command -v bun)
ENCHIRIDION="<this skill's base directory>/scripts/enchiridion.cjs"
```

Every call below is `"$RUNTIME" "$ENCHIRIDION" <subcommand> <args...>`, and the script resolves the vault root itself — `$WIKI_ROOT` first, else the nearest ancestor holding a `wiki/` directory or `.wiki-root` marker, else the cwd. If neither runtime is present, say so and stop.

## Invocation

- No argument — lint the current vault.
- A vault-root argument — lint that vault root.
- **If this session can spawn a subagent**: delegate the analysis and auto-fix work — hand the `wiki-lint` procedure the vault path (if given). Wait for the report. Then:
  - Relay the **auto-fixed** and **report-only findings** sections verbatim.
  - Present each **confirm-first proposal** to the user in turn and apply the stated command on yes, skip on no; accept-all / decline-all / choose may group them — **except a Consolidation proposal (`concept-fragmentation`), always one cluster per handoff**, because each deletes committed pages.
  - After all confirms are resolved, print the final summary.
- **If already running the procedure as a subagent**: run the full procedure below with own tools. Apply auto-fixes. Return confirm-first proposals as a structured list with exact commands — a subagent has no channel to the user, so confirm-first interaction belongs to the session that invoked you.

## Procedure

### 1. Resolve vault root

`$WIKI_ROOT` if set, else the argument passed at invocation, else `cwd`. Verify: directory has a `wiki/` subdirectory, else stop and report "not a vault root."

### 2. Run mechanical checks

Run every check below, in parallel where the vault is large. Each emits JSON Lines — one `{"pageRef": "...", "detail": "..."}` object per finding, and nothing at all when clean (no `[]` to unwrap). The `concept-fragmentation` check adds a structured `cluster` key (members, basis, similarity, suggested survivor) to each row:

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

- **Kind-folder conformance** (`kind-folder-conformance`) — every `.md` under `wiki/` (bar `KIND.md` and `_index.md`) sits directly under a valid kind-folder — canonical four or a custom folder the vault already carries. Pages at the `wiki/` root or nested below a kind-folder are violations. Fix level: **confirm first** (the repair is `enchiridion vault move`).
- **Ingestion source integrity** (`ingestion-source-integrity`) — every `wiki/sources/*.md` carries `raw_source:`. Fix level: **auto-fix** when the body holds one unambiguous `raw/` link, else **report only**.
- **Frontmatter link format** (`frontmatter-link-format`) — every frontmatter edge value is a quoted markdown link with an encoded destination. Fix level: **auto-fix** the quoting and encoding; **report only** a value that is no markdown link at all, which a fix cannot repair — re-set the edge with `page set`, or `page merge` with a JSON list.
- **Stale synthesis** (`stale-synthesis`) — synthesis pages whose last commit is > 30 days old. Fix level: **report only**.
- **Missing volatility / source_date** (`missing-volatility-source-date`) — pages missing either field. Fix level: **report only** (the values need author judgment).
- **Unresolved supersession** (`unresolved-supersession`) — a `contradicts:` edge with no `supersedes:` edge and no active `> [!warning] Contradiction` callout; the callout present makes it a live contradiction, which the next check reports instead. Fix level: **report only**.
- **Contradiction callouts** (`contradiction-callouts`) — pages carrying an active `> [!warning] Contradiction` callout. Fix level: **report only**.
- **Orphans** (`orphans`) — pages with no inbound link, body or frontmatter. Fix level: **confirm first** (delete only after the user confirms).
- **Split links** (`split-links`) — no link split across lines, in frontmatter or body. Fix level: **auto-fix** the folded frontmatter shapes (a destination joins with nothing, a label with one space); **report only** body splits — a break after a destination is legal markdown, so joining on sight can silently repoint the link. Scoped to double-quoted frontmatter scalars: raw text cannot tell a block scalar (`related: |`) from a fold, so nothing outside that shape is reported or joined.
- **Concept fragmentation** (`concept-fragmentation`) — clusters of small, closely-related `concept` pages, and custom-kind pages behaving like concepts, whose knowledge reads better as one page with sections (CONTEXT.md, **Concept fragmentation**). One finding per cluster, whose `cluster` payload carries the members with committed byte size and inbound-link count, the shared basis (tags / title words), the weakest pairwise similarity holding the cluster together, and a suggested survivor (most inbound links, largest body as tie-break). The `pageRef` is that survivor and the `detail` a one-line summary. `--min-similarity <n>` (default `0.5`) is the one cutoff; `entity`, `source` and `synthesis` pages are never in scope. Reads the index, so it sees only committed pages — an uncommitted draft is invisible until committed. Fix level: **confirm first** — a Consolidation, always one cluster per handoff.

Per-check semantics and the rationale behind each fix: [`reference/checks.md`](reference/checks.md) — read before explaining a finding you cannot classify.

### 3. Run judgment checks

Run after the mechanical pass. Get the full page list first, then limit to pages not already flagged:

```bash
find <vault-root>/wiki -name "*.md" | sort
```

**Stale claims:** for pages whose last commit is > 90 days old, look for a source on the same topic, by title/tag overlap, ingested since.

```bash
"$RUNTIME" "$ENCHIRIDION" search "<page-title-terms>" --limit 10 --json
```

Compare `git_date`; where a related page is substantially newer and covers the same ground, flag the claims as possibly superseded. Fix level: **report only**.

**Implicit concepts:** terms appearing across ≥ 3 pages that have no page of their own — candidates for extraction. Fix level: **confirm first** (a new ingestion plan).

**Missing cross-references:** a page naming another page's title in its body without linking to it. Fix level: **auto-fix** when exactly one page bears the matching title; **confirm first** when ambiguous.

**Data gaps:** pages with `volatility: volatile` or `evolving` and a `source_date` > 180 days old, whose premises could have changed. Fix level: **report only**.

**Summary quality:** for each page — missing, empty, > ~25 words (guideline: ≤ ~20), or vague ("this page covers", "information about", "notes on", a bare restatement of the title). Fix level: **report only**.

**Under-typed edges:** `related:` targets whose bodies support a sharper type — `refines`, `example-of` or `contradicts`, per the typed-edge vocabulary in `wiki-conventions`. Fix level: **confirm first** (retype with `page set` or `page merge`).

**The three-way boundary — fragmentation / cross-reference / implicit concept.** One question (*is this one concept or two?*) and one dial (`--min-similarity`) split three checks, so they partition rather than double-report. Read this before raising any of them:

- **Concept fragmentation** (`concept-fragmentation`): the pages are the same concept → **Consolidation**: absorb into one survivor, delete the losers. Several pages in, one page out.
- **Missing cross-references**: distinct concepts, one names the other, no link → **typed edge**. Two pages in, two pages out, now joined.
- **Implicit concepts**: one concept with no page at all — its *term* recurs across ≥ 3 pages → **extract** a page. No page in, one page out.

Direction is the tell: fragmentation collapses pages that exist, implicit concepts creates the missing one, cross-references joins two that already exist. A pair below the fragmentation bar is never a Consolidation — it is an edge, and Missing cross-references owns proposing it. Never downgrade a declined cluster to an edge.

### 4. Apply auto-fixes

For each auto-fix finding, apply without asking:

```bash
"$RUNTIME" "$ENCHIRIDION" fix frontmatter-link-format
"$RUNTIME" "$ENCHIRIDION" fix ingestion-source-integrity
"$RUNTIME" "$ENCHIRIDION" fix missing-cross-references
"$RUNTIME" "$ENCHIRIDION" fix split-links
```

Each prints the vault-relative refs it modified, one per line, or nothing if no change was needed. Ambiguous cases are skipped by the fix — surface them as report-only findings. Note each changed ref in the summary (file, what changed).

### 5. Confirm-first proposals

Add every confirm-first finding to the report's **confirm-first proposals** section. Each entry must include:
- The check name and finding description.
- The vault-relative path(s) of the affected page(s) — every member, for a cluster.
- The exact command(s) to run on yes.

Proposal shapes — present the entry, wait for a yes/no, apply the stated command on yes:

[`reference/proposals.md`](reference/proposals.md) — the exact wording and command for each confirm-first shape; read before writing a proposal.

Never author the merged body here: the merge is a judgment call that belongs to the ingest flow. Never batch two clusters into one handoff.

### 6. Report

After auto-fixes and confirms, emit the final report:

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

| Check | Fix level |
|---|---|
| `kind-folder-conformance` | confirm first |
| `ingestion-source-integrity` | auto-fix (unambiguous) / report only |
| `frontmatter-link-format` | auto-fix |
| `stale-synthesis` | report only |
| `missing-volatility-source-date` | report only |
| `unresolved-supersession` | report only |
| `contradiction-callouts` | report only |
| `orphans` | confirm first |
| `split-links` | auto-fix (frontmatter) / report only (body) |
| `concept-fragmentation` | confirm first |
| Stale claims | report only |
| Implicit concepts | confirm first |
| Missing cross-references | auto-fix (unambiguous) / confirm first |
| Data gaps | report only |
| Summary quality | report only |
| Under-typed edges | confirm first |

Every `fix <slug>` the run above calls, and why each skips an ambiguous page: [`reference/checks.md`](reference/checks.md).
