# syntax=docker/dockerfile:1.7
#
# Internal/Enterprise build:
#   - npm install routes through internal Nexus (via .npmrc)
#   - Optionally install internal Root CA (for HTTPS to Nexus / Iconify)
#   - PNG rendering 走 remote Chromium(browserless),image 內不含 chromium binary
#

# ─── Build stage ────────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS builder
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# OPTIONAL: internal Root CA(certs/.gitkeep 讓目錄存在但空即可)。
COPY certs/ /usr/local/share/ca-certificates/
RUN if ls /usr/local/share/ca-certificates/*.crt >/dev/null 2>&1; then \
      update-ca-certificates; \
    else \
      echo "No custom CA certs found, skipping"; \
    fi

COPY .npmrc* package.json package-lock.json* ./
# Playwright npm 仍要裝(API 用它的 client),但 chromium binary 走遠端,不需要下載。
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN npm install --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

RUN npm prune --omit=dev

# ─── Runtime stage ──────────────────────────────────────────────────────
FROM node:20-bookworm-slim AS runtime
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates wget \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /usr/local/share/ca-certificates/ /usr/local/share/ca-certificates/
RUN if ls /usr/local/share/ca-certificates/*.crt >/dev/null 2>&1; then \
      update-ca-certificates; \
    fi

ENV NODE_ENV=production \
    PORT=3000 \
    NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-certificates.crt \
    # Skip chromium auto-download at runtime too — we use remote browser.
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

RUN groupadd -g 1001 app && useradd -u 1001 -g app -s /sbin/nologin -d /app app

COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/dist ./dist
COPY --from=builder --chown=app:app /app/package.json ./

USER app
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
  CMD wget -q -O - http://localhost:3000/healthz || exit 1

CMD ["node", "--enable-source-maps", "dist/server.js"]
