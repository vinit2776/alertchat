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

# Railway injects PORT env var — Express binds 0.0.0.0 by default
EXPOSE 4001

CMD ["./start.sh"]
