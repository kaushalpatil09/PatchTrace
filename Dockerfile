FROM node:22.23.3-bookworm-slim AS dependencies

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts
RUN mkdir -p node_modules

FROM node:22.23.3-bookworm-slim AS runtime

WORKDIR /app
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/* \
  && chown node:node /app

COPY --from=dependencies --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json package-lock.json server.mjs ./
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
  CMD node -e "fetch('http://127.0.0.1:4173/api/health').then(async r => { const body = await r.json(); process.exit(r.ok && body.status === 'ok' && body.ready === true ? 0 : 1); }).catch(() => process.exit(1))"

CMD ["node", "server.mjs"]
