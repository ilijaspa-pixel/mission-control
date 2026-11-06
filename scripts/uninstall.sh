#!/usr/bin/env bash
# Removes the Mission Control background service and Dock app. Leaves your Claude Code sessions alone.
LABEL="com.$(whoami).mission-control"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
rm -rf "$HOME/Applications/Mission Control.app"
echo "Removed. To undo the Claude Code settings change, restore ~/.claude/settings.json.before-mission-control"
