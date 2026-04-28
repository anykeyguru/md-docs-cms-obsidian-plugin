#!/bin/bash
# Build a clean, install-ready zip of the plugin runtime files.
# Drop the resulting zip into another vault's `.obsidian/plugins/docs-cms/`
# (extract first), or share it.
#
# Usage:
#   ./package.sh             # build + zip with current version
#   ./package.sh --no-build  # skip npm run build, package whatever main.js exists
set -e
cd "$(dirname "$0")"

if [[ "$1" != "--no-build" ]]; then
    echo "▸ npm run build"
    npm run build
fi

VERSION=$(grep -m1 '"version"' manifest.json | sed 's/.*"version": *"\([^"]*\)".*/\1/')
[[ -z "$VERSION" ]] && { echo "Could not read version from manifest.json"; exit 1; }

mkdir -p dist
ARTIFACT="dist/docs-cms-${VERSION}.zip"
rm -f "$ARTIFACT"

# Only files Obsidian needs at runtime + the README/help.
zip -j "$ARTIFACT" \
    manifest.json \
    main.js \
    styles.css \
    versions.json \
    README.md

echo ""
echo "▸ created $ARTIFACT"
echo ""
echo "Install in another vault:"
echo "  1. mkdir -p '/path/to/vault/.obsidian/plugins/docs-cms'"
echo "  2. unzip -o $ARTIFACT -d '/path/to/vault/.obsidian/plugins/docs-cms/'"
echo "  3. In Obsidian: Settings → Community plugins → Reload → enable Docs CMS"
