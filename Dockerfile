# The hosted bot2bot image: the landing site (site/v2/simple) built to static files, served by the relay
# on the same domain as the dashboard. Self-hosters can keep using relay/Dockerfile, which has no site.
FROM node:26-slim AS site
WORKDIR /site
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 ASTRO_TELEMETRY_DISABLED=1
COPY site/v2/simple/package.json site/v2/simple/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY site/v2/simple/ ./
RUN npm run build

FROM node:26-slim
WORKDIR /app
COPY relay/package.json relay/server.mjs relay/app.mjs relay/connector.mjs relay/governance.mjs relay/events.mjs relay/doorbells.mjs relay/email.mjs relay/i18n.mjs relay/feedback-questions.mjs relay/SETUP-FOR-BOTS.md relay/README.md ./
COPY relay/cli ./cli
COPY relay/skill ./skill
COPY relay/setup-bot ./setup-bot
COPY relay/public ./public
COPY --from=site /site/dist ./site
ENV NODE_ENV=production DB_PATH=/data/relay.db PORT=8080 SITE_DIR=/app/site
EXPOSE 8080
CMD ["node", "server.mjs"]
