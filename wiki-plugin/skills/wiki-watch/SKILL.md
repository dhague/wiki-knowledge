---
name: wiki-watch
description: Watch a vault's raw/ folder and auto-ingest new or changed files as they appear, without a manual sweep. Starts a long-running foreground watcher session; Ctrl-C to stop it.
---
# Wiki Watch

User-initiated, foreground, event-driven watcher — not system daemon, not hook. The user runs it in an open session, Ctrl-Cs when done. Nothing installed as service, nothing auto-starts.

Substantive logic in the `watch` subcommand of the enchiridion script layer (`enchiridion watch` — event detection, per-file debounce, lock file, queue file) and existing sweep machinery (`enchiridion ingest-scan`, the `wiki-ingest` procedure, `enchiridion ingest`). This file is procedural glue: launch watcher, run startup sweep, poll queue, dispatch one `wiki-ingest` run per file.

The script layer ships in this skill's `scripts/` directory. Resolve the runtime and the bundle once before any step that calls it — `node` where it exists, `bun` where it does not (the fallback for a host that ships only Bun) — and this skill's base directory as the host reports it when the skill loads:

```bash
RUNTIME=$(command -v node || command -v bun)
ENCHIRIDION="<this skill's base directory>/scripts/enchiridion.cjs"
```

Every call below is then `"$RUNTIME" "$ENCHIRIDION" <subcommand> <args...>`. If neither runtime is present, say so plainly and stop.

## Procedure

1. **Resolve the vault root** — `$WIKI_ROOT` if set, else `cwd`, per the vault root resolution order. Every command below assumes cwd (or `$WIKI_ROOT`) is vault.

2. **Launch the `enchiridion watch` subcommand in the background**:
   ```
   "$RUNTIME" "$ENCHIRIDION" watch
   ```
   in the background. Accepts `--debounce <seconds>` (default 30) if user asked for different debounce window.

3. **Poll for startup**, up to ~10s deadline (checking every ~0.5s) — a slow machine can take longer than a couple seconds. Check background output each poll:
   - Printed `another watcher is already running (lock at ...)` and exited: **surface to user** and stop — do not start second watcher against same vault.
   - Printed `watching <raw/> (debounce=...s, pid=...)`: running normally, continue.
   - Deadline reached with neither line: **surface to user** and stop — watcher startup unconfirmed.

4. **Startup sweep.** Run `"$RUNTIME" "$ENCHIRIDION" ingest-scan --json` once. For each eligible file, if this session can spawn a subagent, delegate the `wiki-ingest` procedure with the file path (and, for a `changed-since-ingestion` file, its back-pointers as reconciliation hint), then wait for the manifest; otherwise run the `wiki-ingest` procedure inline. Same shape as the `wiki-ingest` sweep's per-file delegation, but **without** per-file yes/skip/never gate: every eligible file at startup gets ingested. Log each manifest (see Logging below), move to next file.

5. **Watch loop.** Poll queue file at `.wiki-knowledge/watch-queue.jsonl` every ~5s (read it — a plain newline-delimited list of vault-relative paths). For each entry:
   - Delegate the `wiki-ingest` procedure with the file path (or run it inline when this session can't spawn a subagent).
   - Wait for manifest and log it.
   - Remove entry from queue: `"$RUNTIME" "$ENCHIRIDION" watch --dequeue <file-rel-path>`.

   Queue is only wake-up signal (file path, nothing more) — the eligibility logic already ran once (in `enchiridion watch`, before entry queued), so no re-check needed before dispatching.

6. **On Ctrl-C (SIGINT):** background `enchiridion watch` receives same signal and shuts down gracefully (stops observer, removes lock, exits) — nothing to forward manually. Finish the in-flight ingestion (or exit immediately if none), then end loop.

## Failure handling

A failed delegation (model error, plan rejected, commit failure): log one-line error, loop moves to next file — never abort whole watch session over one bad file. Failed file stays in `raw/`, re-offered by next `enchiridion ingest-scan` eligibility check (still `never-ingested` or `changed-since-ingestion`) or another filesystem event.

## Logging

One line per file to session stdout — no separate log file:

- Success: `<timestamp> ingested <raw_rel> — <one-line manifest summary>`
- Failure: `<timestamp> failed <raw_rel> — <one-line error>`

No page-content dump — the `wiki-ingest` manifest is already a summary; this is watch-loop-level roll-up.