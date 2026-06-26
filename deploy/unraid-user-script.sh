#!/bin/bash
# actual-starling — Unraid User Scripts entry.
#
# Setup (one-time):
#   1. Put the repo somewhere on the array, e.g.:
#        /mnt/user/appdata/actual-starling
#      (git clone there, then `npm install` inside it).
#   2. Create .env in that dir (copy from .env.example, fill in).
#   3. Install the "User Scripts" plugin (Community Apps).
#   4. Add New Script -> name it "actual-starling" -> Edit Script ->
#      paste this file's contents.
#   5. Set schedule to "Scheduled Daily" (or a custom cron, e.g. 0 3 * * *).
#
# Notes:
#   - This shells INTO the Actual server container is NOT required. This runs
#     node on the Unraid host. Unraid ships no node by default, so this script
#     runs node inside a throwaway official node container pointed at the repo
#     dir. No node install on the host needed.
#   - Adjust APP_DIR if you cloned elsewhere.

APP_DIR="/mnt/user/appdata/actual-starling"
NODE_IMAGE="node:20-alpine"

if [ ! -f "${APP_DIR}/.env" ]; then
  echo "ERROR: ${APP_DIR}/.env not found. Create it from .env.example first."
  exit 1
fi

# Install deps inside the SAME image the importer runs in, so any binaries
# match. Only runs the first time (or after you delete node_modules).
if [ ! -d "${APP_DIR}/node_modules" ]; then
  echo "[actual-starling] $(date) node_modules missing — running npm install"
  docker run --rm -v "${APP_DIR}:/app" -w /app "${NODE_IMAGE}" \
    npm install --omit=dev
fi

echo "[actual-starling] $(date) starting import"

# Run the importer inside an ephemeral node container.
# - mounts the repo dir (code, .env, .actual-cache, node_modules) read-write
# - --rm cleans up the container after each run
docker run --rm \
  -v "${APP_DIR}:/app" \
  -w /app \
  "${NODE_IMAGE}" \
  node index.mjs import

echo "[actual-starling] $(date) import finished (exit $?)"
