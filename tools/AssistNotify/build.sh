#!/usr/bin/env bash
# Build a tiny ad-hoc signed .app so macOS attributes notifications to "Assist"
# and clicking one opens the listing URL instead of Script Editor.
set -euo pipefail

DIR="$(cd "$(dirname "$0")" && pwd)"
APP="$DIR/build/AssistNotify.app"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS"

swiftc -O -swift-version 5 \
  -framework Cocoa \
  -framework UserNotifications \
  "$DIR/main.swift" \
  -o "$APP/Contents/MacOS/AssistNotify"

cp "$DIR/Info.plist" "$APP/Contents/Info.plist"
codesign --force --sign - "$APP" >/dev/null

echo "$APP"
