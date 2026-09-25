---
name: wiki-ask
description: Answer questions from the wiki vault — search, follow typed edges, cite with age and volatility. Use to run retrieval for a question, directly or through a subagent.
---
# Wiki Ask

Reads [`wiki-conventions`](../wiki-conventions/SKILL.md) for the vault's format contract.

Retrieval **never modifies an existing page** — no edit, no move, no delete, ever. One write: new `synthesis/` page, only on explicit user confirmation ([saving-synthesis.md](saving-synthesis.md)).

The script layer ships in this skill's `scripts/` directory. Resolve it once before any step that calls it — the host reports this skill's base directory when the skill loads:

```bash
RUNTIME=$(command -v node || command -v bun)
ENCHIRIDION="<this skill's base directory>/scripts/enchiridion.cjs"
```

Every call below is `"$RUNTIME" "$ENCHIRIDION" <subcommand> <args...>`, and the script resolves the vault root itself — `$WIKI_ROOT` first, else the nearest ancestor holding a `wiki/` directory or `.wiki-root` marker, else the cwd. If neither runtime is present, say so and stop.

## Invocation

- **If this session can spawn a subagent** (and is not already running the retrieval procedure as one): the only action is to spawn one to run the procedure below on the question, then relay its answer — that keeps reading and link-following inside the subagent's context regardless of the invoking session's model.
- **If already running the retrieval procedure as a subagent**: continue with the procedure below using your own tools.

Scripts resolve the vault root themselves: [`wiki-conventions` → Scripts](../wiki-conventions/SKILL.md#scripts) — the shared reference for vault-root resolution and the full subcommand catalogue.

Search `wiki/**` only — `raw/` is not indexed; its `source/` stub has the summary.

## Procedure

Given a question:

1. **Expand the query.** Before searching, write **5–8 alternative phrasings** of the key terms: synonyms, jargon form, plain-English form, singular/plural, acronym and expansion, verb and noun forms. Expansions become the term list passed to `enchiridion search` below.

2. **Single search call.** One call to `enchiridion search` does the work — composes BM25 text matching with metadata filters, ranks results, defaults to excluding superseded pages. Pass the whole term list from step 1 as **one quoted argument** — `search "<term1> <term2> <term3>"` — it tokenizes and phrase-quotes each term. Use `--json` and read the records.

   The flag judgement `--help` does not carry: `--tag`/`--tag-any` only for a clearly tag-shaped question ("all pages tagged `db`"); `--date-field source_date` for when the knowledge is *from*, `git_date` for when it was written; `--include-superseded` only when discussing history; `--raw` only for a named FTS5 operator (`NEAR`, `OR`, prefix `*`).

3. **Expand frontier, frontmatter-first.** Hits are candidates, not answers. Judge each by its **`summary`**; discard the ones that don't bear on the question, and only a candidate that survives summary judgment earns a full read of its body. Most of the frontier dies at summary — a body read is expensive and never the first move. Where more than one candidate survives a hop's summary judgment, issue their body reads together in one message, not serially; each extra turn re-reads full context.

   From each page read, harvest outbound relationships — typed-edge keys and `supersedes` in frontmatter, plus body links to other `wiki/` pages — as **next-hop candidates**.

   **Follow the typed edge the question implies** — an unambiguous shape maps to one edge and one direction, anything else to all typed edges both ways **except `source`**. Rules and the provenance chain: [Edge-following rules](#edge-following-rules).

4. **Filter frontier for currency.** A superseded page is never the answer — `supersedes` is a *recorded fact* (see [Frontmatter schema](../wiki-conventions/SKILL.md#frontmatter-schema)) and beats any recency guess. Run `"$RUNTIME" "$ENCHIRIDION" superseded-by` with every candidate's `page_ref` as positional arg (`--json` for machine-readable line per candidate); walks each one's `supersedes` inversions in-process and returns each candidate's *active* page:

   ```
   "$RUNTIME" "$ENCHIRIDION" superseded-by wiki/concepts/a.md wiki/concepts/x.md --json
   ```

   Each result: `{"seed": ..., "active": ..., "chain": [...]}`. Apply directly:

   - **`active == seed`** — candidate is current; keep it.
   - **`active != seed`** — **drop seed from active set and keep `active` instead**, adding to candidate set if not already there. Seed is history, not the answer, whether replacement was one hop or multi-page chain — script already walked to head.

5. **Stop at budget.** Retrieval is bounded:
   - **max 2 hops** from seed set,
   - **~12 pages read** in full,
   - **stop early when a hop adds no new fact.** Recency is never a stop signal — an older page is not skipped for being old, and a newer one does not end the search.

   If budget hit with question unanswered, say so (what was searched, what to read next) — never silently truncate or blow through it.

6. **Synthesize, with honest temporal framing.** Answer from what was actually read; **cite every claim** with its source page (relative link or vault path — the reader must be able to open it).

   **Normal** questions cite the page itself — it stands in for the raw material beneath it — and leave the `source` stub unread. **Provenance** questions ([Edge-following rules](#edge-following-rules)) follow the chain to the raw artifact (page → `source` → stub → `raw_source` → raw file) and cite that with a location (line or page number), the concept page as lens: *"per [Concept](...), drawing on [raw-file.md](...) line 42…"*; a page with no `source` edge has no chain, so cite it normally and say so.

   For each cited page state its age (`source_date` or `git_date`) and its `volatility` ([field semantics](../wiki-conventions/SKILL.md#frontmatter-schema)) in the answer, so the asker can calibrate trust — e.g. *"per [Rate limits](wiki/concepts/rate-limits.md), marked `volatile`, from 2025-01-12 and last committed 14 months ago…"*. A `volatile` fact never carries the confidence of a `stable` one. Sanity-check `git_date` before quoting: a bulk-imported vault gives every page the same commit date, which says nothing about the knowledge — frame on `source_date` and say so.

   **Recency is never a re-ranking signal.** Exception: an explicitly time-anchored question ("what's the latest X", "as of YYYY-MM-DD"), where recency is the signal; even then the `supersedes` edge wins.

   **A superseded page is history, not the current answer** — step 4 already filtered them, so this keeps the *answer* consistent. Frame on the *current* page ("per [Current]…") and name the older one only as what it replaced; a question about the chain itself spells it out: *"per [A] (now superseded by [C] via [B])…"*. Where pages genuinely conflict without one superseding the other, show both — resolving a live contradiction is the asker's call.

7. **Report.** Reply with the answer and its citations, plus one short line on what was searched (expansions used, pages read, hops taken) so the asker can see whether the search missed their framing. The answer is prose; the page bodies stay in the reading context.

8. **Offer to save when the answer is worth keeping.** Append a `save-candidate` block only when **both** bars hold:

   - **Durable** — not a one-off lookup expiring with session, and not a single page's content restated (if one page answered the question, cite it; synthesis duplicating it is vault noise).
   - **Reusable** — drew several pages into something next asker would otherwise re-derive, and still true next month.

   The block is **a proposal, not a write** — the session holding the conversation puts the offer and performs the save on explicit yes ([saving-synthesis.md](saving-synthesis.md)); a subagent cannot ask, which is why it proposes.

   ````markdown
   ```save-candidate
   title: How connection pooling is configured
   summary: Pool size is set per-service in the deploy config, not globally
   tags: [db, deployment]
   source_date: 2026-07-28
   volatility: evolving
   source:
     - wiki/concepts/db-connection-pooling.md
     - wiki/sources/deploy-github-actions.md
   ```
   ````

   Field notes: `summary` is one line, ≤ ~20 words — what *next* retrieval judges this page by, write it as well as you'd want to find it. `source_date` is **today** — synthesis made today even if inputs are older. `volatility` is **most volatile** of cited pages: synthesis only as durable as shakiest input. `source:` lists every page actually cited, as vault-relative paths (`enchiridion ingest` composes actual links when plan runs) — nothing merely skimmed.

## Edge-following rules

An unambiguous question shape maps to one edge and one direction; anything else follows **all typed edges in both directions, `source` excepted**. Direction is the trap — "what does X refine" asks for X's outbound `refines:` list, "what refines X" asks which pages name X under their own `refines:`; inverting is a silent miss.

**Provenance questions** — "provenance of X", "evidence for X", "raw data behind X", "cite the original" — follow `source` outbound: X's `source:` list → stub page → its `raw_source:` → raw artifact, cited with a location (line or page number).

The rest of the question-to-edge table: [`reference/edge-following.md`](reference/edge-following.md) — read when the question's shape is not one you have already mapped.
