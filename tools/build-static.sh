#!/usr/bin/env bash
# Build the static edition of Orion OS (e.g. for GitHub Pages).
#
#     ./tools/build-static.sh [OUT_DIR]      # default: _site
#
# The frontend is already plain HTML/CSS/ES modules, so "building" is:
#   1. copy static/ as-is;
#   2. publish the creator catalogues (content/*.json) next to it, which the
#      frontend reads when there is no server (api.content fallback);
#   3. mark the page as the static edition (<meta name="orion-edition">), so
#      it never calls /api or /ws and says honestly that server features are
#      unavailable;
#   4. verify the result: required files present, nothing server-side or
#      secret included.
# Deterministic: no network, no package installs, no timestamps.
set -euo pipefail

OUT="${1:-_site}"
cd "$(dirname "$0")/.."

rm -rf "$OUT"
mkdir -p "$OUT/content"
cp -R static/. "$OUT/"
for kind in games music youtube wallpapers; do
  cp "content/$kind.json" "$OUT/content/$kind.json"
done
touch "$OUT/.nojekyll" # serve files as-is (no Jekyll processing)

# Mark the edition (exactly one marker must exist and be switched).
[ "$(grep -c '<meta name="orion-edition" content="full" />' "$OUT/index.html")" = 1 ] \
  || { echo "build-static: edition marker not found in index.html" >&2; exit 1; }
sed -i.bak 's|<meta name="orion-edition" content="full" />|<meta name="orion-edition" content="static" />|' "$OUT/index.html"
rm -f "$OUT/index.html.bak"

# ── Checks ──
fail() { echo "build-static: $*" >&2; exit 1; }
for f in index.html js/app.js js/core/api.js css/system/tokens.css apps.json catalog.json content/games.json; do
  [ -f "$OUT/$f" ] || fail "missing $f"
done
grep -q '<meta name="orion-edition" content="static" />' "$OUT/index.html" || fail "edition not marked static"
# Only frontend files: nothing from the server, deployment or data directories.
for d in src deploy data target .github tests docs; do
  [ ! -e "$OUT/$d" ] || fail "unexpected $d/ in the static build"
done
# No secrets or private material.
if grep -rIlE 'BEGIN ([A-Z]+ )?PRIVATE KEY|ghp_[A-Za-z0-9]{20,}|github_pat_|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|LTF_ACCESS_KEY=' "$OUT"; then
  fail "possible secret found (see files above)"
fi
if find "$OUT" \( -name '*.pem' -o -name '*.key' -o -name '*.env' -o -name 'access-key' \) | grep -q .; then
  fail "key/env file in the static build"
fi

echo "static edition built in $OUT ($(find "$OUT" -type f | wc -l | tr -d ' ') files, $(du -sh "$OUT" | cut -f1))"
