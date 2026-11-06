#!/usr/bin/env bash
# Builds ~/Applications/Mission Control.app — a real macOS .app bundle that,
# when double-clicked, boots the claude-session-browser dev server (if it
# isn't already running) and opens a chromeless Chrome window at
# http://localhost:4100. Gives you a dock icon, Cmd-Tab app switching, and a
# window with no URL bar.
#
# Re-run this script any time you want to rebuild the .app (e.g. after
# changing the port or the source folder).

set -euo pipefail

REPO_DIR="${REPO_DIR:-$(cd "$(dirname "$0")/.." && pwd)}"
NPM_BIN="${NPM_BIN:-$(command -v npm)}"
APP_NAME="Mission Control"
APP_PATH="$HOME/Applications/${APP_NAME}.app"
PORT="4100"
URL="http://localhost:${PORT}"

# Prefer a Chromium-family browser in this order. We use --app= mode which
# strips all browser chrome (no URL bar, no tabs, no extensions strip).
BROWSER_CANDIDATES=(
  "/Applications/Google Chrome.app"
  "/Applications/Arc.app"
  "/Applications/Brave Browser.app"
  "/Applications/Microsoft Edge.app"
  "/Applications/Chromium.app"
)

BROWSER=""
for b in "${BROWSER_CANDIDATES[@]}"; do
  if [ -d "$b" ]; then
    BROWSER="$b"
    break
  fi
done

if [ -z "$BROWSER" ]; then
  echo "No Chromium-family browser found (Chrome / Arc / Brave / Edge)." >&2
  exit 1
fi

BROWSER_NAME="$(basename "$BROWSER" .app)"
echo "• Using browser: $BROWSER_NAME"
echo "• Source repo: $REPO_DIR"
echo "• Output:      $APP_PATH"

mkdir -p "$HOME/Applications"
rm -rf "$APP_PATH"

# We invoke Chrome's binary directly (rather than `open -na`) because `open`
# with a running Chrome instance won't reliably spawn a new --app window. We
# also pass --user-data-dir to give Mission Control its own isolated Chrome
# profile — no shared extensions, tabs, or history with the user's main Chrome.
BROWSER_BINARY="${BROWSER}/Contents/MacOS/${BROWSER_NAME}"
USER_DATA_DIR="$HOME/Library/Application Support/Claude Session Browser"

# Compile an AppleScript into a real .app bundle using osacompile.
# The script:
#   1. Makes sure the dev server is running on $PORT (starts it detached if not).
#   2. Waits briefly for the server to come up.
#   3. Launches the browser binary in --app= mode with an isolated profile.
osacompile -o "$APP_PATH" <<APPLESCRIPT
on run
  set repoDir to "${REPO_DIR}"
  set targetPort to "${PORT}"
  set targetURL to "${URL}"
  set browserBin to "${BROWSER_BINARY}"
  set userDataDir to "${USER_DATA_DIR}"

  -- 1) Start the dev server if nothing is listening on the port
  try
    do shell script "lsof -ti:" & targetPort & " >/dev/null 2>&1"
  on error
    do shell script "cd " & quoted form of repoDir & " && nohup ${NPM_BIN} run dev > /tmp/claude-session-browser.log 2>&1 &"
    -- Wait up to ~8 seconds for the port to open
    repeat with i from 1 to 16
      try
        do shell script "lsof -ti:" & targetPort & " >/dev/null 2>&1"
        exit repeat
      on error
        delay 0.5
      end try
    end repeat
  end try

  -- 2) Launch the browser binary directly so --app= spawns its own window
  --    even when the main browser instance is already running.
  do shell script quoted form of browserBin & " --app=" & quoted form of targetURL & " --user-data-dir=" & quoted form of userDataDir & " --window-size=1520,960 --window-position=80,60 >/dev/null 2>&1 &"
end run
APPLESCRIPT

# Swap in a custom Mission Control icon if an icns file is present.
ICON_SRC="$REPO_DIR/assets/mission-control.icns"
if [ -f "$ICON_SRC" ]; then
  cp "$ICON_SRC" "$APP_PATH/Contents/Resources/applet.icns"
  touch "$APP_PATH"
fi

# Strip the quarantine flag so Gatekeeper doesn't prompt on first launch.
xattr -dr com.apple.quarantine "$APP_PATH" 2>/dev/null || true

# Make it obvious the app is new (so Launchpad picks it up).
touch "$APP_PATH"

echo ""
echo "✓ Built ${APP_NAME}.app"
echo ""
echo "  Open it once from Finder (~/Applications/${APP_NAME}.app)"
echo "  or run: open \"$APP_PATH\""
echo ""
echo "  Drag it to your Dock for one-click access."
