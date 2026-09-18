# DeepSeek Harness bundle

The plugin's DeepSeek Harness (DSH) surface, delivered as a DSH **bundle
package**: a directory whose `package.json` declares `dsh.bundle.patch`, added
to a profile once by a person. DSH reads no `.claude-plugin/plugin.json` and has
no marketplace manifest, so this is the install route rather than a plugin
entry — see [the map](https://github.com/dhague/wiki-knowledge/issues/528).

## Generate and install

Run both from the plugin checkout, once, by hand — never from a skill or agent:

```sh
python wiki-plugin/scripts/generate-dsh-bundle.py
dsh plugin --profile <profile> add "$PWD/wiki-plugin/wiring/dsh"
```

Then **restart** `dsh`. A profile's bundle list is read once at boot, so adding
a bundle is not something `patchReload` can pick up.

Re-running either step is safe: the generator writes identical bytes for the
same checkout, and DSH's own reconcile makes a repeated `add` a no-op that never
duplicates the bundle in `dsh.profile.bundles`. Remove it with
`dsh plugin --profile <profile> remove @dhague/wiki-knowledge-dsh`.

## What it carries

One top-level `insert:` entry, appending four rows to the profile's composed
root:

| Row | What it does |
| --- | --- |
| `wiki-knowledge-skill-filesystem` | A **new** `@deepseek-ai/dsh-skill-filesystem` provider whose `customSkillDirs` points at the plugin's `skills/`, making the eight skills discoverable. |
| `wiki-knowledge-agent-wiki-ingest` | A `@deepseek-ai/dsh-tool-subagent` tool running the `wiki-ingest` agent. |
| `wiki-knowledge-agent-wiki-linter` | The `wiki-linter` agent. |
| `wiki-knowledge-agent-wiki-researcher` | The `wiki-researcher` agent. |

The skill provider is an insert, not an `id`-targeted config override on the
`skill-filesystem` host row: `dsh-web-app` disables that row, and a patch entry
matching a disabled row does nothing. There is deliberately **no hooks row** —
DSH derives the session transcript path from `$DSH_SESSION_ID` instead of
recording it, and the plugin's tool-call log is not ported.

Each subagent row carries `provider: spawn`, the agent's own name as its
model-facing `toolName`, `toolFilter.allow` translated from the canonical
`agents/*.md` `tools:` line onto DSH's global tool names, a `persona` built from
the agent body, and `maxDepth: 1` so a wiki subagent delegates no further. All
three default to the `deepseek-flash` route.

## What is committed, and why

`package.json` and this README. Nothing else.

`cordis.patch.yml` is **generated and gitignored**, because it bakes in the
absolute plugin root — `customSkillDirs` is resolved against the DSH boot cwd,
so a relative value is not an option, and a committed patch would be wrong on
every machine but the one that generated it.

Because the committed manifest carries no plugin-derived value, the bundle adds
nothing to `scripts/release.sh` and nothing to CI's freshness guard. Moving the
plugin checkout invalidates the baked path: re-run the generator and re-add the
bundle from the new location.
