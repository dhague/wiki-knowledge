# AGENTS.md

Host- and environment-specific operating notes for this repo. The project's own
instructions live in [CLAUDE.md](CLAUDE.md) — read that first; this file carries
only what it leaves out.

## DeepSeek Harness environment

**Scope: DeepSeek Harness (DSH) sessions only.** These constraints come from the
harness, not the repo, so a Claude Code or OpenCode session can ignore this
section.

- **Create worktrees inside the checkout** — `git worktree add .claude/worktrees/<name>` — because DSH's file sandbox is rooted at the checkout and a sibling directory (`../enchiridion-455`) is denied. Remove one with `git worktree remove --force`: the untracked `node_modules` it holds makes the plain form refuse.
- **Run `npm ci` in each new worktree** before touching the TypeScript gate. Worktrees share `.git` but get no `node_modules`, and there is no hoisting to fall back on.
- **A release worktree also needs `wiki-plugin/.venv`, which no fresh worktree has.** `scripts/release.sh` hard-errors at its OpenCode-package step without it (the assembly imports `ruamel.yaml`), and the venv is gitignored — the same gap as `node_modules`, one directory over. Symlink the main checkout's in: `ln -s "$PWD/wiki-plugin/.venv" .claude/worktrees/<name>/wiki-plugin/.venv`. Python resolves `sys.prefix` through the symlink to the real venv, so the import works. **Delete that symlink by hand before `git worktree remove --force`**, rather than leaving `rm -rf` to decide whether it traverses into the real venv.
- **Read `npm test`'s skip count before its failures.** `cli.run` and `cli.smoke` skip ~28 tests until `npm run build` has produced `dist/cli.cjs`, so the healthy baseline without a bundle is 882 tests / 854 pass / 0 fail / 28 skipped. With one built, the OpenCode `save-session` test fails on this machine — `opencode` is on PATH but cannot write `~/.local/share/opencode/log/`.
- **Falsify a suspicious failure before reporting it**: `git stash`, `npm run build`, rerun, `git stash pop`. `dist/` is gitignored, so a stash leaves the bundle in place and only the rebuild makes the comparison mean anything. That is how the `save-session` failure above was shown to predate its branch.
- **Write long `gh` bodies to a file and pass `--body-file`.** `--body "$(cat <<'EOF' …)"` breaks on backticks, which open a nested command substitution inside `$()`. `gh` also resolves this remote to `dhague/wiki-knowledge` while its URL still reads `dhague/enchiridion`.
- **Point the tool caches inside the workspace.** `gh run view --log` and `gh api …/logs` die on `creating cache entry: open ~/.cache/gh/…: operation not permitted`, and `npm view` dies writing `~/.npm/_logs` — both directories sit outside the sandbox. Prefix `gh` with `XDG_CACHE_HOME="$PWD/temp/<dir>"` and pass `npm` a `--cache temp/<dir>`. `temp/` is gitignored, so both stay out of `git status`; delete them when you're done all the same. The `gh api` variant also needs `--allow-escape-sequences`, as runner logs carry ANSI escapes.

## Repo gotchas

- **A `src/`-only PR leaves the committed bundle alone.** CI's freshness guard runs only when `wiki-plugin/.claude-plugin/plugin.json`'s version changes; `scripts/release.sh` refreshes `wiki-plugin/scripts/` and `skills/*/scripts/` at release time.
- **Deletions stage through `Manifest.deleted`**, which joins created and updated refs in one `VaultGit.add(paths)` call: a path missing from disk but tracked at HEAD becomes a removal, while one git has never tracked stays a hard error.
- **A new `IngestPlan` feature lands in two places** — `ingest.ts`'s module comment (the schema's only spec) and `wiki-ingest/SKILL.md` step 4 (the agent-facing shape). No JSON schema file exists.
- **Extending the property tests in `wikipage.test.ts`**: `genVaultArb` guarantees its first page sits in a kind-folder and is never the one moved, so the YAML oracle always has a page to read. A generator that drops that guarantee makes the `oracleReadAFold` assertion vacuous and the second oracle silently stops guarding (#489).
- **A wayfinder ticket closes once its PR is pushed**, not at merge; the worktree, local branch and remote branch are cleaned up after the user confirms the merge.
- **A PR merged in the browser leaves the local checkout stale**, so `git fetch` and `git merge --ff-only origin/main` before reading a version out of the working tree. Otherwise `plugin.json` and `opencode-npm/package.json` still hold the pre-release version and a working-tree read looks like a release that never happened; `git show origin/main:<path>` answers when you only need one value.
- **`scripts/release.sh` is idempotent for the same version**, so re-running it after a mid-script failure re-applies an identical bump, rebuilds and re-copies rather than double-bumping. That is what recovers the missing-venv failure above.
- **Registry lag defeats `tag-release.yml`'s publish idempotency, so a re-run too soon looks like a fresh publish.** The step skips only when `npm show "@dhague/wiki-knowledge@$VERSION"` returns the version, but a just-published version takes a couple of minutes to appear — npm prints "being processed and may take a few minutes" — so inside that window the lookup 404s and the re-run attempts a second publish, which fails on the duplicate. Let the version appear on `https://registry.npmjs.org/@dhague%2Fwiki-knowledge` before re-running the workflow; the package doc's `last-modified` header is the quickest read on whether a publish has landed.
