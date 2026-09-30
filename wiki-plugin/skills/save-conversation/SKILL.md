---
name: save-conversation
description: Save the current conversation to $WIKI_ROOT as a raw markdown artifact, then ingest it into the wiki. Use when the user wants this session's conversation captured.
---
# Save Conversation

Captures session transcript into `$WIKI_ROOT/raw/conversations/`, files it into wiki.

The script layer ships in this skill's `scripts/` directory. Resolve it once before any step that calls it — the host reports this skill's base directory when the skill loads:

```bash
RUNTIME=$(command -v node || command -v bun)
ENCHIRIDION="<this skill's base directory>/scripts/enchiridion.cjs"
```

Every call below is `"$RUNTIME" "$ENCHIRIDION" <subcommand> <args...>`. If neither runtime is present, say so and stop.

`ENCHIRIDION` MUST be an **absolute local filesystem path**. Some harnesses (e.g. oh-my-pi) advertise a `skill://<name>/<path>` URI for in-process skill access — that is an internal harness URI, not a module path. Never pass a `skill://…` value to Node, Bun, Bash, or any external process; resolve the harness-supplied base directory to a real filesystem path first, then append `/scripts/enchiridion.cjs`.

[`wiki-conventions` → Scripts](../wiki-conventions/reference/scripts.md#script-runtime-contract) — the shared reference for vault-root resolution and the full subcommand catalogue.

## Procedure

`save-session` detects the host session from the environment and fetches its transcript where the host records one.

1. Run capture script with `WIKI_ROOT` set to target vault (the session may run outside the vault, so set it explicitly — [the rule](../wiki-conventions/reference/scripts.md#script-runtime-contract)):
   ```
   WIKI_ROOT="<path to vault>" "$RUNTIME" "$ENCHIRIDION" save-session --slug "<short phrase>"
   ```
   `--slug`: short phrase naming what session **covered**, judged from whole conversation — not how it opened. Session that started "look at issue 33" and became filename design argument is `wayfinder-33-raw-filename-slugs`, not `look-at-issue-33`. Few words right; script caps it.
   - Script **sanitizes rather than trusts** phrase (lowercased, `[^a-z0-9]+` → `-`, capped) — printed path differs from what you passed. Read path from stdout; never reconstruct from phrase.
   - Name **bound at first save**. Re-save reuses existing file, rewrites in place, ignores new `--slug` — raw files never renamed. Session changed topic: start new session, don't rename.

   Writes markdown transcript to vault's `raw/conversations/` inbox, prints vault-relative path (e.g. `raw/conversations/2026-07-28-1430-charting-wayfinder-33-1dc3e094.md`).
   - Non-zero exit (nothing to save, no transcript recorded, not enough conversation): report and stop.
2. Ingest file just written: if this session can spawn a subagent, delegate the `wiki-ingest` procedure with prompt `Ingest <path> into the vault.` and relay its manifest; otherwise run the `wiki-ingest` procedure inline. Use the exact path from step 1.
3. Relay ingest manifest (pages created/updated) to user.