FROM node:26-slim
WORKDIR /app
COPY package.json server.mjs app.mjs connector.mjs governance.mjs events.mjs doorbells.mjs email.mjs i18n.mjs feedback-questions.mjs SETUP-FOR-BOTS.md README.md ./
COPY cli ./cli
COPY skill ./skill
COPY setup-bot ./setup-bot
COPY public ./public
ENV NODE_ENV=production DB_PATH=/data/relay.db PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]
