# ── Alert Automation Service ────────────────────────────────────────────────
# Playwright requires a full Linux environment with Chromium system deps.
# node:20-bookworm-slim + playwright install is the lightest correct base.

FROM node:20-bookworm-slim

WORKDIR /app

# ── Install dependencies (layer-cached before source copy) ─────────────────
COPY package*.json ./
RUN npm ci

# ── Install Chromium + all OS dependencies (libnss3, libgbm, etc.) ─────────
# --with-deps handles the apt-get install automatically
RUN npx playwright install chromium --with-deps

# ── Build TypeScript ────────────────────────────────────────────────────────
# COPY . . already includes start.sh — no separate COPY needed
COPY . .
RUN chmod +x start.sh && npm run build

# ── Copy non-TS assets that tsc doesn't move into dist ─────────────────────
# Migration SQL files + portal playbooks/profiles need to live next to dist
# at runtime since both are read via path.join(__dirname, ...).
RUN mkdir -p dist/db/migrations dist/portal/playbooks dist/portal/profiles && \
    cp -r src/db/migrations/* dist/db/migrations/ && \
    cp -r src/portal/playbooks/* dist/portal/playbooks/ && \
    cp -r src/portal/profiles/*  dist/portal/profiles/ 2>/dev/null || true

# Railway injects PORT env var — Express binds 0.0.0.0 by default
EXPOSE 4001

CMD ["./start.sh"]
