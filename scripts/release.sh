#!/usr/bin/env bash
#
# Cut a release: bump the plugin version, rebuild the TypeScript bundle from
# source, commit the freshly-built artifacts into wiki-plugin/scripts/ and into
# every skill that calls them, regenerate the distribution tree at repo-root
# skills/, and push the release commit so a PR can be opened/updated.
#
# Usage:  scripts/release.sh <new-version>
#   e.g.  scripts/release.sh 0.16.0
#
# Version coupling: plugin.json is the single source of truth for the version.
# wiki-plugin/skills/ is the canonical, hand-edited skill tree; repo-root
# skills/ is a generated copy of it, and `npx skills add dhague/wiki-knowledge
# --all` installs from that copy. Nothing else is published — there is no npm
# package and no per-host installer.
#
# Must be run from the repo root, on a worktree/PR branch (never main, which
# is protected). Commits the version bump plus the regenerated artifacts, then
# pushes to the current branch's remote so a PR can be opened/updated. The
# freshness jobs in ts-enchiridion.yml then independently re-verify on the PR
# that the committed bundle equals a fresh build and that the generated tree
# equals the canonical one.
#
# Do NOT manually tag or run `gh release create`: tag-release.yml derives the
# tag from plugin.json on merge to main and creates the GitHub Release (with
# the per-skill Joule ZIPs) from it in the same workflow — a separate
# release.yml was inlined because a fine-grained PAT cannot trigger a
# downstream on:push workflow.

set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: $0 <new-version>" >&2
  echo "  e.g. $0 0.16.0" >&2
  exit 1
fi

new_version="$1"

if ! printf '%s' "$new_version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; then
  echo "error: '$new_version' is not a semantic version (X.Y.Z)" >&2
  exit 1
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

current_branch="$(git rev-parse --abbrev-ref HEAD)"
if [ "$current_branch" = "main" ]; then
  echo "error: refusing to run on main (protected). Work on a PR branch." >&2
  exit 1
fi

plugin_json="wiki-plugin/.claude-plugin/plugin.json"
current_version="$(jq -r .version "$plugin_json")"

echo "Cutting release $current_version -> $new_version on branch '$current_branch'"

# 1. Bump the version in plugin.json (the single source tag-release.yml reads).
jq --arg v "$new_version" '.version = $v' "$plugin_json" > "$plugin_json.tmp"
mv "$plugin_json.tmp" "$plugin_json"

# 1b. Patch the "Plugin version" line in CLAUDE.md so it stays in sync.
#     `-i.bak` then removing the backup is the portable spelling: BSD sed
#     (macOS) rejects a bare `-i` followed by the script, and aborts the
#     release after plugin.json has already been bumped.
sed -i.bak "s/\*\*Plugin version: \`[0-9]*\.[0-9]*\.[0-9]*\`\*\*/**Plugin version: \`$new_version\`**/" CLAUDE.md
rm -f CLAUDE.md.bak

# 2. Rebuild the bundle + wasm from source (fresh, no stale dist/).
(cd enchiridion-ts && npm ci && npm run build)

# 3. Copy the built artifacts into the shipped Claude Code host path, which
#    bin/enchiridion and hooks.json resolve.
cp enchiridion-ts/dist/cli.cjs wiki-plugin/scripts/cli.cjs
cp enchiridion-ts/dist/node-sqlite3-wasm.wasm wiki-plugin/scripts/node-sqlite3-wasm.wasm

# 4. Ship the bundle inside every skill. The portable text resolves the script
#    from the skill's own base directory, so each directory carries its own
#    copy — wiki-conventions included, even though it is the catalogue rather
#    than a caller: iterating the tree is uniform, and a skill added later
#    needs no list edited here. The copies are byte-identical, and git is
#    content-addressed, so the repository stores one blob however many skills
#    bundle it.
for skill_dir in wiki-plugin/skills/*/; do
  mkdir -p "${skill_dir}scripts"
  cp enchiridion-ts/dist/cli.cjs "${skill_dir}scripts/enchiridion.cjs"
  cp enchiridion-ts/dist/node-sqlite3-wasm.wasm "${skill_dir}scripts/node-sqlite3-wasm.wasm"
done

# 5. Regenerate the distribution tree. Repo-root skills/ is a verbatim copy of
#    the canonical wiki-plugin/skills/ tree; the skills CLI walks repo-root
#    skills/ first, so this copy is what `npx skills add` installs, and Joule
#    Desktop's per-skill ZIPs are built from it by tag-release.yml.
rm -rf skills
cp -R wiki-plugin/skills skills

# 6. Commit and push to the current branch's remote.
git add "$plugin_json" CLAUDE.md wiki-plugin/scripts/cli.cjs wiki-plugin/scripts/node-sqlite3-wasm.wasm
# Both skills trees are generated (one by hand into the other), so a whole-tree
# add is the point: a removed skill has to stage as a deletion too.
git add -A -- wiki-plugin/skills skills
git commit -m "chore: release v$new_version (bundle + wasm + skills package)"
git push origin "$current_branch"

echo
echo "Pushed v$new_version on '$current_branch'. Open (or update) the PR; CI's"
echo "freshness jobs will re-verify the committed bundle and the generated"
echo "skills tree before merge. After merge, tag-release.yml tags the release,"
echo "creates the GitHub Release with the per-skill Joule ZIPs, and nothing else."
