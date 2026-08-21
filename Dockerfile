# Build the client and compile the server, then ship only what runs.
FROM node:22-slim AS build
WORKDIR /app

# better-sqlite3 falls back to compiling from source when no prebuild matches.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY client/package.json client/
COPY server/package.json server/
RUN npm ci

COPY . .
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV MARKS_DATA_DIR=/data

COPY package.json package-lock.json ./
COPY client/package.json client/
COPY server/package.json server/
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/client/dist client/dist
COPY --from=build /app/server/dist server/dist

VOLUME /data
EXPOSE 3000
CMD ["node", "server/dist/index.js"]
