#!/bin/sh
# Renders header.html to header.png at 2x with Playwright's Chromium.
# Run from anywhere: sh docs/header/render.sh
set -eu
dir=$(cd "$(dirname "$0")" && pwd)
npx -y playwright@1.64.1 install chromium >/dev/null
npx -y playwright@1.64.1 screenshot \
  --viewport-size "2560,1200" \
  --wait-for-selector "body.ready" \
  "file://$dir/header.html?scale=2" \
  "$dir/header.png"
