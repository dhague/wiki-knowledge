---
name: wiki-watch
description: Watch a vault's raw/ folder and auto-ingest new or changed files as they appear. Foreground watcher, runs for the session; Ctrl-C stops it.
---
# Wiki Watch

A foreground watcher the user runs inside an open session, for the life of that session — Ctrl-C when done.

Substantive logic lives in `enchiridion watch`; sweep machinery in `enchiridion ingest-scan` plus the `wiki-ingest` procedure. This file is glue: launch, sweep, poll, dispatch.

The script layer ships in this skill's `scripts/` directory. Resolve it once before any step that calls it — the host reports this skill's base directory when the skill loads:

```bash
RUNTIME=$(command -v node || command -v bun)
ENCHIRIDION="<this skill's base directory>/scripts/enchiridion.cjs"
```

`ENCHIRIDION` MUST be an absolute local filesystem path. A harness-internal `skill://` URI is not one — the runtime is an external process and resolves it as a relative file path, so the call fails before the script runs. If the host reports the base directory as such a URI rather than a real path, convert it first (`baseDir=$(realpath '<base-dir>')`).

Every call below is `"$RUNTIME" "$ENCHIRIDION" <subcommand> <args...>`. If neither runtime is present, say so and stop.

[`wiki-conventions` → Scripts](../wiki-conventions/reference/scripts.md#script-runtime-contract) — the shared reference for vault-root resolution and the full subcommand catalogue

## Procedure

1. **Set the vault root** — `WIKI_ROOT` when the session's working directory is not the vault. Every subcommand resolves the root itself ([the rule](../wiki-conventions/reference/scripts.md#script-runtime-contract)).

2. **Launch the `enchiridion watch` subcommand in the background**:
   ```
   "$RUNTIME" "$ENCHIRIDION" watch
   ```
   Accepts `--debounce <seconds>` on request.

3. **Poll for startup** up to a ~10s deadline (every ~0.5s), reading background output each poll:
   - `another watcher is already running (lock at ...)` and exited, or no line by the deadline: **surface to user** and stop — the watcher is not confirmed running.
   - `watching ...`: running normally, continue.

4. **Startup sweep.** Run `"$RUNTIME" "$ENCHIRIDION" ingest-scan --json` once. For each eligible file, delegate the `wiki-ingest` procedure with the file path (and, for a `changed-since-ingestion` file, its back-pointers as reconciliation hint), then wait for the manifest. Same shape as the `wiki-ingest` sweep's per-file delegation, but **without** per-file yes/skip/never gate: every eligible file at startup gets ingested. Log each manifest (see Logging below), move to next file.

5. **Watch loop.** Poll the queue file at `.wiki-knowledge/watch-queue.jsonl` — a plain newline-delimited list of vault-relative paths. For each entry:
   - Delegate the `wiki-ingest` procedure with the file path — or run it inline when this session cannot spawn a subagent.
   - Wait for manifest and log it.
   - Remove entry from queue: `"$RUNTIME" "$ENCHIRIDION" watch --dequeue <file-rel-path>`.

   Queue is only a wake-up signal (file path, nothing more) — the eligibility logic already ran in `enchiridion watch` before the entry queued, so no re-check needed before dispatching.

6. **On Ctrl-C:** background `enchiridion watch` receives the same signal and shuts down gracefully (stops observer, removes lock, exits) — nothing to forward manually. Finish the in-flight ingestion (or exit immediately if none), then end loop.

## Failure handling

A failed delegation (model error, plan rejected, commit failure): log one-line error, loop moves to next file — never abort whole watch session over one bad file. Failed file stays in `raw/`; the sweeper re-offers it.

## Logging

One line per file to session stdout:

- Success: `<timestamp> ingested <raw_rel> — <one-line manifest summary>`
- Failure: `<timestamp> failed <raw_rel> — <one-line error>`
