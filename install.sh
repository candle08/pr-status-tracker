#!/bin/zsh
# Installs a launchd agent so the tracker runs in the background and starts at login.
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
NODE="$(command -v node)"
GH_DIR="$(dirname "$(command -v gh)")"
PLIST="$HOME/Library/LaunchAgents/com.local.pr-status-tracker.plist"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.local.pr-status-tracker</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$DIR/server.mjs</string></array>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>$GH_DIR:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DIR/tracker.log</string>
  <key>StandardErrorPath</key><string>$DIR/tracker.log</string>
</dict></plist>
PL
launchctl bootout gui/$(id -u) "$PLIST" 2>/dev/null || true
launchctl bootstrap gui/$(id -u) "$PLIST"
echo "Installed. Dashboard: http://localhost:4777  (logs: $DIR/tracker.log)"
