#!/bin/sh
set -e

echo "[startup] Running database migrations…"
node dist/db/migrate.js

echo "[startup] Starting server on port ${PORT:-4001}…"
exec node dist/index.js
