# Wiki Knowledge Plugin

A Claude Code plugin that ingests raw documents into a git-backed markdown vault and answers questions over it. Clean-room ingestion + retrieval — no third-party knowledge-base code ported in.

## Language

**Vault**:
The git repository the plugin operates on: a `wiki/` tree of pages plus a sibling `raw/` inbox of immutable source artifacts.
_Avoid_: KB, wiki (alone — "wiki" means just the `wiki/` subtree, "vault" means the whole repo).

**Candidate vault**:
A directory carrying a vault marker (a `wiki/` folder or `.wiki-root`) but **not** a git repository — the pre-conversion state, not a vault. `vault root` still resolves it for reads; the search index refuses it (`Index.open` throws with the `enchiridion init` repair), because there is no committed history to read. Converted by `enchiridion init <path> --mode …`. Contrast a real work tree with no commits, which is an empty vault, not a candidate.
_Avoid_: vault (a candidate is what a directory *becomes* after `init`; calling it a vault is what this term exists to prevent).

**Page**:
One markdown file under `wiki/`, carrying a frontmatter block plus a body. The vault's unit of knowledge. A file becomes a page when it is **committed** — an uncommitted file under `wiki/` is a draft, not yet part of the vault, and is not retrievable ([ADR-0015](docs/adr/0015-search-index-view-of-committed-history.md)). Contrast the `raw/` inbox, where an uncommitted file is precisely what the ingestion sweep is looking for.
_Avoid_: Note, document, entry — "note" was the term in early drafts; "page" is the standardized term.

**Page reference**:
The vault-relative path by which a page is named (`wiki/concepts/a.md`) — the one address spelling the plugin uses for pages, in plans, typed edges, the index, and commits. A vault-relative path under `raw/` names a raw artifact, not a page reference.
_Avoid_: `rel` (code shorthand for the same thing), `wiki-relative path` (the deleted second spelling — a page reference is always vault-relative).

**Kind**:
The axis that places a page into one of the four `wiki/` folders. The only axis that is both decidable from a page's own content and independent of any particular vault's subject domain — which is why the folder tree is fixed by the plugin rather than configured per vault. The kind **value** is singular (`concept`, `entity`, `source`, `synthesis`, as authored/compared in code); the kind **folder** it maps to pluralizes (`concepts/`, `entities/`, `sources/`; `synthesis/` has no distinct plural, so it's unchanged) — the two are deliberately decoupled, not a 1:1 name match ([ADR-0008](docs/adr/0008-kind-folders-plural-kind-values-singular.md)).
_Avoid_: Category, type (too generic — "kind" names specifically this folder axis).

**Concept**:
The default kind: an idea, technique, pattern, principle, or how-it-works explanation not primarily about a named thing.

**Entity**:
A kind for a named thing linked repeatedly — a person, team, product, tool, service, project, or org.

**Source (page)**:
A kind that stands in for one ingested `raw/` artifact; carries the required `raw_source` field pointing at it. Distinct from the `source`-typed edge, which points at another wiki page.

**Synthesis**:
A kind for a saved retrieval result — written by `wiki-researcher` only on the user's explicit confirmation, never automatically. Links back to the pages it drew on via `source`-typed edges.

**Raw artifact**:
An immutable original file under `raw/` (an email, meeting note, clipping, document, …). Ingestion never edits its contents, though it may rename the file to normalize it.
_Avoid_: Source document, attachment.

**Typed edge**:
A directional, named relationship from one page to another, recorded as a frontmatter key holding a list of markdown links. The five types are `refines`, `contradicts`, `example-of`, `source`, and `related` — each page names only the keys it has edges for.
_Avoid_: Link (a typed edge is a specific relationship; "link" alone means any markdown link, typed or not), backlink.

**Supersedes**:
A recorded fact that one page replaces another, distinct from a `newer wins` recency guess. On a contradiction, ingestion appends a new page and records `supersedes` — it never overwrites the superseded page.

**Concept fragmentation**:
A cluster of small, closely-related concept pages whose knowledge is better expressed as one page with sections. The degenerate two-member case is a pair of near-duplicate pages. Distinct from concepts that are merely *related*: distinct-but-related concepts are joined by a typed edge, not consolidated.
_Avoid_: Duplication (too narrow — fragmentation is scatter across pages, not only exact copies).

**Consolidation**:
The operation that resolves concept fragmentation by absorbing a cluster of pages into one survivor page, each consolidated page's content becoming a section of the survivor, and every inbound link repointed to the survivor. Lossless by construction — no knowledge is dropped — which is why the consolidated pages are deleted rather than recorded as superseded ([ADR-0021](docs/adr/0021-consolidation-is-lossless-delete-not-supersede.md)).
_Avoid_: Merge (that is `enchiridion page merge`, a frontmatter list union — and git's), Fold (line folding in YAML, the emitter's business: [ADR-0024](docs/adr/0024-emitted-lines-are-not-folded.md)), Supersede (a consolidation is lossless and deletes the losers; supersession preserves both pages to keep a conflicting claim).

**Volatility**:
A page's authored judgment of how likely its content is to go stale: `stable`, `evolving`, or `volatile`. Drives whether retrieval discounts a page's age.

**Source date**:
The authored date the page's knowledge is *from* (valid time) — distinct from the page's commit date (transaction time). The pair is this vault's bitemporal model.

**Commit date**:
The date of the latest commit touching a page (transaction time) — when the page was actually written or last changed, as opposed to when its knowledge dates from. The transaction-time half of the bitemporal pair, and the only thing retrieval knows about a page that is derived from the vault's history rather than from the page's own text. Merge commits don't set it.
_Avoid_: Modified date, updated date — a page's file mtime is not its commit date, and only the commit date is part of the vault (see **Page**).

**Golden vault**:
A small (~15–30 page), hand-authored ground-truth vault used as the eval and measurement substrate — never the output of the plugin's own ingestion. Owned by a human, not generated by an agent, so evals can't be graded against criteria the implementation itself produced.

**Deployment mode**:
Whether the plugin resolves the vault as the launch directory (**dedicated**) or via `$WIKI_ROOT` while installed user-scope for use from any repo (**query-from-anywhere**). Both are supported; the vault-root resolution order is what makes either possible (see [ADR-0004](docs/adr/0004-deployment-modes-and-vault-root-resolution.md)).

**Plugin**:
The Claude Code install of this project — the eight skills plus the three model-pinned subagents, the session hooks and the marketplace entry. The only surface that can pin a model tier or run a hook, and therefore the only one where ingestion and retrieval deliberately run on different models ([ADR-0026](docs/adr/0026-host-neutral-skill-package.md)).
_Avoid_: skill package (that is the host-neutral install), extension, app.

**Skill package**:
The same eight skills published as one host-neutral install (`npx skills add dhague/wiki-knowledge --all`), each self-contained with its own bundled script layer. Authored once under `wiki-plugin/skills/` and copied to repo-root `skills/` at release; installed by any host that reads the Agent Skills standard's skill directory, including OpenCode and DeepSeek Harness. Carries no model tier, no hook and no subagent — everything a host cannot express portably belongs to the **plugin**.
_Avoid_: plugin (the two installs do not carry the same thing), bundle (that named the deleted per-host DSH artifact), skills repo.

**Session root**:
The project a host session's state belongs to — under which that host keeps its session state (`.claude/wiki-knowledge/sessions/` for Claude Code, `.opencode/…` for OpenCode), and **never the vault**, which in query-from-anywhere mode is somewhere else entirely. Resolved per host by one order: the host's env override (`$CLAUDE_PROJECT_DIR` for Claude Code; OpenCode exports none) → the nearest ancestor of cwd carrying the host's marker directory → **stop at `$HOME`**, "no project" rather than a cwd fallback ([ADR-0025](docs/adr/0025-session-root-per-host-no-cwd-fallback.md)). Deliberately *not* the vault-root order ([ADR-0004](docs/adr/0004-deployment-modes-and-vault-root-resolution.md)): that one ends in a cwd fallback, and a session-state writer that fell back would create a state tree wherever the caller stood (#485).
_Avoid_: Project root, project dir (the vault root is the project dir in dedicated mode; this names whose session state it is), session directory (that is the `sessions/` directory under this root, not the root itself).

**Turn**:
One assistant message in an agent session, which may carry several parallel tool calls. Agent procedures are designed against turn cost — see [ADR-0007](docs/adr/0007-turn-cost-not-tool-call-count.md).
_Avoid_: Tool call — a turn may batch several tool calls together, so the two counts diverge; see ADR-0007.

**Tool call**:
One `tool_use` invocation within a turn. Turns are not exactly recoverable from what's observable locally (no per-message identifier or timestamp in the `PostToolUse` payload, and subagent turns aren't persisted at all), so tool-call count is the measured proxy for turn count — see [ADR-0007](docs/adr/0007-turn-cost-not-tool-call-count.md).
_Avoid_: Turn (interchangeably) — a tool call is one invocation; a turn may contain several. #98 used the two loosely before this ADR pinned them apart.

**Export**:
Rendering the vault to a self-contained, offline static HTML artifact — `wiki/` always, `raw/` opt-in — via `enchiridion export`. A deterministic file transform that reads the working tree but refuses to run while the exported subtree is dirty, so the output never publishes uncommitted bytes ([ADR-0022](docs/adr/0022-static-html-export.md)). Distinct from ingestion (into the vault) and retrieval (out of it): export is a read-only projection of the whole vault into another format. The artifact takes one of two shapes — see **Output mode**.
_Avoid_: Publish, build — "export" names specifically this markdown-to-HTML projection, not deployment or the TypeScript bundle build.

**Output mode**:
Which shape an export writes. **Multi-page** (the default) writes the **web tree**; **single-file** (`--single-file`) writes one self-contained HTML document whose pages are **sections**, for handing to someone who will open it on a phone. The mode is one decision rather than two, because it settles both how a link to a page is spelled and what becomes of a relative destination the export does not carry — a document with no second file to point at cannot leave either to the author ([ADR-0022](docs/adr/0022-static-html-export.md)).
_Avoid_: Format, layout — and note `wiki.html` is an output *of* single-file mode, not a name for the mode.

**Web tree**:
The generated site in multi-page mode, at `web/` under the vault root by default (`--out` overrides). A gitignored, reproducible artifact — never committed, never a source of truth. Mirrors the vault tree, `.md`→`.html`. Single-file mode writes no tree at all; `--out` names its one file instead.
_Avoid_: Site, output dir (informal — `web/` is the default, but the term is the tree it holds).

**Section**:
One page's worth of a single-file export: a `<section>` of the one document carrying that page's nav bar, frontmatter table and article, hidden until the hash names it. Its `id` is the page's vault-relative output path with the extension dropped and every other run of non-alphanumerics collapsed to `-`; the front page alone takes the reserved `__front`. Derived by the one function used both when writing a section and when rewriting a link to it, so a rewritten link cannot miss ([ADR-0022](docs/adr/0022-static-html-export.md)).
_Avoid_: Page (a section is a page of the export — prose still says "page" for the thing itself; "section" names its form in the document), fragment (the `#id` that names a section).

**Wiki title**:
The name an exported site carries — in the sticky nav bar on every page, and as the front page heading. Resolves in one place: `--title` for this run, else the title saved in the vault config, else the vault root's directory name ([ADR-0023](docs/adr/0023-vault-config-and-title-resolution.md)). Naming the export is deployment-local presentation, not knowledge — hence the config file rather than a page.
_Avoid_: Wiki name, site name.

**Vault config**:
`.wiki-knowledge/config.json` at the vault root, beside the search index and the lock files — gitignored, absent until something writes it, and every kind of broken-or-missing read as "nothing configured" rather than an error. Holds the saved wiki title today; unknown keys survive a save ([ADR-0023](docs/adr/0023-vault-config-and-title-resolution.md)).
_Avoid_: Settings, preferences (this is the vault's own state, not user configuration of the plugin).

**Tag page**:
One generated HTML page per tag (`web/tags/<slug>.html`) listing every page that carries the tag, plus a tag index (`web/tags/index.html`) of all tags with counts. Export-only — tags themselves are just a frontmatter list; the tag page is their materialised, browsable form.

**Kind index page**:
A generated `web/wiki/<folder>/index.html` listing every page of one kind, linked from the front page's per-kind counts. Exists so every exported page is reachable from the front page without listing them all there.

**Get-started set**:
The 10–12 pages the exported front page links as entry points. Chosen by the `/wiki-export` skill's LLM judgment over the script's ranked candidates (and the vault's own root docs), or, when the script runs bare, by a deterministic inbound-link-count fallback ([ADR-0022](docs/adr/0022-static-html-export.md)). The script emits candidates and accepts the chosen set via `--starters`; it never authors the judgment and never depends on it.
_Avoid_: Featured pages, index (the front page is more than this set).
