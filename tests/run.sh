#!/bin/sh
# Run the unit tests: macOS's built-in JavaScriptCore if present, else Node.
JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc
DIR=$(cd "$(dirname "$0")" && pwd)
if [ -x "$JSC" ]; then
  exec "$JSC" -m "$DIR/jsc-main.js"
fi
exec node "$DIR/node-main.mjs"
