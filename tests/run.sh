#!/bin/sh
# Run scheduler unit tests with macOS's built-in JavaScriptCore (no Node needed).
JSC=/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc
DIR=$(cd "$(dirname "$0")" && pwd)
exec "$JSC" -m "$DIR/jsc-main.js"
