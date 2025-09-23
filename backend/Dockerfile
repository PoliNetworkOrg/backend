FROM node:24-slim AS base
COPY . /app
WORKDIR /app
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
RUN pnpm run build
EXPOSE 3000
CMD ["sh","-c", "pnpm run db:migrate && pnpm run start"]
