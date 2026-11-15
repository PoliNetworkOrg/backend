# The regulations editor's LaTeX compile worker (src/regulations/worker): a separate service, never the backend.
# Built FROM the legal repository's TeX Live image, so previews use the same packages as the official PDFs.
#   docker build -f docker/latex-worker.Dockerfile -t ghcr.io/polinetworkorg/latex-worker .
# Run it as in polinetwork-cd: non-root, read-only root, tmpfs on /work and /tmp, no network egress, CPU/memory limits.
# Give it a uid of its own (polinetwork-cd uses 10200), not one shared with other apps on the node: xelatex can read
# anything its uid can, and per-uid limits are node-wide. The image works under any uid (files are world-readable,
# the workdirs are emptyDirs).
ARG TEXLIVE_IMAGE=ghcr.io/polinetworkorg/legal-texlive:latest

FROM oven/bun:1-debian AS build
WORKDIR /build
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY tsconfig.base.json tsconfig.json ./
COPY src ./src
RUN bun build ./src/regulations/worker/server.ts --target bun --production --outfile /build/worker.js

FROM oven/bun:1-debian AS bun

FROM ${TEXLIVE_IMAGE}
USER root
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
COPY --from=build /build/worker.js /app/worker.js
# The root filesystem is read-only at runtime: build the fontconfig cache now.
RUN mkdir -p /work && chown 1000:1000 /work && fc-cache -f
USER 1000
ENV WORKER_PORT=4200 WORKER_WORK_DIR=/work WORKER_TMP_DIR=/tmp WORKER_CONCURRENCY=2 WORKER_TIMEOUT_MS=45000
EXPOSE 4200
ENTRYPOINT ["bun", "/app/worker.js"]
