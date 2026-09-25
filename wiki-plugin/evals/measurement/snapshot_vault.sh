#!/usr/bin/env bash
# Copy the dogfooding vault into a throwaway temp dir and reindex it, so
# measurement runs never touch the real vault.
#
# Usage: snapshot_vault.sh [source_vault_root]   (default $WIKI_ROOT)
# Prints the snapshot's path on stdout and nothing else.
set -euo pipefail

SRC="${1:-${WIKI_ROOT:-}}"
if [ -z "$SRC" ]; then
    echo "usage: snapshot_vault.sh [source_vault_root]  (or set \$WIKI_ROOT)" >&2
    exit 1
fi
if [ ! -d "$SRC/wiki" ]; then
    echo "not a vault root (no wiki/ dir): $SRC" >&2
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="$(mktemp -d -t wiki-vault-snapshot-XXXXXX)"

cp -r "$SRC/." "$DEST/"
WIKI_ROOT="$DEST" "$SCRIPT_DIR/../../bin/enchiridion" search --reindex --full >&2

echo "$DEST"
