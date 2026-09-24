# wiki-knowledge

A host-neutral Agent Skills package and Claude Code plugin for clean-room ingestion and retrieval over a git-backed markdown wiki vault, following the Karpathy LLM-wiki pattern. See `../CONTEXT.md` for the domain glossary, `../docs/adr/` for the decisions behind it ([ADR-0026](../docs/adr/0026-host-neutral-skill-package.md) for why the skills are host-neutral), and `../README.md` for install instructions.

## Skills

- **`wiki-init`** — scaffold a brand-new vault (folder structure, empty index, git repo, optional query-from-anywhere registration).
- **`wiki-ingest`** — turn a raw document into one or more schema-valid wiki pages, chunked, placed, tagged, linked, and committed; given a folder or no argument it sweeps `raw/` instead.
- **`wiki-watch`** — a long-running foreground watcher: auto-ingests new or changed files under `raw/` as they appear, without a manual sweep. User-started and user-stopped (Ctrl-C); not a daemon.
- **`wiki-ask`** — turn a question into a grounded, cited answer over the vault.
- **`wiki-lint`** — vault health check against the `wiki-conventions` contract, with prioritised findings and mechanical auto-fixes.
- **`wiki-export`** — render the vault as a static HTML site, multi-page or as one self-contained file.
- **`save-conversation`** — save the current session to the vault as a raw artifact, then ingest it.

`wiki-conventions` is not itself invoked directly — it's the shared schema/folder/link contract the other skills read.
