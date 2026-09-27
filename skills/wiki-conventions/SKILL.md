---
name: wiki-conventions
description: The wiki vault's format contract — kind-axed folder structure, frontmatter schema, relative-markdown link rules, typed-edge vocabulary. It is the page shape `wiki-ingest` writes and `wiki-ask` reads — load it before creating, moving, linking or reading a wiki page.
---

# Wiki conventions

The vault's pure format contract — the page shape ingestion writes and retrieval reads. The rules for authoring a page are [`wiki-ingest` → reference/authoring.md](../wiki-ingest/reference/authoring.md); the script runtime contract is [`reference/scripts.md`](reference/scripts.md). On any conflict between this file and information from elsewhere, this file wins on format.

## Vault structure

Vault is a **git repository**. Layout is opinionated and **plugin-fixed** — same in every vault. Units are **pages** (not "notes") — one markdown file each under `wiki/`, frontmatter + body; keeps `raw/notes/` unambiguous.

```
<vault root>/
├── wiki/                     ← pages; the vault marker
│   ├── concepts/             ← an idea / technique / pattern / principle / how-it-works (the default; kind value `concept`)
│   ├── entities/             ← a named thing linked repeatedly (person / team / product / tool / service / project / org; kind value `entity`)
│   ├── sources/              ← a stand-in for a raw artifact; one per ingested raw file, REQUIRES `raw_source:` → ../../raw/… (kind value `source`)
│   └── synthesis/            ← a saved query result; links to its inputs via `source`-type edges (kind value `synthesis`, folder unchanged)
└── raw/                      ← immutable originals, git-tracked, sibling of wiki/
    └── <user-extensible>/    ← emails/ meetings/ notes/ clippings/ documents/ … an OPEN set
```

- Four **kind-folders** under `wiki/` are the canonical set; any user-added `wiki/<custom>/` folder that pre-exists is a peer placement target (see [Placement algorithm](#placement-algorithm)). **Kind** is the only axis both decidable from a page's content *and* domain-independent; a genuine toss-up between two folders means the axis is wrong — merge them and push the distinction to tags. (See [Naming](#naming) for folder-vs-value convention.)
- **Multi-membership never spawns a second folder.** Page touching several subjects filed once, by primary function; every other facet rides on **tags + typed edges**. Folder tree is only a thin, decidable filing handle.
- `raw/` is **sibling** of `wiki/`, not child — immutable-originals-vs-generated split. Search index walks `wiki/**` only.
- `raw/` is **inbox** scanned by deterministic script; subfolders are **user-extensible** — no mandated catch-all.
- **Search refuses a pre-conversion root.** A directory carrying the vault marker but not a git repository (a **candidate vault**) resolves for `vault root`, but `search`/`discover` throw rather than report an empty vault — there is no committed history to read. Convert it with `wiki-init` (which runs `enchiridion init <path> --mode …`). A real repo with no commits is an empty vault, not a candidate — search is simply empty.

### Placement algorithm

**Top-to-bottom, first match wins** — placement is deterministic. Kinds split into *origin-defined* (`source`, `synthesis`) and *subject-defined* (`entity`, `concept`, or any custom kind):

1. Stand-in for an ingested raw artifact? → **`sources/`** (must carry `raw_source:` field → its `raw/` file).
2. Saved query result synthesized from other pages? → **`synthesis/`**.
3. Primarily a named thing linked repeatedly? → **`entities/`**.
4. **Custom kind** — does the subject fit a custom kind-folder that already exists in the vault? → **`wiki/<custom>/`**. Call `enchiridion vault kinds` to discover available custom kinds before deciding; each entry carries `{kind, folder, canonical, consolidatable, definition}` (`consolidatable` tells whether `concept-fragmentation` scores the kind — derived for the canonical four, declared in `KIND.md` for the rest). Custom kinds are peers of canonical ones — weigh them alongside the canonical four, not as a last resort. The plugin never auto-creates a kind-folder; only a pre-existing folder is a valid target.
5. Otherwise → **`concepts/`** (default).

### The `raw/` layer

`raw/` holds **content-immutable** originals. Ingestion **never edits a raw file's contents**. Links into `raw/` are percent-encoded (see [Links](#links)) so any filename is linkable. See [Naming](#naming) for filename and prefix rules.

### Naming

- **Kind-folders pluralize** (`concepts/`, `entities/`, `sources/`; `synthesis/` unchanged) — **kind values stay singular** (`concept`, `entity`, `source`, `synthesis`).
- **Page filenames** — lowercase **kebab-slug of the title, no date prefix** — `concepts/prepared-statements.md`. Git carries ingestion date; `source_date` carries valid-time; a filename date would be a third, drifting clock.
- **Raw filenames** preserve external identity unchanged. Plugin-authored raw files carry `YYYY-MM-DD-hhmm-` prefix at creation. External raw files renamed outside tool are repaired by deferred linter; core build never renames existing raw file.

## Frontmatter schema

Every page opens with YAML frontmatter block. **Only fields requiring judgment live here** — anything git can tell us is derived on demand (see [Derived from git](#derived-from-git)).

```yaml
---
title: <human title>
summary: <one line, ≤ ~20 words>
tags: [<tag>, <tag>]
source_date: <YYYY-MM-DD>
raw_source: "[<filename>](<encoded relative/path into raw/>)"
volatility: stable | evolving | volatile
# Relationships — each an optional list of relative-markdown links, quoted so YAML does not read the [ as a flow sequence. Include only the keys that have links; omit the rest.
supersedes:
  - "[<title>](<relative/path.md>)"
refines:
  - "[<title>](<relative/path.md>)"
contradicts:
  - "[<title>](<relative/path.md>)"
example-of:
  - "[<title>](<relative/path.md>)"
source:
  - "[<title>](<relative/path.md>)"
related:
  - "[<title>](<relative/path.md>)"
---
```

Field notes:

- **`title`** — human-readable name; filename is its kebab-slug.
- **`summary`** — single most important field: retrieval judges a candidate by its `summary` before reading the body, and the search index matches it. One line, ≤ ~20 words, written well at ingestion.
- **`tags`** — emergent, not controlled. See [Tags](#tags).
- **`source_date`** — **valid time**: when the knowledge is *from* (document's own date, meeting's date). Judgment git cannot reconstruct; what temporal queries key off. Distinct from commit date. **One canonical spelling: `YYYY-MM-DD`** — valid time is a *date*, not an instant, so a time-of-day has no meaning and a `source_date` carrying a clock is truncated to its date on the way in (read and write alike). A value that isn't a valid date at all is rejected at ingest.
- **`raw_source`** — **single markdown link into `raw/`** (title = artifact's literal filename, destination = percent-encoded path), **required on `sources/` pages, omitted on every other kind**. Points at the immutable artifact the page stands in for — distinct from the `source`-type *edge*, which points at another `wiki/` page; the two live on separate keys (`raw_source:` vs `source:`) so nothing has to guess which is meant. Example: `"[my file.txt](../../raw/notes/my%20file.txt)"`.
- **`volatility`** — `stable` | `evolving` | `volatile`. Drives conditional decay at retrieval: `stable` facts don't age out, `volatile` ones flagged as possibly current-only. Authored, not inferred.
- **`supersedes`** — optional list of markdown links to pages this page replaces. **Recorded fact**, stronger than any "newer wins" guess. On contradiction, ingestion **appends new page and records `supersedes`; does not overwrite** the old one. **Never author a `superseded_by` key** — the inverse is derived by inverting every page's `supersedes` edges, which is why `discover` output and `enchiridion superseded-by` can report it on a page whose own frontmatter says nothing.
- **typed-edge keys** (`refines`, `contradicts`, `example-of`, `source`, `related`) — each optional list of markdown links to target pages; see [Typed edges](#typed-edges).

### Derived from git

**Deliberately absent:** `updated_at`, `ingested_at` — git already knows them, and a hand-maintained timestamp an agent forgets to bump is worse than none; derive from `git log`. `source_date` is **valid time** (authored), git's commit date is **transaction time** (derived). **Never add a frontmatter field for anything git already knows.**

## Tags

Tags are **emergent** — generated at ingestion, not conformed to a fixed list. **Reuse an existing tag** where one fits; **mint a new one** only where nothing does — `enchiridion discover --plan` returns the vault's tag vocabulary beside every candidate, and `--tags-containing`/`--tag-count`, derived from the draft's own candidate tags, beats the full dump ([catalogue](reference/scripts.md)). Consistency comes from reuse-first discipline, not a closed set.

`tags` is a YAML list of **single bare tokens** — each non-empty, with no whitespace, comma or quote. A delimited list collapsed into one string (`windsor", "campaign-tactics`) still reads as a value but indexes as one junk tag no filter matches, so `wiki-lint`'s `tags-shape` check reports it.

## Links

Links between pages are **relative markdown links — not wikilinks.**

- **Standard link:** `[prepared statements](../concepts/prepared-statements.md)`. Path relative to linking file's location; `entities/` to `concepts/` climbs one level (`../concepts/…`).
- **Anchors:** append heading fragment — `[edge-following rules](../wiki-ask/SKILL.md#edge-following-rules)` / `[…](../concepts/caching.md#ttl)`. Fragment is GitHub-style slug of target heading.
- **Image embeds:** leading-bang form — `![cache diagram](../raw/diagrams/2026-03-01-cache.png)`. Embeds may point into `raw/`; ordinary links between pages stay within `wiki/`.

All links **position-spliced** on move/rename by `enchiridion vault move` (both inbound links across vault and outbound links inside moved page). Links into `raw/` are **percent-encoded**: encode space, `#`, `%`, `(`, `)`, `<`, `>`; everything else (unicode, `&`, `'`, `,`, `+`) stays literal. Obsidian cannot follow destination containing literal space, so encoding is essential for interoperability.

**Frontmatter relationships use that same link form.** `raw_source`, `supersedes` and every typed-edge key hold `[title](relative/path.md)`, quoted (`"[…](…)"`) so YAML doesn't read a leading `[` as a flow sequence — `raw_source` a **single** link, the others a **list** — and may carry an anchor exactly as a body link does (`related:` → `- "[cache TTL](../concepts/caching.md#ttl)"`). `#` stays literal: the first `#` begins the fragment, so a *filename's* own hash can only be spelled `%23`, and the fragment is never part of the page an edge targets — the edge still points at the `page_ref`.

**A link is never split across lines** — no column limit, no hard wrap, frontmatter or body; every link the plugin writes sits on one line however long its destination is. An older page may still carry one of the three folded frontmatter shapes — a destination split mid-slug with a trailing `\`, a label split at a space, or a break between a label's `]` and its destination's `(` — all legal YAML, folded back to the same value by any conforming parser. Read them, never hand-edit one: `enchiridion fix split-links` joins all three, and a wrong join silently repoints the link.

## Typed edges

Typed edges are **highest-leverage output of ingestion** — retrieval cannot recover an edge type never recorded. **Each edge type is its own frontmatter key**, holding list of markdown links to target pages:

```yaml
refines:
  - "[Prepared statements](../concepts/prepared-statements.md)"
source:
  - "[Deploy runbook](../sources/deploy-github-actions.md)"
```

Edge is **directional** — reads *this page* → *key* → *target*. Include only keys that have edges; omit rest.

| Type | Reads as | Use when |
|---|---|---|
| **`refines`** | *this page refines the target* | Sharpens, extends, or adds precision to target's idea. Target is broader/earlier statement; this page is finer. |
| **`contradicts`** | *this page contradicts the target* | Claim conflicts with target's. Record edge even before conflict is resolved; when resolved by replacement, also set `supersedes`. |
| **`example-of`** | *this page is an example of the target* | Concrete instance / case study of general concept target describes. |
| **`source`** | *this page is sourced from the target* | Page draws content from target **page**. Two uses: `synthesis/` page lists under `source:` each `wiki/` page it was synthesized from, and — **mandatorily**, see [The chain of evidence](../wiki-ingest/reference/authoring.md#the-chain-of-evidence) — every page an ingestion produces points at that raw file's `sources/` stub. |
| **`related`** | *this page is associatively related to the target* | **Catch-all** — prefer sharper type whenever one fits; retrieval can follow specific type purposefully but can only wander a `related` one. |

**Ingestion guidance:** assign the most specific type that is true; the mandatory `source` back-edge is the one exception to judging per page. Under-assigning edges is silent quality loss — the graph is only as navigable as the edges recorded. **Retrieval guidance:** follow the edges the question implies (a "how does X work in practice" follows `example-of`; "is this still true" follows `contradicts`/`supersedes`), within the stated hop budget.

## Scripts

The script layer's runtime contract — vault-root resolution, batch invocation, the `--json` output contract — and the full subcommand catalogue: [`reference/scripts.md`](reference/scripts.md). This file makes no calls of its own.
