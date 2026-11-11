#!/usr/bin/env bash
# Build ~/Applications/Second Brain.app from main.swift with swiftc (no Xcode project needed).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
APP="${1:-$HOME/Applications/Second Brain.app}"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>Second Brain</string>
  <key>CFBundleDisplayName</key><string>Second Brain</string>
  <key>CFBundleIdentifier</key><string>com.local.secondbrain</string>
  <key>CFBundleVersion</key><string>0.1.0</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleExecutable</key><string>SecondBrain</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
printf '%s\n' "$REPO" > "$APP/Contents/Resources/repo-path"
swiftc -O -o "$APP/Contents/MacOS/SecondBrain" "$HERE/main.swift" -framework Cocoa -framework WebKit -framework Network
echo "built $APP (repo: $REPO)"
