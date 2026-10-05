FROM node:24.21.0-bookworm-slim

WORKDIR /app/apps/api
RUN npm install --global npm@11.19.1

COPY package.json package-lock.json .npmrc ./
RUN npm ci --include=dev

COPY tsconfig*.json vitest.config.mjs eslint.config.mjs .nvmrc ./
COPY src src
COPY test test
RUN npm run build
RUN mkdir -p .test-build && chown -R node:node /app

ENV NODE_ENV=development PORT=3000 LISTEN_HOST=0.0.0.0
EXPOSE 3000
USER node
CMD ["node", "--env-file-if-exists=.env", "dist/main.js"]
