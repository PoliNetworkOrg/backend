FROM oven/bun:1-alpine AS base
WORKDIR /app

FROM base AS install
WORKDIR /build
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM base AS release
COPY --from=build /build/dist ./
USER bun
EXPOSE 3000
ENTRYPOINT ["bun", "run", "server.js"]
