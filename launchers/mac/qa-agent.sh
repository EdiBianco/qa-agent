#!/bin/bash
# QA Agent.app entry point. Becomes a Dock app (icon + Quit) that runs the server;
# quitting it stops the server. `exec` keeps this process as the app registered with the Dock.
RES="$(cd "$(dirname "$0")/../Resources" && pwd)"
REPO="$(cat "$RES/repo_path")"
NODE="$(cat "$RES/node_path")"
export PORT="$(cat "$RES/port" 2>/dev/null || echo 4747)"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

exec /usr/bin/osascript -l JavaScript "$RES/dock.js" "http://localhost:$PORT" "$RES/AppIcon.icns" "$NODE" "$REPO"
