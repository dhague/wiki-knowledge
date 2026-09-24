---
name: wiki-export
description: Export the wiki vault as a static HTML site — multi-page, or one self-contained file. Asks which format, picks entry-point pages using LLM judgment over the ranked candidates, then calls enchiridion export --starters to write the output. A quoted title argument names the wiki for this run and offers to save it as the default.
---
# Wiki Export

Runs inline in the invoking session — no dedicated agent. Produces a static
HTML site at `web/` (or `--out <dir>`) — or, in single-file mode, one
self-contained HTML file — by picking 10–12 good entry-point pages and calling
`enchiridion export --starters`.

The skill authors no HTML. It picks refs, feeds them to the subcommand, and
the subcommand writes the output. Both formats are the subcommand's job; the
skill only asks which one, and passes the flag.

The wiki's name in the nav bar and front page heading resolves in the
subcommand, not here: `--title` for this run → the title saved in
`.wiki-knowledge/config.json` → the vault directory name. The skill only
passes a title through, and saves one when the user says so.

The script layer ships in this skill's `scripts/` directory. Resolve the runtime and the bundle once before any step that calls it — `node` where it exists, `bun` where it does not (the fallback for a host that ships only Bun) — and this skill's base directory as the host reports it when the skill loads:

```bash
RUNTIME=$(command -v node || command -v bun)
ENCHIRIDION="<this skill's base directory>/scripts/enchiridion.cjs"
```

Every call below is then `"$RUNTIME" "$ENCHIRIDION" <subcommand> <args...>`. If neither runtime is present, say so plainly and stop.

## Procedure

1. **Resolve vault root** — `$WIKI_ROOT` if set, else cwd.

2. **Ask which format.** Two choices, multi-page first — it is the default
   and the right answer for anything but a one-file hand-off:

   - **Multi-page** — a directory of linked HTML pages under `web/`. Good for
     browsing on a laptop, serving, or reading in place.
   - **Single-file** — one self-contained HTML file, every page a section,
     navigable by hash. Good for emailing: the recipient opens the attachment
     on a phone and reads it with no unzip and no network.

   Match the user's phrasing rather than asking again when they have already
   said it: `--single-file` in the invocation, or words like "one file",
   "email it", "attach it", means single-file. Otherwise ask, and take
   multi-page as the answer to silence. Pass `--single-file` in step 7 when
   single-file was chosen.

3. **Take the positional title, if there is one.** A quoted title argument
   (`"My Knowledge Base"`) names the wiki for this run — pass it as `--title`
   in step 7, and offer to save it in step 8. With no positional argument there
   is nothing to do here: the output already carries the saved title, or the
   vault directory name.

4. **Get the ranked candidates:**
   ```bash
   "$RUNTIME" "$ENCHIRIDION" export --candidates
   ```
   Emits one compact JSON array on a single stdout line — each entry is an object with fields
   `pageRef`, `title`, `summary`, `kind`, `tags`, `inboundCount`. No files
   written.

5. **Read vault orientation docs** — all optional, degrade silently if absent:
   - `README.md` at vault root
   - `CLAUDE.md` at vault root
   - `AGENTS.md` at vault root

   These tell you the vault's purpose, main topics, and any explicit guidance
   on which pages are entry points.

6. **Pick 10–12 starters.** Using the candidates list (ranked by inbound-link
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

7. **Run the export:**
   ```bash
   "$RUNTIME" "$ENCHIRIDION" export [--single-file] [--out <path>] [--raw] [--force] \
     [--allow-dirty] [--title "<title>"] \
     --starters \
       "wiki/concepts/foo.md=A good starting point for X" \
       "wiki/entities/bar.md" \
       "wiki/concepts/baz.md=Core concept used everywhere"
   ```
   Pass any flags the user supplied (`--out`, `--raw`, `--force`,
   `--allow-dirty`) through to the export command, plus `--single-file` when
   step 2 chose single-file and `--title "<title>"` when step 3 found a
   positional title.

   **One shell call** — `--starters` is a multi-value option; all chosen
   refs follow on the same command line.

8. **Offer to save the title** — only when step 3 found one. Ask the user
   whether to save it as this vault's persistent title; on yes:
   ```bash
   "$RUNTIME" "$ENCHIRIDION" export --save-title "<title>"
   ```
   That writes `.wiki-knowledge/config.json` at the vault root and exports
   nothing, so it is a second, cheap call rather than a re-run. Every later
   export carries the saved title unless `--title` overrides it for one run.
   On no, say nothing further — the run's title was not saved.

9. **Report the result.** Tell the user where the output was written and how
   many pages it contains (count the `wiki/` entries in the candidates list),
   and name the title it was written under. In single-file mode also report
   how large the file is when the run warned about its size, and pass that
   warning on: over 5 MB is awkward to email, and multi-page mode is the
   alternative.

## Error handling

- `ExportDirtyError`: vault has uncommitted changes. Tell the user to commit
  or stash them, or re-run with `--allow-dirty`.
- `ExportTargetNotEmptyError`: output directory already has content. Tell the
  user to pass `--force` to overwrite.
- `ExportTargetIsDirectoryError`: `--single-file` was pointed at a directory.
  Tell the user `--out` names the output *file* in this mode.
- A size warning on stderr is not a failure: the file was written.
- Any other error: surface the raw error message.

## Flags

| Flag | Meaning |
|------|---------|
| `--single-file` | Write one self-contained HTML file instead of a directory tree |
| `--out <path>` | Output directory — or, with `--single-file`, the output file (defaults: `web/`, or `wiki.html` at the vault root) |
| `--raw` | Include `raw/` pages in the output |
| `--force` | Overwrite a non-empty output directory (multi-page only) |
| `--allow-dirty` | Skip dirty-tree check |
| `--title <title>` | Wiki title for this run only; leaves the saved default alone |
| `--save-title <title>` | Save the title as the persistent default and exit (exports nothing) |

A quoted title argument is this skill's spelling of `--title` plus the step-8
offer to save it.
