#!/usr/bin/env bash
# Mission Control installer (macOS). Run from the repo folder:  bash scripts/install.sh
# Optional: GROQ_API_KEY=gsk_... bash scripts/install.sh   (turns on voice input)
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PORT=4100
LABEL="com.$(whoami).mission-control"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/mission-control"

say() { printf "\n\033[1m%s\033[0m\n" "$*"; }

[ "$(uname)" = "Darwin" ] || { echo "Mission Control only runs on macOS."; exit 1; }

say "1/6 Checking requirements"
command -v node >/dev/null || { echo "Node.js is missing. Install it from https://nodejs.org (LTS) or: brew install node"; exit 1; }
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 20 ] || { echo "Node $NODE_MAJOR is too old; need 20 or newer."; exit 1; }
command -v claude >/dev/null || echo "Note: 'claude' (Claude Code CLI) not found on PATH. Mission Control shows Claude Code sessions, so install it too."
xcode-select -p >/dev/null 2>&1 || { echo "Xcode Command Line Tools are needed (for the terminal module). Running: xcode-select --install"; xcode-select --install || true; echo "Finish that install, then run this script again."; exit 1; }
command -v jq >/dev/null || echo "Note: 'jq' not found (brew install jq). Without it the 'needs you' alert shows a generic message."
NPM_BIN="$(command -v npm)"

say "2/6 Installing packages (takes a minute)"
cd "$REPO_DIR"
npm install --no-audit --no-fund

say "3/6 Settings"
if [ -n "${GROQ_API_KEY:-}" ]; then
  echo "GROQ_API_KEY=$GROQ_API_KEY" > .env.local
  echo "Voice input on."
else
  echo "Voice input off (no GROQ_API_KEY). Fine to skip."
fi

say "4/6 Claude Code status line + 'needs you' alert"
mkdir -p "$HOME/.claude/hooks"
cp extras/statusline.cjs "$HOME/.claude/statusline.cjs"
cp extras/notify-waiting.sh "$HOME/.claude/hooks/notify-waiting.sh"
chmod +x "$HOME/.claude/statusline.cjs" "$HOME/.claude/hooks/notify-waiting.sh"
node scripts/merge-settings.cjs

say "5/6 Start on login (background service)"
mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"
cat > "$PLIST" <<PL
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>WorkingDirectory</key><string>$REPO_DIR</string>
  <key>ProgramArguments</key><array><string>$NPM_BIN</string><string>run</string><string>dev</string></array>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$(dirname "$NPM_BIN"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key><string>$HOME</string>
    <key>NODE_ENV</key><string>development</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG_DIR/stdout.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/stderr.log</string>
</dict></plist>
PL
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"

say "6/6 Dock app"
REPO_DIR="$REPO_DIR" NPM_BIN="$NPM_BIN" bash scripts/build-mac-app.sh || echo "(Dock app skipped; use http://localhost:$PORT)"

printf "Waiting for Mission Control to start"
for i in $(seq 1 60); do
  curl -s -o /dev/null "http://localhost:$PORT" && break
  printf "."; sleep 2
done
echo
say "Done. Open http://localhost:$PORT  (or 'Mission Control' in ~/Applications)"
echo "Restart any open Claude Code windows so they pick up the status line and alert hook."
