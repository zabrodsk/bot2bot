FROM node:26-slim
WORKDIR /app
# Every server module (relay/*.mjs): the open-source relay, plus the hosted-*.mjs parts where they exist.
COPY package.json SETUP-FOR-BOTS.md README.md ./
COPY *.mjs ./
COPY cli ./cli
COPY skill ./skill
COPY setup-bot ./setup-bot
COPY public ./public
ENV NODE_ENV=production DB_PATH=/data/relay.db PORT=8080
EXPOSE 8080
CMD ["node", "server.mjs"]
