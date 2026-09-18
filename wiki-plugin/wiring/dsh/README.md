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

## Which DSH it was verified against

`package.json` records the version whose surface this bundle's rows were walked
against, as `dsh.verifiedAgainst`. That field is the record's one home — the
patch banner and the install output are both rendered from it — and it moves
only when a person re-checks the surface map against a new DSH, never on a
plugin release.

The generator compares the record with `dsh --version` and prints both, naming
[the GA re-verification ticket](https://github.com/dhague/wiki-knowledge/issues/536)
when they differ. **It never refuses.** DSH is pre-GA and ships often, so a hard
gate would turn every DSH patch release into a failed install; a mismatch is a
signpost, not a verdict. Pass `--dsh-version` when you know better than
`dsh --version` does — the generator deliberately reads the CLI rather than a
profile, since it knows nothing about profiles and every profile it could name
resolves its packages differently.

Re-running the generator is also the check-later path: it needs no new verb, and
`enchiridion check` stays a vault check rather than gaining a host concern.

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
matching a disabled row does nothing.

Each subagent row carries `provider: spawn`, the agent's own name as its
model-facing `toolName`, `toolFilter.allow` translated from the canonical
`agents/*.md` `tools:` line onto DSH's global tool names, a `persona` built from
the agent body, and `maxDepth: 1` so a wiki subagent delegates no further. All
three default to the `deepseek-flash` route.

## What it does not carry: the hooks

No hooks row, deliberately (#534). Both of the plugin's Claude Code hooks have a
DSH answer that does not need one:

- **`SessionStart`** existed only to record a session's `transcript_path` for
  `/save-conversation`. The `dsh-hooks-claude-code` bridge hardcodes
  `transcript_path: ""`, so the handler would be a silent no-op — and DSH
  derives the path from `$DSH_SESSION_ID` instead of recording it, so nothing
  needs the record.
- **`PostToolUse`** existed only to append the plugin's tool-call log (#100),
  which is deliberately not ported: DSH keeps its own session log.

So a DSH session has **no tool-call log**. `enchiridion tool-call-stats` has
nothing to summarise: its default form fails for want of
`$CLAUDE_CODE_SESSION_ID`, which DSH does not set, and `--session-id` still
looks under Claude Code's state tree, which DSH never writes. `enchiridion
ingest` prints no post-commit cost summary, its documented behaviour when no log
exists — the SHA stays the first line of its stdout either way.

DSH's equivalent is its own session log,
`$DSH_HOME/sessions/<projectKey>/<session-id>/session.v<N>.jsonl[.zstd]` — the
same artifact `/save-conversation` decodes, carrying `tool/call` and
`tool/result` records (measured: 23 calls and 22 results in one 101-record
session). It is not a drop-in for the #100 log: it is a multi-frame zstd store,
and a `tool/call` record carries turn, step, tool name and arguments rather than
the Claude Code payload's `duration_ms`.

## What is committed, and why

`package.json` and this README. Nothing else. The manifest is committed source
and is never rewritten by tooling — the generator only reads it, including the
`dsh.verifiedAgainst` record, which a person edits when they re-verify.

`cordis.patch.yml` is **generated and gitignored**, because it bakes in the
absolute plugin root — `customSkillDirs` is resolved against the DSH boot cwd,
so a relative value is not an option, and a committed patch would be wrong on
every machine but the one that generated it.

Because the committed manifest carries no plugin-derived value — only the
declared patch path and the verified-against record — the bundle adds nothing to
`scripts/release.sh` and nothing to CI's freshness guard. Moving the plugin
checkout invalidates the baked path: re-run the generator and re-add the bundle
from the new location.
