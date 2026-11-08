# Strategic Conquest: servidor de partidas en línea + cliente.
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages ./packages
RUN npm ci && npm run build

FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
COPY --from=build /app/packages/server/dist/server.mjs packages/server/dist/server.mjs
COPY --from=build /app/packages/client/dist/play.html packages/client/dist/play.html
COPY --from=build /app/node_modules/ws node_modules/ws
VOLUME /data
EXPOSE 8080
CMD ["node", "packages/server/dist/server.mjs"]
