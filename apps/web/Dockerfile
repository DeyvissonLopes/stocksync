FROM node:24.21.0-bookworm-slim

WORKDIR /app/apps/web
RUN npm install --global npm@11.19.1

COPY package.json package-lock.json .npmrc ./
RUN npm ci --include=dev

COPY index.html tsconfig.json vite.config.ts ./
COPY src src
RUN npm run check
RUN chown -R node:node /app/apps/web

EXPOSE 5173
USER node
CMD ["npm", "run", "dev"]
