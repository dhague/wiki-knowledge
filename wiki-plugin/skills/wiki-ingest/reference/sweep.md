# Wiki Ingest — sweep procedure

Read only when the `wiki-ingest` procedure is invoked with a **folder** (under `raw/`, with or without `raw/` prefix) or **no path** (all of `raw/`). Never preloaded — the `wiki-ingest` procedure never runs sweep (see [`../SKILL.md`](../SKILL.md) Invocation section), so this doc is dead weight in its context. Lives here instead, read once by the invoking session when sweep actually happens.

**Sweep**: list every raw file in scope scanner considers eligible, ask per file, delegate each accepted file to the `wiki-ingest` procedure one at a time. Run sweep in the *invoking* session, not as a subagent — a subagent has no channel to the user (see [#18]'s finding, applied unchanged here), per-file confirmation must be answered by a human.

The script layer ships in this skill's `scripts/` directory. Resolve the runtime and the bundle once before any step that calls it — `node` where it exists, `bun` where it does not (the fallback for a host that ships only Bun) — and this skill's base directory as the host reports it when the skill loads:

```bash
RUNTIME=$(command -v node || command -v bun)
ENCHIRIDION="<this skill's base directory>/scripts/enchiridion.cjs"
```

Every call below is then `"$RUNTIME" "$ENCHIRIDION" <subcommand> <args...>`. If neither runtime is present, say so plainly and stop.

## Procedure

1. **Run the scan.** `"$RUNTIME" "$ENCHIRIDION" ingest-scan <folder-or-empty>` (or `--json` for machine-readable output) prints every file needing ingestion with reason:
   - `never-ingested` — no page's `raw_source` points at it (fresh file).
   - `changed-since-ingestion` — at least one page already points at it, but raw file strictly newer than that page's `git_date` *or* `git status --porcelain` reports it modified/untracked. Candidate's `back_pointers` carry vault-relative paths of pages already pointing at it; pass those to the `wiki-ingest` procedure as reconciliation hint so it doesn't rediscover via search.
2. **Print list, then ask.** Miscount — file missing from list, or one that shouldn't be there — easier to catch before anything written. Offer **all / none / choose**:
   - `all` — ingest every eligible file.
   - `none` — bail without writing anything.
   - `choose` — per-file ask, each eligible file gets **yes / skip / never**:
     - `yes` — ingest it (proceed to step 3).
     - `skip` — this run only; file offered again next sweep.
     - `never` — `"$RUNTIME" "$ENCHIRIDION" ingest --ignore <raw_rel>`. File never offered again unless policy edited. For file scanner offers only because ingested before [#34]'s `source/` stub-and-back-edge rule landed, add `--ignore-comment "ingested before back-pointers were mandatory"` so human reading later can tell cleanup from policy.
3. **Delegate one accepted file at a time.** For each accepted file (`yes`), hand the `wiki-ingest` procedure the file path and — for `changed-since-ingestion` — back-pointer paths as context. It runs [`../SKILL.md`](../SKILL.md)'s single-file procedure and returns a manifest. **One subagent, one `IngestPlan`, one commit per file.** Twenty-six transcripts don't fit one context; per-file commits keep history readable. For a `changed-since-ingestion` file, treat back-pointers as step-3 hint (known starting set for discovery call), not closed list.
4. **On failure, move to next file.** Failed plan leaves already-written content uncommitted, consistent with `enchiridion ingest`'s no-rollback stance; rerun safe once cause fixed. Don't abort sweep on single failure — surface in final summary, keep going.
5. **Report summary at end.** Per file: yes / no / skip / never, manifest returned (for `yes`), or one-line error (for `yes` that failed). Never page-content dump — the `wiki-ingest` procedure's step 6 already returned a manifest; this is sweep-level roll-up.

Same control files govern sweep as single ingestion: folder's `INGESTION.md` (read by each `wiki-ingest` subagent when processing file from that folder) steers *how* to ingest; folder's `.ingestignore` (applied by scan before per-file ask) steers *which* files to offer. Neither file is itself an ingestion target; parent policy never bleeds into child folder.