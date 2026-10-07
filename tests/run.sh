#!/bin/sh
# Run all tests: JS unit tests (macOS JavaScriptCore if present, else Node),
# then the helper server's Python tests. Fails if either fails.
DIR=$(cd "$(dirname "$0")" && pwd)
JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc
status=0
if [ -x "$JSC" ]; then
  "$JSC" -m "$DIR/jsc-main.js" || status=1
else
  node "$DIR/node-main.mjs" || status=1
fi
if command -v python3 >/dev/null 2>&1; then
  python3 -m unittest discover -s "$DIR" -p 'test_*.py' || status=1
else
  echo "python3 not found: skipped server tests"
fi
exit $status
