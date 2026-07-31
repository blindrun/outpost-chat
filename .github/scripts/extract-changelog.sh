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
    found = 0
    n = split($0, a, " ")
    for (i = 1; i <= n; i++) if (a[i] == ver) found = 1
    if (found) { matched = 1; next }
    next
  }
  matched { print }
' CHANGELOG.md
