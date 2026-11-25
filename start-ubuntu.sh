#!/bin/bash
# Mezuzah Checker - PC program (Ubuntu). Keep this window open while you want the phone to sync.
cd "$(dirname "$0")"
command -v node >/dev/null || { echo "Please install Node.js first:  sudo apt install nodejs"; exit 1; }
command -v tailscale >/dev/null && tailscale serve --bg 8080 >/dev/null 2>&1
(sleep 2; xdg-open http://localhost:8080/pc.html >/dev/null 2>&1) &
node pc/server.js --port 8080
