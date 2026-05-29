# ── Stage 1: Build ────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY . .

# VITE_ vars are inlined at build time — Railway passes this as a build arg
ARG VITE_AUTOMATION_URL
RUN VITE_AUTOMATION_URL=${VITE_AUTOMATION_URL} npm run build

# ── Stage 2: Serve ────────────────────────────────────────────────────────
FROM node:20-alpine

RUN npm install -g serve

COPY --from=builder /app/dist /app/dist

# Railway injects PORT — serve picks it up via ${PORT:-3000}
EXPOSE 3000
CMD serve -s /app/dist -l ${PORT:-3000}
