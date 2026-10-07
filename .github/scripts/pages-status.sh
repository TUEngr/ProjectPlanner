#!/usr/bin/env bash
# Decide whether this repository can deploy to GitHub Pages from Actions, and say so
# through the step output `enabled`. It never fails the run just because Pages is
# not switched on yet: it leaves a notice that says what to do instead.
#
# Needs GH_TOKEN and GITHUB_REPOSITORY (both set by the workflow).
set -u
out="${GITHUB_OUTPUT:-/dev/stdout}"
repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is not set}"

err=$(mktemp)
if build_type=$(gh api "repos/$repo/pages" --jq '.build_type' 2>"$err"); then
  if [ "$build_type" = "workflow" ]; then
    echo "enabled=true" >> "$out"
  else
    echo "::notice title=GitHub Pages source is not GitHub Actions::Pages is set to deploy from a branch ($build_type). In Settings > Pages, set Source to GitHub Actions to publish this site."
    echo "enabled=false" >> "$out"
  fi
elif grep -qiE '404|not found' "$err"; then
  echo "::notice title=GitHub Pages is not enabled yet::To publish this site, go to Settings > Pages and set Source to GitHub Actions. Then open the Actions tab, choose Publish site and click Run workflow."
  echo "enabled=false" >> "$out"
else
  # Could not tell (permissions, network). Try to deploy; a real problem will show there.
  echo "::warning title=Could not check GitHub Pages::$(tr '\n' ' ' < "$err")"
  echo "enabled=true" >> "$out"
fi
rm -f "$err"
