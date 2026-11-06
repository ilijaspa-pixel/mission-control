#!/bin/bash
# Claude Code "Notification" hook.
# Fires when a session is blocked on the user (permission prompt, question,
# idle input). Two outputs, because either one alone gets missed:
#   1. Mission Control (localhost:4100) — flags the tile red so you can see
#      WHICH console is stuck without opening it.
#   2. macOS banner + sound — for when the dashboard isn't on screen.

payload=$(cat)

msg=$(printf '%s' "$payload" | jq -r '.message // empty')
[ -z "$msg" ] && msg="Waiting for your input"

cwd=$(printf '%s' "$payload" | jq -r '.cwd // empty')
[ -z "$cwd" ] && cwd="$PWD"
proj=$(basename "$cwd")

# Mission Control. Forward the payload verbatim; the route matches on
# session_id (or cwd) and no-ops if this session isn't hub-owned.
# Never let a down dashboard break the hook.
printf '%s' "$payload" \
  | curl -s -m 2 -X POST http://127.0.0.1:4100/api/attention \
      -H 'Content-Type: application/json' --data-binary @- >/dev/null 2>&1 &

# Distinct from the Glass sound used by Stop/TaskCompleted, so "needs you"
# never sounds like "finished".
afplay /System/Library/Sounds/Funk.aiff &

# argv form avoids quoting bugs when the message contains quotes or backslashes.
osascript - "$msg" "Claude · $proj" <<'APPLESCRIPT' >/dev/null 2>&1
on run argv
  display notification (item 1 of argv) with title (item 2 of argv) subtitle "waiting for you" sound name "Funk"
end run
APPLESCRIPT

exit 0
