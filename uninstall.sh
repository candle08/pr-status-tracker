#!/bin/zsh
PLIST="$HOME/Library/LaunchAgents/com.local.pr-status-tracker.plist"
launchctl bootout gui/$(id -u) "$PLIST" 2>/dev/null; rm -f "$PLIST"; echo "Uninstalled."
