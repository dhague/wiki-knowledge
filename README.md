# wiki-knowledge

Personal knowledge management powered by LLM agents. Turns raw documents into a structured, searchable, git-backed markdown wiki vault — then answers questions over it with typed-edge graph traversal and cited synthesis.

Follows the [Karpathy LLM-wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).

## What's inside

- **wiki-knowledge** — a Claude Code / OpenCode / DeepSeek Harness plugin that provides ingestion and retrieval over a markdown wiki vault
- **Agent pipeline** — Claude Sonnet for semantic ingestion (chunking, overlap classification, edge typing); Claude Haiku for retrieval (query expansion, BM25 search, frontier traversal, synthesis) - models are configurable for OpenCode
- **Deterministic script layer** — a single TypeScript bundle for vault I/O, placement, FTS5 search indexing, and commit construction (no model calls, no runtime to install — it runs on the already-installed Node)
- **Full-text search** — SQLite FTS5 via stdlib, zero extra search dependencies

## Install

### Claude Code

1. Add the marketplace entry and install the plugin:
   ```
   /plugin marketplace add dhague/wiki-knowledge
   /plugin install wiki-knowledge
   ```

2. Create a vault — either:
   - **Local**: `/wiki-init .` inside a project to keep the vault alongside your codebase.
   - **Remote**: `/wiki-init /some/remote/path` then set `WIKI_ROOT` to query it from anywhere. Useful when a wiki spans multiple projects or lives on a shared drive.

### OpenCode

```bash
npx @dhague/wiki-knowledge
```

Deploys the plugin into the vault's `.opencode/` directory. Pass `--global` to install into `~/.config/opencode/` for query-from-anywhere mode.

### DeepSeek Harness

DSH reads no `.claude-plugin/plugin.json` and has no marketplace, so the plugin
installs as a profile-level **bundle**: a generated patch that points DSH at the
plugin's `skills/` directory and registers the three subagents as tools.

From a checkout of this repo (the generator needs `ruamel.yaml` — the
Development venv below provides it):

```bash
python wiki-plugin/scripts/generate-dsh-bundle.py
dsh plugin --profile <profile> add "$PWD/wiki-plugin/wiring/dsh"
```

Then **restart** `dsh` — a profile's bundle list is read once at boot.
Re-running either command is safe, and
`dsh plugin --profile <profile> remove @dhague/wiki-knowledge-dsh` uninstalls it.
The bundle is profile-level, so the skills and agents are available from any
directory; export `WIKI_ROOT` before starting `dsh` to query a vault that isn't
the current directory.

The generator writes `wiki-plugin/wiring/dsh/cordis.patch.yml`, gitignored
because it bakes in this checkout's absolute path — re-run it if you move the
checkout. It compares the bundle's recorded DSH version with `dsh --version` and
prints a warning on a mismatch, never refusing, since DSH is pre-GA. See
[wiki-plugin/wiring/dsh/README.md](wiki-plugin/wiring/dsh/README.md) for what the
bundle carries, including the hooks it deliberately leaves out.

### Joule Work Desktop

Install individual skills into Joule Work Desktop via the AI Skills Library:

Download the per-skill ZIP files from the [latest GitHub Release](https://github.com/dhague/wiki-knowledge/releases/latest) (`wiki-ingest.zip`, `wiki-ask.zip`) and install each via Joule Desktop's "Install from file" option (Extensions > Add Skill > Upload).

### Standalone CLI

The script layer ships as a TypeScript bundle invoked through
`wiki-plugin/bin/enchiridion` (a thin shim that execs `node` against it).

## Design principles

**Cost-optimised by design.** Ingestion and retrieval run as subagents with model selection tuned to task. Sonnet handles the expensive judgment work (semantic chunking, edge typing); Haiku handles high-volume retrieval at a fraction of the cost. Each query only explores the frontier it needs — no expensive vector re-ranking, no full-graph traversal.

**Predictability through scripts, not prompts.** Everything that can be deterministic *is*. Page placement, frontmatter parsing, link rewriting, search indexing, and commit construction run as subcommands of a single CLI (`bin/enchiridion` — a TypeScript bundle run on Node) — no model in the loop. The agents call it for side effects and read its output; they never generate file paths, YAML, or git operations from a prompt.

**No new infrastructure.** SQLite FTS5 search runs in-process with zero extra dependencies. No additional runtime to install — the script layer runs on the already-installed Node interpreter. No vector database, no MCP server, no background daemons. The vault is just a git repo of markdown files — portable, diffable, and backup-friendly.

**Trust and provenance.** Every derived page traces back to its raw source through a chain of evidence. Bitemporal metadata (when the knowledge is *from* vs. when it was *written*) and explicit volatility annotations make staleness visible, not hidden.

**Agent-native, not API-native.** Ingestion and retrieval are skills that Claude Code agents execute by reading instructions and running scripts. This means the full context window, tool use, and reasoning of frontier models are available — not limited by a fixed RAG pipeline or a hardcoded prompt template.

## Commands

| Command | Purpose |
|---|---|
| `/wiki-init [path]` | Scaffold a new vault (folders, git repo, index) |
| `/wiki-ingest <path>` | Ingest one file, a folder, or sweep `raw/` |
| `/wiki-watch` | Long-running auto-ingest watcher for `raw/` |
| `/wiki-ask <question>` | Grounded, cited answer from the vault |
| `/wiki-export ["Title"]` | Render the vault as a static HTML site — multi-page, or one self-contained file |
| `/save-conversation` | Capture and ingest the current session |

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

A single-file export over 5 MB is still written, with a note on stderr
suggesting multi-page mode.

The site's title — the sticky nav bar and the front page heading — resolves
`--title` → the saved title → the vault root directory name. `/wiki-export
"My Knowledge Base"` sets it for one run and then offers to save it; the saved
title lives in `.wiki-knowledge/config.json` at the vault root, gitignored
beside the search index ([ADR-0023](docs/adr/0023-vault-config-and-title-resolution.md)).

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

`wiki-plugin/scripts/` holds the install-time tooling for the other hosts:
`generate-opencode.py` / `install-opencode.py` (see
[README-opencode.md](README-opencode.md)) and `generate-dsh-bundle.py` (see
[wiki-plugin/wiring/dsh/README.md](wiki-plugin/wiring/dsh/README.md)). It has
its own small test suite:

```bash
cd wiki-plugin
python3 -m venv .venv && source .venv/bin/activate
pip install ruamel.yaml pytest
python -m pytest
```

## Architecture

![wiki-knowledge Plugin — Runtime Architecture](docs/architecture-share-card.png)

Key decisions are documented in [docs/adr/](docs/adr/):
- No MCP server — everything runs as skills + agents + Bash-invoked scripts
- No embeddings — lexical FTS5 search + agent comprehension
- Bitemporal data model (valid time + transaction time)
- Chain of evidence from every derived page back to its raw source

See [CONTEXT.md](CONTEXT.md) for the domain glossary.

Full architecture documentation is [here](https://dhague.github.io/wiki-knowledge/docs/architecture.html).