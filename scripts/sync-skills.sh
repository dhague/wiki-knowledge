#!/usr/bin/env bash
#
# Keep repo-root skills/ identical to the canonical tree at wiki-plugin/skills/.
#
# Usage:  scripts/sync-skills.sh          regenerate the mirror
#         scripts/sync-skills.sh --check  exit non-zero if the trees differ
#
# wiki-plugin/skills/ is the hand-edited canonical tree; repo-root skills/ is
# the generated copy `npx skills add` installs from. Any edit to the canonical
# tree needs the mirror regenerated in the same PR — the skills-freshness CI job
# runs `--check` on every PR to enforce that.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

canonical="wiki-plugin/skills"
mirror="skills"

if [ ! -d "$canonical" ]; then
  echo "error: $canonical is missing; refusing to touch $mirror" >&2
  exit 1
fi

case "${1:-}" in
  --check)
    if diff -r "$canonical" "$mirror"; then
      echo "$mirror/ matches $canonical/"
    else
      echo "" >&2
      echo "STALE: repo-root $mirror/ differs from $canonical/." >&2
      echo "Regenerate it with: scripts/sync-skills.sh" >&2
      exit 1
    fi
    ;;
  "")
    rm -rf "$mirror"
    cp -R "$canonical" "$mirror"
    echo "Regenerated $mirror/ from $canonical/."
    ;;
  *)
    echo "usage: $0 [--check]" >&2
    exit 1
    ;;
esac
