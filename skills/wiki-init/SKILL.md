---
name: wiki-init
description: Scaffold a brand-new wiki vault — folder structure, git repo, and (optionally) query-from-anywhere plugin registration. Use when standing up a vault that doesn't exist yet, as opposed to ingesting into one that already does.
---
# Wiki Init

New empty vault at target dir. One-time scaffold. Not `wiki-ingest` (that fills existing vault) — don't run on existing vault.

Folder layout, `.gitignore`, git init, `settings.json`, scaffold commit — all handled by `enchiridion init` (see `enchiridion-ts/src/initwiki.ts`). Only decision left: deployment mode.

The script layer ships in this skill's `scripts/` directory. Resolve the runtime and the bundle once before any step that calls it — `node` where it exists, `bun` where it does not (the fallback for a host that ships only Bun) — and this skill's base directory as the host reports it when the skill loads:

```bash
RUNTIME=$(command -v node || command -v bun)
ENCHIRIDION="<this skill's base directory>/scripts/enchiridion.cjs"
```

Every call below is then `"$RUNTIME" "$ENCHIRIDION" <subcommand> <args...>`. If neither runtime is present, say so plainly and stop.

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