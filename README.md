# wiki-knowledge

Personal knowledge management powered by LLM agents. Turns raw documents into a structured, searchable, git-backed markdown wiki vault — then answers questions over it with typed-edge graph traversal and cited synthesis.

Follows the [Karpathy LLM-wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).

## What's inside

- **wiki-knowledge** — a host-neutral Agent Skills package (Claude Code, OpenCode, DeepSeek Harness, and any host that reads the standard's skill directory) providing ingestion and retrieval over a markdown wiki vault
- **Agent pipeline** — on Claude Code, Sonnet for semantic ingestion (chunking, overlap classification, edge typing) and Haiku for retrieval (query expansion, BM25 search, frontier traversal, synthesis); every other host runs the same procedures on its session model
- **Deterministic script layer** — a single TypeScript bundle for vault I/O, placement, FTS5 search indexing, and commit construction (no model calls, no runtime to install — it runs on the Node or Bun the host already has)
- **Full-text search** — SQLite FTS5 via stdlib, zero extra search dependencies

## Install

### Any host (Agent Skills package)

```bash
npx skills add dhague/wiki-knowledge --all
```

Installs all eight skills into the host's own skill directory — `.agents/skills/` for OpenCode and DeepSeek Harness (which reads `<projectRoot>/.agents/skills` natively), `.claude/skills/` for Claude Code, and the equivalent for the other hosts the [skills CLI](https://skills.sh/docs/cli) supports. Add `-g` to install for your user rather than the current project.

The package is host-neutral, so it carries no model tiers and no hooks: every host runs the procedures on its own session model. For the model-pinned install, use the Claude Code plugin below.

### Claude Code

1. Add the marketplace entry and install the plugin:
   ```
   /plugin marketplace add dhague/wiki-knowledge
   /plugin install wiki-knowledge
   ```

2. Create a vault — either:
   - **Local**: `/wiki-init .` inside a project to keep the vault alongside your codebase.
   - **Remote**: `/wiki-init /some/remote/path` then set `WIKI_ROOT` to query it from anywhere. Useful when a wiki spans multiple projects or lives on a shared drive.

The plugin is the fuller install: the same eight skills, plus the three model-pinned subagents and the session hooks.

### Joule Work Desktop

Download the per-skill ZIP files from the [latest GitHub Release](https://github.com/dhague/wiki-knowledge/releases/latest) — one per skill — and install each via Joule Desktop's "Install from file" option (Extensions > Add Skill > Upload).

### Standalone CLI

The script layer is a TypeScript bundle shipped inside each skill's `scripts/`
directory, run by `node` (or `bun` where that is the only runtime available).
In a checkout, `wiki-plugin/bin/enchiridion` is a thin shim that execs `node`
against the plugin's own copy of the bundle.

## Design principles

**Cost-optimised by design.** Ingestion and retrieval run as subagents with model selection tuned to task. Sonnet handles the expensive judgment work (semantic chunking, edge typing); Haiku handles high-volume retrieval at a fraction of the cost. Each query only explores the frontier it needs — no expensive vector re-ranking, no full-graph traversal.

**Predictability through scripts, not prompts.** Everything that can be deterministic *is*. Page placement, frontmatter parsing, link rewriting, search indexing, and commit construction run as subcommands of a single CLI (the `enchiridion` bundle, run on Node or Bun) — no model in the loop. The agents call it for side effects and read its output; they never generate file paths, YAML, or git operations from a prompt.

**No new infrastructure.** SQLite FTS5 search runs in-process with zero extra dependencies. No additional runtime to install — the script layer runs on the Node or Bun the host already has. No vector database, no MCP server, no background daemons. The vault is just a git repo of markdown files — portable, diffable, and backup-friendly.

**Trust and provenance.** Every derived page traces back to its raw source through a chain of evidence. Bitemporal metadata (when the knowledge is *from* vs. when it was *written*) and explicit volatility annotations make staleness visible, not hidden.

**Agent-native, not API-native.** Ingestion and retrieval are skills that the host's agent executes by reading instructions and running scripts. This means the full context window, tool use, and reasoning of frontier models are available — not limited by a fixed RAG pipeline or a hardcoded prompt template.

## Commands

| Command | Purpose |
|---|---|
| `/wiki-init [path]` | Scaffold a new vault (folders, git repo, index) |
| `/wiki-ingest <path>` | Ingest one file, a folder, or sweep `raw/` |
| `/wiki-watch` | Long-running auto-ingest watcher for `raw/` |
| `/wiki-ask <question>` | Grounded, cited answer from the vault |
| `/wiki-lint [vault-path]` | Vault health check — prioritised findings against the conventions contract, plus mechanical auto-fixes |
| `/wiki-export ["Title"]` | Render the vault as a static HTML site — multi-page, or one self-contained file |
| `/save-conversation` | Capture and ingest the current session |

### Vault lint

`/wiki-lint` runs 16 checks in two dimensions — structural (kind-folder
conformance, frontmatter link format, split links, orphans, concept
fragmentation) and retrievability (missing `volatility`/`source_date`,
unresolved supersession, data gaps, summary quality, under-typed edges) — and
reports what it finds ordered HIGH, MEDIUM, LOW.

Ten of the checks are mechanical, run through `enchiridion check <name> --json`;
the other six need page judgment. Every finding carries a fix level:
**auto-fix** (applied without asking — link format, unambiguous `raw_source`
and cross-reference repairs, folded frontmatter links), **report-only** (the fix
needs author judgment), or **confirm-first** (a proposed change you approve or
skip — a page move, an edge retype, an orphan delete, or a concept
consolidation).

A concept consolidation (`concept-fragmentation` check) is proposed one cluster at a time and never
batched, because it deletes committed pages: on yes it hands off to the
`wiki-ingest` procedure, which reads every member and authors the merged
survivor.

Invocation follows the usual vault-root resolution: `$WIKI_ROOT` if set, else a
path argument, else the current directory.

### Export flags

`/wiki-export` asks whether you want multi-page or a single file, then passes
these through to `enchiridion export`. Multi-page is the default: a directory
of linked HTML pages under `web/`. `--single-file` writes one self-contained
HTML file instead — every page a section, navigated by hash — which is the
form to attach to an email: the recipient opens it straight from the
attachment, with no unzip, no server and no network.

| Flag | Purpose |
|---|---|
| `--single-file` | Write one self-contained HTML file instead of a directory tree |
| `--out <path>` | Output directory — or, with `--single-file`, the output file (defaults: `web/`, or `wiki.html` at the vault root) |
| `--raw` | Include `raw/` pages in the site |
| `--force` | Overwrite a non-empty output directory (multi-page only) |
| `--allow-dirty` | Export with uncommitted changes in the exported subtree |
| `--title <title>` | Wiki title for this run only |
| `--save-title <title>` | Save the title as the persistent default (exports nothing) |
| `--start-page <ref>` | Export this page as the site's landing page for this run only |
| `--save-start-page <ref>` | Save the ref as the vault's persistent start page (a blank ref clears it; exports nothing) |
| `--candidates` | Emit the ranked entry-point candidates as one JSON line, then exit (writes nothing) |
| `--starters <refs...>` | The entry-point pages for the front page, optionally as `ref=annotation` |

A single-file export over 5 MB is still written, with a note on stderr
suggesting multi-page mode.

The site's title — the sticky nav bar and the front page heading — resolves
`--title` → the saved title → the vault root directory name. `/wiki-export
"My Knowledge Base"` sets it for one run and then offers to save it; the saved
title lives in `.wiki-knowledge/config.json` at the vault root, gitignored
beside the search index ([ADR-0023](docs/adr/0023-vault-config-and-title-resolution.md)).

`--start-page` nominates a page as the site's landing page. That page is
exported at the front page's path instead of its own — so it appears exactly
once, and every link to it resolves to the landing page — the generated
title/page-count/get-started blocks are dropped, and a list of the kind index
pages is added at the foot of the page. The choice resolves the same way as
the title: `--start-page` → the saved `startPage` → the generated front page.
`--save-start-page` persists it (a blank value clears it). A nominated page
the export does not carry is a hard error rather than a quiet fallback to the
generated front page ([ADR-0022](docs/adr/0022-static-html-export.md)).

## Vault structure

```
raw/           # Inbox — drop documents here for ingestion
wiki/
  concepts/    # Abstract ideas, frameworks, definitions
  entities/    # Concrete people, tools, projects, organizations
  sources/     # Provenance stubs (one per raw artifact)
  synthesis/   # Cross-cutting analysis and summaries
```

Every page has YAML frontmatter with a typed edge graph (`refines`, `contradicts`, `example-of`, `source`, `related`, `supersedes`) and bitemporal metadata (`source_date`, `volatility`).

## Development

The script layer is a single TypeScript implementation
([ADR-0017](docs/adr/0017-bundled-typescript-on-installed-interpreter.md)),
bundled by esbuild and invoked via `wiki-plugin/bin/enchiridion` — a thin shim
that execs `node` against the bundle. `ENCHIRIDION_BIN` points that entrypoint
at a local build or alternate runtime instead.

```bash
cd enchiridion-ts
npm ci
npm run typecheck && npm run lint && npm run format:check
npm run build   # esbuild bundle to dist/cli.cjs + wasm sidecar
npm test

# Run any subcommand against the built bundle
WIKI_ROOT=<path_to_vault> node dist/cli.cjs search "connection pooling" --limit 10
WIKI_ROOT=<path_to_vault> node dist/cli.cjs ingest-scan --json
```

`wiki-plugin/skills/` is the canonical, hand-edited skill tree; repo-root
`skills/` is a generated copy of it, and `scripts/release.sh` regenerates that
copy (and refreshes the bundle inside every skill) at release time. CI fails a
PR if the two trees diverge.

`wiki-plugin/tests/` holds the shim's `bats` suite (`brew install bats-core`).
The skill tree's structural checks — frontmatter `name` matches the directory,
descriptions are non-empty, no host-specific spelling in portable prose, and
`cut-release` carries a real `metadata.internal: true` — live in the TypeScript
suite (`enchiridion-ts/src/skills.test.ts`) and run with `npm test`.

## Architecture

![wiki-knowledge Plugin — Runtime Architecture](docs/architecture-share-card.png)

Key decisions are documented in [docs/adr/](docs/adr/):
- No MCP server — everything runs as skills + agents + Bash-invoked scripts
- No embeddings — lexical FTS5 search + agent comprehension
- Bitemporal data model (valid time + transaction time)
- Chain of evidence from every derived page back to its raw source
- Skills authored host-neutrally and published as one Agent Skills package ([ADR-0026](docs/adr/0026-host-neutral-skill-package.md))

See [CONTEXT.md](CONTEXT.md) for the domain glossary.

Full architecture documentation is [here](https://dhague.github.io/wiki-knowledge/docs/architecture.html).
