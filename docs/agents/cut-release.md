# Cutting a release

A release is cut by a **human or agent running `scripts/release.sh` on a PR
branch**. CI takes over once that branch merges; nothing about a release is
done by hand on `main`.

**Never tag by hand, never run `gh release create`.** `tag-release.yml` derives
both from `plugin.json` when the version bump lands on `main`. A tag has to
point at the commit that carries the bumped version, and only CI can guarantee
it points at that commit rather than a stale `main` — the v0.8.0 release raced
exactly this way. There is no npm package any more, so there is nothing to
publish.

## Before you start

- A worktree on a PR branch off `main`. `main` is protected, so a push to it is
  rejected, and `scripts/release.sh` refuses to run there.

## Procedure

1. Pick the new version. `wiki-plugin/.claude-plugin/plugin.json` is the single
   source of truth for it.
2. From the repo root, run `scripts/release.sh <new-version>`. It bumps the
   version in `plugin.json` and in the *Current state* line of `CLAUDE.md`,
   rebuilds the bundle from source, copies it into `wiki-plugin/scripts/` and
   into every skill that calls it, regenerates repo-root `skills/` from
   `wiki-plugin/skills/`, commits all of it alongside the bump, and pushes the
   branch. The version bump is part of that commit — open no separate PR for it.
3. Open the PR. CI's **freshness jobs** (`ts-enchiridion.yml`) independently
   rebuild and fail the PR if the committed bundle drifts from source, and fail
   it if the generated `skills/` tree differs from the canonical one — so a
   stale copy in the release commit cannot reach `main`.
4. Wait for the human to confirm the PR merged, then clean up the branch and
   worktree.

## What CI does after the merge

`tag-release.yml` fires on the `plugin.json` path change and, in one workflow:

- pushes the annotated tag `v<version>`, skipping if it already exists;
- creates the GitHub Release, attaching one ZIP per public skill from the
  generated `skills/` tree — the archive Joule Desktop's "Install from file"
  consumes.

There is no separate `release.yml` — it was inlined into `tag-release.yml`,
because a fine-grained PAT cannot trigger a downstream `on: push` workflow.
Keep it that way rather than reaching for a manual `gh release create`.

The maintainer's own `cut-release` skill carries `metadata: internal: true`, so
the skills installer keeps it out of consumer installs; it lives in
`.claude/skills/`, outside both published trees, and is therefore never zipped
either.
