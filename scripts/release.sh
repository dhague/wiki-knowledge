#!/usr/bin/env bash
#
# Cut a release: bump plugin.json, rebuild the bundle from source, commit the
# artifacts into wiki-plugin/scripts/ and every skill, regenerate the repo-root
# skills/ tree, and push so a PR can be opened/updated.
#
# Usage:  scripts/release.sh <new-version>
#   e.g.  scripts/release.sh 0.16.0
#
# plugin.json is the single source of truth for the version.
# wiki-plugin/skills/ is the canonical hand-edited tree; repo-root skills/ is a
# generated copy that `npx skills add` installs from. There is no npm package.
#
# Must run from the repo root on a PR branch (never main, which is protected).
# Do NOT tag or run `gh release create`: tag-release.yml derives the tag from
# plugin.json on merge to main and creates the GitHub Release itself.

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

# 1. Bump the version in plugin.json (what tag-release.yml reads).
jq --arg v "$new_version" '.version = $v' "$plugin_json" > "$plugin_json.tmp"
mv "$plugin_json.tmp" "$plugin_json"

# 1b. Keep CLAUDE.md's "Plugin version" line in sync. `-i.bak` + rm is the
#     portable spelling: BSD sed rejects a bare `-i` followed by the script.
sed -i.bak "s/\*\*Plugin version: \`[0-9]*\.[0-9]*\.[0-9]*\`\*\*/**Plugin version: \`$new_version\`**/" CLAUDE.md
rm -f CLAUDE.md.bak

# 2. Rebuild the bundle + wasm from source (fresh, no stale dist/).
(cd enchiridion-ts && npm ci && npm run build)

# 3. Copy the built artifacts into the shipped host path that
#    bin/enchiridion and hooks.json resolve.
cp enchiridion-ts/dist/cli.cjs wiki-plugin/scripts/cli.cjs
cp enchiridion-ts/dist/node-sqlite3-wasm.wasm wiki-plugin/scripts/node-sqlite3-wasm.wasm

# 4. Ship the bundle inside every skill, because the portable text resolves the
#    script from the skill's own base directory. The copies are byte-identical,
#    so git stores one blob.
for skill_dir in wiki-plugin/skills/*/; do
  mkdir -p "${skill_dir}scripts"
  cp enchiridion-ts/dist/cli.cjs "${skill_dir}scripts/enchiridion.cjs"
  cp enchiridion-ts/dist/node-sqlite3-wasm.wasm "${skill_dir}scripts/node-sqlite3-wasm.wasm"
done

# 5. Regenerate the distribution tree — repo-root skills/ is a verbatim copy of
#    the canonical tree, and is what `npx skills add` installs.
rm -rf skills
cp -R wiki-plugin/skills skills

# 6. Commit and push to the current branch.
git add "$plugin_json" CLAUDE.md wiki-plugin/scripts/cli.cjs wiki-plugin/scripts/node-sqlite3-wasm.wasm
# Whole-tree add: a removed skill has to stage as a deletion too.
git add -A -- wiki-plugin/skills skills
git commit -m "chore: release v$new_version (bundle + wasm + skills package)"
git push origin "$current_branch"

echo
echo "Pushed v$new_version on '$current_branch'. Open (or update) the PR; CI's"
echo "freshness jobs will re-verify the committed bundle and the generated"
echo "skills tree before merge. After merge, tag-release.yml tags the release,"
echo "creates the GitHub Release with the per-skill Joule ZIPs, and nothing else."
