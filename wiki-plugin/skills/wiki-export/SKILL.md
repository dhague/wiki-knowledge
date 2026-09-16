---
name: wiki-export
description: Export the wiki vault as a static HTML site. Picks entry-point pages using LLM judgment over the ranked candidates, then calls enchiridion export --starters to write the final site. Invoke via /wiki-export ["Wiki Title"] [--out <dir>] [--raw] [--force] [--allow-dirty] — a quoted positional title names the wiki for this run and offers to save it as the default.
---
# Wiki Export

Runs inline in the invoking session — no dedicated agent. Produces a static
HTML site at `web/` (or `--out <dir>`) by picking 10–12 good entry-point pages
and calling `enchiridion export --starters`.

The skill authors no HTML. It picks refs, feeds them to the subcommand, and
the subcommand writes the site.

The wiki's name in the nav bar and front page heading resolves in the
subcommand, not here: `--title` for this run → the title saved in
`.wiki-knowledge/config.json` → the vault directory name. The skill only
passes a title through, and saves one when the user says so.

**On Claude Code**, resolve the binary once before any step that calls it:
```bash
ENCHIRIDION=$(ls ~/.claude/plugins/cache/enchiridion-wiki-plugin/wiki-knowledge/*/bin/enchiridion | sort -V | tail -1)
```
Use `"$ENCHIRIDION"` for every call below.

## Procedure

1. **Resolve vault root** — `$WIKI_ROOT` if set, else cwd.

2. **Take the positional title, if there is one.** `/wiki-export "My
   Knowledge Base"` names the wiki for this run — pass it as `--title` in
   step 6, and offer to save it in step 7. With no positional argument there
   is nothing to do here: the site already carries the saved title, or the
   vault directory name.

3. **Get the ranked candidates:**
   ```bash
   "$ENCHIRIDION" export --candidates
   ```
   Emits a JSON array to stdout — each entry is an object with fields
   `pageRef`, `title`, `summary`, `kind`, `tags`, `inboundCount`. No files
   written.

4. **Read vault orientation docs** — all optional, degrade silently if absent:
   - `README.md` at vault root
   - `CLAUDE.md` at vault root
   - `AGENTS.md` at vault root

   These tell you the vault's purpose, main topics, and any explicit guidance
   on which pages are entry points.

5. **Pick 10–12 starters.** Using the candidates list (ranked by inbound-link
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

6. **Run the export:**
   ```bash
   "$ENCHIRIDION" export [--out <dir>] [--raw] [--force] [--allow-dirty] \
     [--title "<title>"] \
     --starters \
       "wiki/concepts/foo.md=A good starting point for X" \
       "wiki/entities/bar.md" \
       "wiki/concepts/baz.md=Core concept used everywhere"
   ```
   Pass any flags the user supplied (`--out`, `--raw`, `--force`,
   `--allow-dirty`) through to the export command, plus `--title "<title>"`
   when step 2 found a positional title.

   **One shell call** — `--starters` is a multi-value option; all chosen
   refs follow on the same command line.

7. **Offer to save the title** — only when step 2 found one. Ask the user
   whether to save it as this vault's persistent title; on yes:
   ```bash
   "$ENCHIRIDION" export --save-title "<title>"
   ```
   That writes `.wiki-knowledge/config.json` at the vault root and exports
   nothing, so it is a second, cheap call rather than a re-run. Every later
   export carries the saved title unless `--title` overrides it for one run.
   On no, say nothing further — the run's title was not saved.

8. **Report the result.** Tell the user where the site was written and how
   many pages it contains (count the `wiki/` entries in the candidates list),
   and name the title the site was written under.

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
| `--title <title>` | Wiki title for this run only; leaves the saved default alone |
| `--save-title <title>` | Save the title as the persistent default and exit (exports nothing) |

The positional title (`/wiki-export "My Knowledge Base"`) is this skill's
spelling of `--title` plus the step-7 offer to save it.
