#!/usr/bin/env bash
# Build ~/Applications/J.A.R.V.I.S.app from main.swift with swiftc (no Xcode project needed).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
APP="${1:-$HOME/Applications/J.A.R.V.I.S.app}"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>J.A.R.V.I.S.</string>
  <key>CFBundleDisplayName</key><string>J.A.R.V.I.S.</string>
  <key>CFBundleIdentifier</key><string>com.local.jarvis</string>
  <key>CFBundleVersion</key><string>0.1.0</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>CFBundleExecutable</key><string>Jarvis</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict></plist>
PLIST
printf '%s\n' "$REPO" > "$APP/Contents/Resources/repo-path"
swiftc -O -o "$APP/Contents/MacOS/Jarvis" "$HERE/main.swift" -framework Cocoa -framework WebKit -framework Network
echo "built $APP (repo: $REPO)"
