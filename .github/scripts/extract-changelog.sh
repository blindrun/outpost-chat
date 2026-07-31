#!/usr/bin/env bash
# Prints just the bullet section for one version out of CHANGELOG.md, e.g.
# `extract-changelog.sh v0.2.8` prints everything between the "## v0.2.8 —
# ..." header and the next "## " header. Used by desktop.yml to give each
# GitHub Release real notes instead of an empty body.
set -euo pipefail
version="${1#v}"
awk -v ver="v${version}" '
  /^## / {
    if (matched) exit
    split($0, a, " ")
    if (a[2] == ver) { matched=1; next }
    next
  }
  matched { print }
' CHANGELOG.md
