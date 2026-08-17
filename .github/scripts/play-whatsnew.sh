#!/usr/bin/env bash
# Builds the Play Console "what's new" file for one version.
#
#   play-whatsnew.sh v0.6.3 distribution/whatsnew
#
# Why this exists: the publish step never passed release notes to Play, so
# every Play release from the first one onward has shipped with none. Testers
# got an update with no indication of what changed. `release-notes.md` was
# already being generated next to it, but only ever fed to the GitHub release.
#
# Play is stricter than GitHub about this text in two ways, which is why the
# GitHub body cannot just be reused:
#
#   - a hard 500-character cap per locale, and the API rejects the whole edit
#     if it is exceeded rather than truncating for you
#   - plain text only, so markdown bold markers would render literally, the
#     same way they do in the app's own message renderer
set -euo pipefail

version="${1:?usage: play-whatsnew.sh <version> <outdir>}"
outdir="${2:?usage: play-whatsnew.sh <version> <outdir>}"
version="${version#v}"
LIMIT=500

here="$(cd "$(dirname "$0")" && pwd)"
notes="$(bash "$here/extract-changelog.sh" "v${version}")"

if [ -z "${notes//[[:space:]]/}" ]; then
  echo "no changelog section found for v${version}" >&2
  exit 1
fi

# Markdown to plain text: drop bold markers, normalise bullets, collapse the
# blank lines the markdown uses for spacing.
plain="$(printf '%s\n' "$notes" \
  | sed -e 's/\*\*//g' -e 's/^[[:space:]]*-[[:space:]]/* /' \
  | awk 'NF { print }')"

# Reserve one character for the trailing newline that Play counts too.
budget=$((LIMIT - 1))
if [ "${#plain}" -gt "$budget" ]; then
  cut="${plain:0:$((budget - 3))}"
  cut="${cut% *}"          # never split a word
  plain="${cut}..."
fi

mkdir -p "$outdir"
printf '%s\n' "$plain" > "$outdir/whatsnew-en-US"

# Fail loudly rather than let the publish step discover it. A silent overrun
# would fail the whole edit, after the AAB had already uploaded.
chars=$(wc -m < "$outdir/whatsnew-en-US")
if [ "$chars" -gt "$LIMIT" ]; then
  echo "whatsnew-en-US is $chars characters, over Play's $LIMIT cap" >&2
  exit 1
fi
echo "wrote $outdir/whatsnew-en-US ($chars characters)"
