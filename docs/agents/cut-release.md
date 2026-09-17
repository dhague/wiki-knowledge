# Cutting a release

A release is cut by a **human or agent running `scripts/release.sh` on a PR
branch**. CI takes over once that branch merges; nothing about a release is
done by hand on `main`.

**Never tag by hand, never run `gh release create`, never run `npm publish`.**
`tag-release.yml` derives all three from `plugin.json` when the version bump
lands on `main`. A tag has to point at the commit that carries the bumped
version, and only CI can guarantee it points at that commit rather than a
stale `main` — the v0.8.0 release raced exactly this way.

## Before you start

- A worktree on a PR branch off `main`. `main` is protected, so a push to it is
  rejected, and `scripts/release.sh` refuses to run there.
- `wiki-plugin/.venv` holding `ruamel.yaml` — the OpenCode package assembly
  imports it, and the script hard-errors without that interpreter.

## Procedure

1. Pick the new version. `wiki-plugin/.claude-plugin/plugin.json` is the single
   source of truth for it; every other artifact's version derives from that one.
2. From the repo root, run `scripts/release.sh <new-version>`. It bumps the
   version in `plugin.json` and in the *Current state* line of `CLAUDE.md`,
   rebuilds the bundle from source, commits the rebuilt artifacts alongside the
   bump, and pushes the branch. The version bump is part of that commit — open
   no separate PR for it.
3. Open the PR. CI's **freshness guard** (`ts-enchiridion.yml`) independently
   rebuilds and fails the PR if the committed bundle drifts from source, so a
   stale copy in the release commit cannot reach `main`.
4. Wait for the human to confirm the PR merged, then clean up the branch and
   worktree.

## What CI does after the merge

`tag-release.yml` fires on the `plugin.json` path change and, in one workflow:

- pushes the annotated tag `v<version>`, skipping if it already exists;
- creates the GitHub Release, attaching the per-skill ZIPs Joule Desktop
  installs;
- publishes `@dhague/wiki-knowledge` to npm via **Trusted Publishing (OIDC)**,
  skipping a version already published.

Three things hold that path open: the workflow's `id-token: write` permission,
npm CLI `>= 11.5.1` (the publish step self-upgrades, since Node 22 ships ~10.x),
and the package's Trusted Publisher configuration on npmjs.com naming this repo
and `tag-release.yml`. There is no separate `release.yml` — it was inlined into
`tag-release.yml`, because a fine-grained PAT cannot trigger a downstream
`on: push` workflow. Keep it that way rather than reaching for a manual
`gh release create`.
