#!/bin/bash
# QA Agent launcher for Linux desktops. Starts the server, opens the browser, and keeps a small
# control (tray icon with yad, else a zenity window, else the terminal). Closing it stops the server.
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
NODE="${QA_NODE:-$(command -v node)}"
export PORT="${PORT:-4747}"
export PATH="$HOME/.local/bin:/usr/local/bin:$PATH"
URL="http://localhost:$PORT"
ICON="$REPO/assets/icon-256.png"

# --parent: if this script is killed outright, the helper stops the server by itself
"$NODE" "$REPO/bin/qa-agent.js" serve --open --parent $$ &
SRV=$!
# on exit: stop whatever server is on the port (also one that was already running), then the helper
trap '"$NODE" "$REPO/bin/qa-agent.js" stop >/dev/null 2>&1; kill "$SRV" 2>/dev/null; wait "$SRV" 2>/dev/null' EXIT TERM INT HUP

if command -v yad >/dev/null 2>&1; then
  yad --notification --image="$ICON" --text="QA Agent ($URL)" \
      --command="xdg-open $URL" --menu="Open QA Agent!xdg-open $URL|Quit (stops server)!quit"
elif command -v zenity >/dev/null 2>&1; then
  zenity --info --title="QA Agent" --window-icon="$ICON" --width=360 \
         --text="QA Agent is running at\n$URL\n\nClose this window to stop the server." --ok-label="Stop server"
else
  echo "QA Agent running at $URL. Press Ctrl+C to stop."
  wait "$SRV"
fi
