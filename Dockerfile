FROM node:22.23.3-bookworm-slim

WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY --chown=node:node server.mjs ./
COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node fixtures ./fixtures
COPY --chown=node:node scripts ./scripts
COPY --chown=node:node bin ./bin

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4173
ENV PATCHTRACE_ENABLE_VERIFY=0

USER node
EXPOSE 4173

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4173/api/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "server.mjs"]
