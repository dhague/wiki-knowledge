---
name: wiki-export
description: Use when asked to export or publish the wiki as HTML. Export the vault as a static HTML site — multi-page, or one self-contained file. Asks which format, picks entry-point pages using LLM judgment over the ranked candidates, offers the vault's own front-door page as the start page, then calls `enchiridion export`.
---
# Wiki Export

Runs inline in the invoking session — no dedicated agent. The skill nominates refs and asks for the title; `enchiridion export` renders everything.

The script layer ships in this skill's `scripts/` directory. Resolve it once before any step that calls it — the host reports this skill's base directory when the skill loads:

```bash
RUNTIME=$(command -v node || command -v bun)
ENCHIRIDION="<this skill's base directory>/scripts/enchiridion.cjs"
```

Every call below is `"$RUNTIME" "$ENCHIRIDION" <subcommand> <args...>`, and the script resolves the vault root itself — `$WIKI_ROOT` first, else the nearest ancestor holding a `wiki/` directory or `.wiki-root` marker, else the cwd. If neither runtime is present, say so and stop.

[`wiki-conventions` → Scripts](../wiki-conventions/SKILL.md#scripts) — the shared reference for vault-root resolution and the full subcommand catalogue

## Procedure

1. **Ask which format.** Multi-page first — the default, and right for anything but a one-file hand-off:

   - **Multi-page** — a directory of linked HTML pages under `web/`. Browsing on a laptop, serving, or reading in place.
   - **Single-file** — one self-contained HTML file, every page a section, navigable by hash. Emailing: the recipient opens the attachment on a phone, no unzip and no network.

   Match the user's phrasing rather than asking again when they have already said it: `--single-file` in the invocation, or words like "one file", "email it", "attach it", means single-file. Otherwise ask, and take multi-page as the answer to silence.

2. **Take the positional title, if there is one.** A quoted title argument (`"My Knowledge Base"`) names the wiki for this run — pass it as `--title` below, and offer to save it in step 8. With no positional argument there is nothing to do here: the output already carries the saved title, or the vault directory name.

3. **Get the ranked candidates:**
   ```bash
   "$RUNTIME" "$ENCHIRIDION" export --candidates
   ```
   One compact JSON array on a single stdout line, no files written.

4. **Read vault orientation docs** — `README.md`, `CLAUDE.md`, `AGENTS.md` at the vault root, all optional and silently absent: the vault's purpose, main topics, and any explicit guidance on entry points.

5. **Offer a start page.** The vault may already keep a front-door page — an orientation or index page whose whole job is to be the first thing a reader sees. Your judgment picks it out of the same material as the candidates and the vault docs: a page in a custom `home`-like folder, a page whose title or summary reads as the front door ("Home", "Start here", "Overview", "Index"), or one the vault docs name as the entry point. Judge the page, **not its kind** — `home` is not a kind, and the script must never key off one.

   If you find a plausible candidate, ask the user first: *"This vault has a front-door page (`wiki/home/home.md`). Use it as the exported site's start page?"* — and do not spend time on step 6 until the answer is in, because a start page supplies its own entrance and the get-started set is not rendered beside it.

   Found nothing that reads as a front door? Skip this step silently — most vaults have no such page, and the generated front page is the right answer for them.

6. **Pick 10–12 starters** — skip this step entirely when step 5 was accepted. Using the ranked candidates, the vault docs, and your judgment, choose 10–12 pages a new reader would most benefit from seeing first:

   - Prefer `concept` and `entity` over `source` and `synthesis` for first-contact pages
   - Prefer pages whose `summary` describes the vault's core topics
   - Skip a superseded page — `--candidates` does not filter them
   - One short optional annotation per page (≤10 words) — why this is a good entry point; omit if nothing useful to add

   Write them as `ref` or `ref=annotation`, one per line.

7. **Run the export.** The two shapes are exclusive — a start page supplies the landing page, so its command carries no `--starters`:

   ```bash
   # Ordinary export: the get-started set is the skill's choice (step 6).
   "$RUNTIME" "$ENCHIRIDION" export [--single-file] [--out <path>] [--raw] [--force] \
     [--allow-dirty] [--title "<title>"] \
     --starters \
       "wiki/concepts/foo.md=A good starting point for X" \
       "wiki/entities/bar.md"

   # Start-page export: step 5 was accepted, so --starters is omitted.
   "$RUNTIME" "$ENCHIRIDION" export [--single-file] [--out <path>] [--raw] [--force] \
     [--allow-dirty] [--title "<title>"] \
     --start-page "wiki/home/home.md"
   ```

   **One shell call** — `--starters` is a multi-value option; all chosen refs follow on the same command line.

   `--single-file` is replaced on re-run without `--force`; `--force` is for a multi-page target.

8. **Offer to save the title and the start page.** Ask about each only when there is something to save: the title when step 2 found one, the start page when step 5 was accepted. On yes:
   ```bash
   "$RUNTIME" "$ENCHIRIDION" export --save-title "<title>"
   "$RUNTIME" "$ENCHIRIDION" export --save-start-page "<ref>"
   ```
   Each writes `.wiki-knowledge/config.json` at the vault root and exports nothing — a cheap second call, not a re-run. Every later export carries the saved title and start page unless a flag overrides them for one run; a blank `--save-start-page ""` clears the saved start page and returns the vault to the generated front page. On no, say nothing further.

9. **Report the result.** Where the output was written, how many pages it contains, the title it was written under, and which page is the landing page when a start page was used. In single-file mode, report how large the file is when the run warned about its size: that file is awkward to email, and multi-page is the alternative.

## Errors

Surface the message as-is — each one names its own remedy. A `Warning:` line on stderr (the size warning, the `--starters`-ignored warning) is not a failure: the file was written.
