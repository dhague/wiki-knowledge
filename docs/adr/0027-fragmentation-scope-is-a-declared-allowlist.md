# concept-fragmentation's scope is a declared allowlist, and a cluster never mixes kinds

`concept-fragmentation` considers `concept` pages by default and nothing else. A kind joins the check by declaring `consolidatable: true` in its `wiki/<kind>/KIND.md` — a custom folder or the canonical `wiki/synthesis/` alike — while `entity` and `source` are a floor no declaration lifts, because their one-per-thing and one-per-artifact identity is what makes consolidation wrong for them ([ADR-0021](0021-consolidation-is-lossless-delete-not-supersede.md)). A cluster never mixes kinds, so two syntheses on one topic consolidate while a synthesis and the concept it draws on never do.

## Why

- **The check shipped with a denylist.** `NonConsolidatableKinds = ["entity", "source", "synthesis"]` is consumed as `WHERE kind NOT IN (…)`, against the decision recorded in #452 and #454 as *"Scope is restricted to `concept` and custom kinds"*. A denylist admits a newly created custom kind to the candidate set without anyone weighing it — the defect [#587](https://github.com/dhague/wiki-knowledge/issues/587) reported, found on a `research` kind holding the long-form evidence document behind a concept page.
- **Layers share vocabulary by construction.** A research page and the concept it produced share tags and title terms, so they score as one concept when they are two layers. The same holds for a synthesis and the concept it draws on: in the check's own fixture, `wiki/synthesis/cache.md` scores 0.6 against `wiki/concepts/cache-eviction.md`, above the default 0.5 bar.
- **The allowlist fixes the reported case with no vault changes at all**, and the declaration preserves what #452 wanted — a custom kind whose pages *do* fragment within their own kind. A cluster is kind-homogeneous because that, not the allowlist, is what makes an opt-in safe: a kind consolidates with its own kind and no other. It is what "custom-kind pages that **behave like concepts**" always meant.
- **Read from the working tree.** The declaration is authored vault configuration rather than page content, and `KIND.md` is unreachable from a HEAD snapshot — `isPageRef` rejects it and `VaultGit.committedPages` filters by that. Scope follows the working tree; the members it scores stay a view of HEAD ([ADR-0015](0015-search-index-view-of-committed-history.md)).
- **Advisory, not enforced.** The flag narrows what the check proposes. `ingest`'s `consolidate` executor keeps refusing only on losslessness and real refs, so a deliberate hand-authored merge stays possible.

## Considered options

- **Keep the denylist and add `research`.** Bakes one vault's vocabulary into the plugin and does nothing for the next vault.
- **Keep `concept` + all custom kinds in scope with an opt-out key** — the shape #587 filed. Rejected: an unlisted kind is still admitted by default, and no kind-level flag can say "synthesis fragments with synthesis but never with the concept it draws on".
- **Default scope `concept` with no opt-in key.** No route back for a vault whose custom-kind pages genuinely fragment together; it deletes the capability #452 asked for.
- **Declare an identity (`identity: artifact`) rather than a boolean.** One check would carry a taxonomy, and every custom kind would still need a default; the flag says the same thing in one field.
- **Let `entity` and `source` opt in too.** Their exclusion rests on page identity, which is not a per-vault preference.
- **Synthesis in scope by default.** The fixture's 0.6 synthesis×concept pair would join a cluster on upgrade — exactly the cross-layer merge this decision exists to prevent.

## Consequences

- `NonConsolidatableKinds` shrinks to the floor (`entity`, `source`); the mechanism is per-kind declaration. `concept` is in scope by name and a `KIND.md` in `wiki/concepts/` cannot declare it out — a check whose whole default is `concept` should not be silently disableable.
- **This is the one key a canonical `KIND.md` is read for.** [ADR-0020](0020-custom-kind-folders.md)'s rule stands untouched: a canonical folder's `KIND.md` still does not declare that folder's kind *value*.
- `Index.indexedPages`/`sharedTagPairs` take an include-list (`kind IN (…)`), not an exclude-list.
- **The allowlist speaks declared kinds**, the vocabulary `Index` now stores (amended 2026-09-27, [#589](https://github.com/dhague/wiki-knowledge/issues/589)) — `concept` ∪ `{a declaring folder's resolved kind : the folder declares true}`. A custom folder's kind comes from its `KIND.md` in the working tree; a canonical folder's is its `FolderKinds` value, so its `KIND.md` is never read for one. A custom folder whose declared value differs from the strip-`s` guess is no longer filtered out of scope.
- **A declaration edit forces a rebuild.** The index keeps the folder → kind map in `meta` as `kind_declarations` and rebuilds from `HEAD` when it changes, so editing a `KIND.md`'s `kind:` is picked up on the next search instead of stranding the old value.
- `readKindMeta` (the leaf `kindmeta.ts`; amended 2026-09-27, [#589](https://github.com/dhague/wiki-knowledge/issues/589)) returns `kind: null` rather than `null` when only `kind:` is absent, so a `KIND.md` carrying the flag alone is not silently dropped; `discoveredKinds` keeps its `folderToKind` fallback.
- `enchiridion vault kinds` carries a top-level `consolidatable: boolean` on every entry — derived for the canonical four, read for custom kinds — leaving `definition` unchanged (`null` for canonical).
- **Migration is silent.** Concept-like custom kinds stop being reported until they declare themselves. Documented here, in `wiki-lint`'s check reference and the release note, with `vault kinds` making the default visible. No warning check: it would fire forever on `home`, which is legitimately out of scope.
- `enchiridion place` resolves the vault root and accepts discovered custom kinds, keyed on the declared `kind:` — unlike the index's scope vocabulary, which stays strip-`s` ([#589](https://github.com/dhague/wiki-knowledge/issues/589)).
