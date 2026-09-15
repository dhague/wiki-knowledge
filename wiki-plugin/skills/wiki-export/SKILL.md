---
name: wiki-export
description: Export the wiki vault as a static HTML site. Picks entry-point pages using LLM judgment over the ranked candidates, then calls enchiridion export --starters to write the final site. Invoke via /wiki-export [--out <dir>] [--raw] [--force] [--allow-dirty].
---
# Wiki Export

Runs inline in the invoking session — no dedicated agent. Produces a static
HTML site at `web/` (or `--out <dir>`) by picking 10–12 good entry-point pages
and calling `enchiridion export --starters`.

The skill authors no HTML. It picks refs, feeds them to the subcommand, and
the subcommand writes the site.

**On Claude Code**, resolve the binary once before any step that calls it:
```bash
ENCHIRIDION=$(ls ~/.claude/plugins/cache/enchiridion-wiki-plugin/wiki-knowledge/*/bin/enchiridion | sort -V | tail -1)
```
Use `"$ENCHIRIDION"` for every call below.

## Procedure

1. **Resolve vault root** — `$WIKI_ROOT` if set, else cwd.

2. **Get the ranked candidates:**
   ```bash
   "$ENCHIRIDION" export --candidates
   ```
   Emits a JSON array to stdout — each entry is an object with fields
   `pageRef`, `title`, `summary`, `kind`, `tags`, `inboundCount`. No files
   written.

3. **Read vault orientation docs** — all optional, degrade silently if absent:
   - `README.md` at vault root
   - `CLAUDE.md` at vault root
   - `AGENTS.md` at vault root

   These tell you the vault's purpose, main topics, and any explicit guidance
   on which pages are entry points.

4. **Pick 10–12 starters.** Using the candidates list (ranked by inbound-link
   count), the vault docs, and your judgment, choose 10–12 pages that a new
   reader would most benefit from seeing first. Criteria to apply:

   - Prefer pages with high inbound-link counts (already ranked first)
   - Prefer `concept` and `entity` over `source` and `synthesis` for first-contact pages
   - Prefer pages whose `summary` describes the vault's core topics
   - Avoid superseded pages (if a page is superseded, skip it)
   - One short optional annotation per page (≤10 words) — explain *why* this is a good entry point; omit if nothing useful to add

   Output your choices as a list:
   ```
   wiki/concepts/foo.md=A good starting point for X
   wiki/entities/bar.md
   wiki/concepts/baz.md=Core concept used everywhere
   ```
   (Annotation is after `=`; omit `=` if no annotation.)

5. **Run the export:**
   ```bash
   "$ENCHIRIDION" export [--out <dir>] [--raw] [--force] [--allow-dirty] \
     --starters \
       "wiki/concepts/foo.md=A good starting point for X" \
       "wiki/entities/bar.md" \
       "wiki/concepts/baz.md=Core concept used everywhere"
   ```
   Pass any flags the user supplied (`--out`, `--raw`, `--force`,
   `--allow-dirty`) through to the export command.

   **One shell call** — `--starters` is a multi-value option; all chosen
   refs follow on the same command line.

6. **Report the result.** Tell the user where the site was written and how
   many pages it contains (count the `wiki/` entries in the candidates list).

## Error handling

- `ExportDirtyError`: vault has uncommitted changes. Tell the user to commit
  or stash them, or re-run with `--allow-dirty`.
- `ExportTargetNotEmptyError`: output directory already has content. Tell the
  user to pass `--force` to overwrite.
- Any other error: surface the raw error message.

## Flags

| Flag | Meaning |
|------|---------|
| `--out <dir>` | Output directory (default: `web/` at vault root) |
| `--raw` | Include `raw/` pages in the site |
| `--force` | Overwrite a non-empty output directory |
| `--allow-dirty` | Skip dirty-tree check |
