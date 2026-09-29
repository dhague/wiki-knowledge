---
name: wiki-init
description: Scaffold a brand-new wiki vault — folder structure, git repo, and (optionally) query-from-anywhere plugin registration. Use when standing up a vault that doesn't exist yet, as opposed to ingesting into one that already does.
---
# Wiki Init

New empty vault at target dir. One-time scaffold. Not `wiki-ingest` (that fills existing vault) — don't run on existing vault.

Folder layout, `.gitignore`, git init, `settings.json`, scaffold commit — all handled by `enchiridion init` (see `enchiridion-ts/src/initwiki.ts`). Only decision left: deployment mode.

The script layer ships in this skill's `scripts/` directory. Resolve it once before any step that calls it — the host reports this skill's base directory when the skill loads:

```bash
RUNTIME=$(command -v node || command -v bun)
ENCHIRIDION="<this skill's base directory>/scripts/enchiridion.cjs"
```

`ENCHIRIDION` MUST be an absolute local filesystem path. A harness-internal `skill://` URI is not one — the runtime is an external process and resolves it as a relative file path, so the call fails before the script runs. If the host reports the base directory as such a URI rather than a real path, convert it first (`baseDir=$(realpath '<base-dir>')`).

Every call below is `"$RUNTIME" "$ENCHIRIDION" <subcommand> <args...>`. If neither runtime is present, say so and stop.

[`wiki-conventions` → Scripts](../wiki-conventions/reference/scripts.md#script-runtime-contract) — the shared reference for vault-root resolution and the full subcommand catalogue.

## Procedure

Given target dir `<vault>` (path arg, or `cwd` if omitted):

1. **Ask user which deployment mode**, unless already stated:
   - **query-from-anywhere** — common for personal/dogfooding vault: plugin stays installed user-scope elsewhere, new vault just needs registration.
   - **dedicated** — the vault is the project the session runs in. `enchiridion init` never installs agent tooling — it only skips writing session registration; launch the session from the vault root after.

2. **Run the binary.** Pass `--plugin-root` only for a host that registers plugins from a local directory (see `enchiridion init --help`):
   ```
   # query-from-anywhere:
   "$RUNTIME" "$ENCHIRIDION" init "<vault>" --mode query-from-anywhere --plugin-root "<this skill's base directory>/../.."

   # dedicated:
   "$RUNTIME" "$ENCHIRIDION" init "<vault>" --mode dedicated
   ```
   Non-zero exit (e.g. `<vault>` already a vault): report stderr, stop — don't scaffold over existing vault by hand.

3. **Report** vault path (the only stdout line), deployment mode used, next step: run the `wiki-ingest` procedure (or `save-conversation`) against it.