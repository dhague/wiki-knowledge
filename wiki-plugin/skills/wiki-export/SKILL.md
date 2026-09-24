---
name: wiki-export
description: Export the wiki vault as a static HTML site — multi-page, or one self-contained file. Asks which format, picks entry-point pages using LLM judgment over the ranked candidates, offers the vault's own front-door page as the site's start page, then calls enchiridion export --starters / --start-page to write the output. A quoted title argument names the wiki for this run and offers to save it as the default.
---
# Wiki Export

Runs inline in the invoking session — no dedicated agent. Produces a static
HTML site at `web/` (or `--out <dir>`) — or, in single-file mode, one
self-contained HTML file — either by picking 10–12 good entry-point pages and
calling `enchiridion export --starters`, or by nominating the vault's own
front-door page with `--start-page`.

The skill authors no HTML. It picks refs, feeds them to the subcommand, and
the subcommand writes the output. Both formats are the subcommand's job; the
skill only asks which one, and passes the flag.

The wiki's name in the nav bar and front page heading resolves in the
subcommand, not here: `--title` for this run → the title saved in
`.wiki-knowledge/config.json` → the vault directory name. The skill only
passes a title through, and saves one when the user says so.

The landing page resolves there too: `--start-page <ref>` for this run → the
start page saved in `.wiki-knowledge/config.json` → the generated front page.
Naming one makes that page the landing page, drops the generated
title/page-count/get-started blocks, and puts the kind-index list at the foot
of the page. The skill only nominates a ref, and saves one when the user says
so.

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
   multi-page as the answer to silence. Pass `--single-file` in step 8 when
   single-file was chosen.

3. **Take the positional title, if there is one.** A quoted title argument
   (`"My Knowledge Base"`) names the wiki for this run — pass it as `--title`
   in step 8, and offer to save it in step 9. With no positional argument there
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

6. **Offer a start page.** The vault may already keep a front-door page — an
   orientation or index page whose whole job is to be the first thing a reader
   sees. Your judgment picks it out of the same material as the candidates and
   the vault docs: a page in a custom `home`-like folder, a page whose title or
   summary reads as the front door ("Home", "Start here", "Overview", "Index"),
   or one the vault docs name as the entry point. Judge the page, **not its
   kind** — `home` is not a kind, and the script must never key off one.

   If you find a plausible candidate, ask the user first: *"This vault has a
   front-door page (`wiki/home/home.md`). Use it as the exported site's start
   page?"* — and do not spend time on step 7 until the answer is in, because a
   start page supplies its own entrance and the get-started set is not
   rendered beside it.

   Found nothing that reads as a front door? Skip this step silently — most
   vaults have no such page, and the generated front page is the right answer
   for them.

7. **Pick 10–12 starters** — skip this step entirely when step 6 was accepted.
   Using the candidates list (ranked by inbound-link count), the vault docs, and
   your judgment, choose 10–12 pages that a new reader would most benefit from
   seeing first. Criteria to apply:

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

8. **Run the export.** The two shapes are exclusive — a start page supplies the
   landing page, so its command carries no `--starters`:

   ```bash
   # Ordinary export: the get-started set is the skill's choice (step 7).
   "$RUNTIME" "$ENCHIRIDION" export [--single-file] [--out <path>] [--raw] [--force] \
     [--allow-dirty] [--title "<title>"] \
     --starters \
       "wiki/concepts/foo.md=A good starting point for X" \
       "wiki/entities/bar.md" \
       "wiki/concepts/baz.md=Core concept used everywhere"

   # Start-page export: step 6 was accepted, so --starters is omitted.
   "$RUNTIME" "$ENCHIRIDION" export [--single-file] [--out <path>] [--raw] [--force] \
     [--allow-dirty] [--title "<title>"] \
     --start-page "wiki/home/home.md"
   ```

   Pass any flags the user supplied (`--out`, `--raw`, `--force`,
   `--allow-dirty`) through to the export command, plus `--single-file` when
   step 2 chose single-file and `--title "<title>"` when step 3 found a
   positional title.

   **One shell call** — `--starters` is a multi-value option; all chosen
   refs follow on the same command line.

9. **Offer to save the title and the start page.** Ask about each only when
   there is something to save: the title when step 3 found one, the start page
   when step 6 was accepted. On yes:
   ```bash
   "$RUNTIME" "$ENCHIRIDION" export --save-title "<title>"
   "$RUNTIME" "$ENCHIRIDION" export --save-start-page "<ref>"
   ```
   Each writes `.wiki-knowledge/config.json` at the vault root and exports
   nothing, so they are cheap second calls rather than a re-run. Every later
   export carries the saved title and start page unless a flag overrides them
   for one run. A blank `--save-start-page ""` clears the saved start page and
   returns the vault to the generated front page. On no, say nothing further —
   the run's choice was not saved.

10. **Report the result.** Tell the user where the output was written and how
    many pages it contains (count the `wiki/` entries in the candidates list),
    name the title it was written under, and say which page is the landing page
    when a start page was used. In single-file mode also report how large the
    file is when the run warned about its size, and pass that warning on: over
    5 MB is awkward to email, and multi-page mode is the alternative.

## Error handling

- `ExportDirtyError`: vault has uncommitted changes. Tell the user to commit
  or stash them, or re-run with `--allow-dirty`.
- `ExportTargetNotEmptyError`: output directory already has content. Tell the
  user to pass `--force` to overwrite.
- `ExportTargetIsDirectoryError`: `--single-file` was pointed at a directory.
  Tell the user `--out` names the output *file* in this mode.
- `ExportStartPageError`: the ref does not name a page this export carries —
  an unknown ref, a `raw/` page without `--raw`, or a saved start page that no
  longer matches. The message says which. Offer to re-run with a different
  ref, add `--raw`, or clear the saved start page with a blank
  `--save-start-page`.
- A size warning, or the `--starters`-ignored warning, on stderr is not a
  failure: the file was written.
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
| `--start-page <ref>` | Export this page as the site's landing page for this run only; drops the get-started block |
| `--save-start-page <ref>` | Save the ref as the vault's persistent start page and exit; a blank ref clears it (exports nothing) |
| `--candidates` | Emit the ranked get-started candidates as one JSON line and exit |
| `--starters <refs...>` | The get-started entries, optionally as `ref=annotation` |

A quoted title argument is this skill's spelling of `--title` plus the step-9
offer to save it. Step 6's start-page offer is this skill's spelling of
`--start-page` plus the same offer for `--save-start-page`.
