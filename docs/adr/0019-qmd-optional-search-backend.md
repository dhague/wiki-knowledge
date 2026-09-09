# QMD as an optional, opt-in search backend

**Status:** accepted

## Context

[Issue #365](https://github.com/dhague/wiki-knowledge/issues/365) asked whether [QMD](https://github.com/tobi/qmd) (`@tobilu/qmd`) — a local hybrid search engine combining BM25, vector semantic search, and LLM re-ranking via `node-llama-cpp` and GGUF models — could replace enchiridion's search engine.

QMD's value proposition is precisely the three things this project has explicitly rejected: embeddings ([ADR-0002](0002-no-embeddings-agent-read-retrieval.md), [ADR-0006](0006-stdlib-fts5-not-embeddings.md)), an MCP server ([ADR-0001](0001-no-mcp-server.md)), and it violates the shipped-bundle constraint that everything be pure JS + WASM with no native addons and no runtime downloads ([ADR-0017](0017-bundled-typescript-on-installed-interpreter.md)). QMD needs `node-llama-cpp` (a native addon), auto-downloads ~2 GB of GGUF models on first use, and is Node-only in practice.

So the honest question was not "does QMD work" but "what may this investigation reopen." We reframed the motivation deliberately: **not** "vector search is inherently better than BM25" — that is the a-priori claim ADR-0002 forbids, and it is false as stated (BM25 wins on exact terms, rare tokens, identifiers, and metadata filters, which are the bulk of a technical vault's queries; the state of the art is *hybrid*, which is why QMD itself still runs BM25). The defensible motivation is **hybrid recall gain on fuzzy/conceptual questions, to be measured behind the eval work in [#47](https://github.com/dhague/wiki-knowledge/issues/47)**.

## Decision

Accept QMD as a **permanent, opt-in, optional search backend**. **FTS5 stays the default indefinitely.** QMD does *not* become the default: doing so would drag the 2 GB models, native addon, and Node-only constraint onto every user, reopening ADR-0017's hard gates for everyone. If #47 ever measures a decisive hybrid-recall win, promoting QMD to default is a *future* ADR — this one promises only the escape valve.

- **Seam.** A single `SearchBackend` interface — FTS5 (default) and QMD (optional) — same query in, same `{ref, score}[]` out, so `wiki-researcher` / `wiki-ask` never know which ran. The seam covers **both `search` and `discover`**.
- **Whole swap, not a rerank layer.** When enabled, QMD owns retrieval end to end. Layering QMD on top of FTS5 would force two indexes in sync and re-implement the BM25 stage QMD already bundles.
- **Shell out, never embed.** The backend `exec`s a **user-installed `qmd` CLI**; we never add `@tobilu/qmd` as a dependency. `node-llama-cpp` is a native addon that cannot be bundled by esbuild and would break the pure-JS+WASM shipping model of ADR-0017 even as an `optionalDependency`. This mirrors the existing `ENCHIRIDION_BIN` shim pattern.
- **Enablement.** `WIKI_SEARCH_BACKEND=qmd` selects the backend; `QMD_BIN` (optional) overrides the binary path, else PATH lookup. Unset = FTS5.
- **Degradation.** If the binary is missing, the host is Bun, or `node-llama-cpp` won't load: **warn to stderr and fall back to FTS5**. Silent fallback would hide a misconfiguration; a hard error would break OpenCode/Bun users sharing one config. The warning goes to stderr so stdout JSON stays clean.
- **Committed-only invariant preserved.** QMD indexes a directory (the working tree), not git blobs, which would break [ADR-0015](0015-search-index-view-of-committed-history.md). We preserve the invariant with a **precondition: `wiki/` must match HEAD** (a clean tree *under the wiki folder*; drafts elsewhere — `raw/`, repo root — don't count). Then pointing `qmd` at the real `wiki/` dir *is* indexing HEAD. FTS5 silently ignores uncommitted drafts; QMD **refuses when `wiki/` is dirty** — a legible divergence, not a silent one.
- **Index location.** `.wiki-knowledge/qmd.sqlite` via QMD's `INDEX_PATH`, beside the FTS5 db under the already-gitignored, Resilio-ignored `.wiki-knowledge/` — same corruption/safety posture, per-vault isolation ([ADR-0010](0010-search-index-per-root-cache.md)). Not the global `~/.cache/qmd` (leaks state across vaults) and not project-local `.qmd/` (a second ignore rule to maintain).
- **Freshness.** Watermark-gated lazy reindex, mirroring FTS5: on search, if HEAD moved since our stored watermark, run `qmd update` + `qmd embed`, then query. The first search after a commit pays the reindex cost; surfaced via `search --status`.
- **Filters.** QMD has *no* metadata filtering (only `--collection`). `--kind` maps to **per-kind-folder QMD collections** (kind *is* the folder, [ADR-0008](0008-kind-folders-plural-kind-values-singular.md)) — QMD's one real filter, aligned with our folder axis. `--tag` / `--tag-any` / `--since` / `--until` / `--include-superseded` are honored by **over-fetching from QMD then post-filtering in our wrapper** against frontmatter (safe because `wiki/` == HEAD), truncating to `--limit`.
- **`--raw`.** Hard error under QMD. QMD has no FTS5-operator passthrough (it rewrites every query through its own tokenizer), so `--raw` is meaningless; erroring tells the truth rather than silently ignoring a flag that promises literal control.
- **Pipelines.** `search` uses `qmd query` (full hybrid + LLM rerank), with `--no-rerank` documented as a tuning knob if rerank latency/quality disappoints. `discover` uses `qmd query --no-rerank` — candidate recall wants breadth over a precisely-ordered top-N, and the reranker is the slowest stage run repeatedly during ingest. `discover` carries a **QMD-specific score-gate threshold** (QMD scores are normalized 0–1) distinct from its BM25-calibrated gate.

## Considered and rejected

- **QMD as the default engine.** Reopens ADR-0017's hard gates (native addon, 2 GB downloads, Node-only) for every user. Rejected; opt-in only.
- **Embedding `@tobilu/qmd` as a library.** Native `node-llama-cpp` cannot ship in the pure-JS+WASM bundle. Rejected in favour of shelling out to a user-installed CLI.
- **QMD-as-dependency for the transferable idea's sake.** Reject the dependency but note the portable technique: **RRF fusion over lexical query-expansions** is buildable in the current pure-JS stack with no models and no native code, and could lift ranking without reopening embeddings. Worth a separate spike, independent of QMD.

## Consequences

- Two score distributions now exist (weighted BM25 vs QMD's 0–1). Any score-gated logic (notably `discover`) must be calibrated per backend, not shared.
- `wiki/` dirtiness becomes a hard precondition under QMD where it was invisible under FTS5 — a behavioural difference users of the opt-in must understand.
- The eval harness (#47) is the named — not promised — gate for any future decision to promote QMD to default.
