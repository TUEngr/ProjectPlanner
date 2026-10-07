#!/usr/bin/env bash
# Assemble the files published to GitHub Pages into <outdir>.
#
#   build-site.sh <outdir>
#
# Always published: index.html, css/, js/ (the app, which runs in the visitor's browser).
# NEVER published unless asked: the plan itself. Set PUBLISH_PLAN=true (the repository
# variable of that name, in the workflow) to include data/bundle.json. A Pages site is
# public on the internet, even when the repository is private.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
out=${1:?usage: build-site.sh <outdir>}

rm -rf "$out"
mkdir -p "$out"
cp "$root/index.html" "$out/index.html"
cp -r "$root/css" "$root/js" "$out/"
touch "$out/.nojekyll"

# Let the page know which repository it belongs to (for its header link and the
# "open in Codespaces" link). Only a plain owner/name is accepted.
# (GitHub owners are letters, digits and hyphens; a repository name is letters, digits,
# `.`, `_` and `-`, and is never `.` or `..`.)
repo_name=${GITHUB_REPOSITORY:-}; repo_name=${repo_name#*/}
if [[ "${GITHUB_REPOSITORY:-}" =~ ^[A-Za-z0-9][A-Za-z0-9-]*/[A-Za-z0-9._-]+$ && "$repo_name" != "." && "$repo_name" != ".." ]]; then
  sed -i "s#</head>#  <meta name=\"pp-repo\" content=\"${GITHUB_REPOSITORY}\">\n</head>#" "$out/index.html"
fi

if [ "${PUBLISH_PLAN:-}" = "true" ]; then
  rc=0
  python3 "$root/.github/scripts/bundle-plan.py" "$root" "$out/data/bundle.json" || rc=$?
  if [ "$rc" = 3 ]; then
    echo "::warning title=No plan to publish::PUBLISH_PLAN is true but the repository has no data/plan.json yet. Publishing the app only."
  elif [ "$rc" != 0 ]; then
    exit "$rc"
  else
    # Tell the page there is a bundle to show, so it never has to probe for one.
    sed -i 's#</head>#  <meta name="pp-bundle" content="data/bundle.json">\n</head>#' "$out/index.html"
    echo "::notice title=Plan data is public::The project plan was published to the Pages site. Anyone with the link can read it."
  fi
else
  echo "Plan data was NOT published. To publish a read-only view of the plan, set the repository variable PUBLISH_PLAN to true."
fi
